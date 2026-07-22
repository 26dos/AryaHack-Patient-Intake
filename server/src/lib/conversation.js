// Conversation / LLM engine for the AI voice intake agent (PRD Sections 6 & 10).
//
// Scope: conversation stage machine + Gemini tool-calling loop + guardrail wiring ONLY.
// This module has NO side effects beyond in-memory per-call conversation state (stage, disclosure
// status, chat history). It does not touch Twilio, TTS, or Supabase — the caller (Twilio webhook
// layer) is responsible for turning `toolCalls` into Supabase writes via something like
// `upsertField(callSid, fieldKey, value, state)`, and for feeding `replyText` to TTS.
//
// ---------------------------------------------------------------------------------------------
// TOOL-CALL ARGUMENT SHAPE (read this before wiring the Supabase side) --------------------------
// ---------------------------------------------------------------------------------------------
// One Gemini function per FIELD_GROUPS entry (e.g. `record_identity_verification`,
// `record_visit_reason_update`, ...), plus two control tools: `confirm_appointment` and
// `end_interview`.
//
// For a field-group tool, each field `<key>` in that group's `fields` array has TWO optional
// argument slots:
//   - `<key>`        : the captured/verified/updated value (string). Present + non-null  => state
//                        defaults to 'captured' if `<key>_state` is omitted.
//   - `<key>_state`   : one of FIELD_STATES. The model is instructed to send this explicitly for
//                        verified preloaded data, patient updates, declined answers, not-applicable
//                        answers, or anything that stays unclear after one re-ask.
//
// The model only includes keys for fields it actually has new information about this turn — a
// tool call may partially fill a group (e.g. `record_medication_update({
// current_medications: '...', current_medications_state: 'verified' })` now,
// `medication_changes` in a later call once mentioned).
//
// Recommended Supabase-side mapping (one field at a time, per the PRD's upsertField contract):
//   for (const call of toolCalls) {
//     const group = FIELD_GROUPS.find(g => g.tool === call.tool);
//     if (!group) continue; // confirm_appointment / end_interview handled separately
//     for (const key of group.fields) {
//       if (!(key in call.args) && !(`${key}_state` in call.args)) continue; // untouched this turn
//       const value = call.args[key] ?? null;
//       const state = call.args[`${key}_state`] || (value != null ? 'captured' : 'unable_to_capture');
//       await upsertField(callSid, key, value, state);
//     }
//   }
//
// `confirm_appointment` args: `{ confirmed: boolean }`.
// `end_interview` args: `{ reason?: string }` — informational only; the engine already reflects
// this in `stage`/`endCall`, the caller doesn't need to do anything special with it besides maybe
// logging `reason`.
// ---------------------------------------------------------------------------------------------

import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { config } from '../config.js';
import {
  FIELD_GROUPS,
  FIELD_STATES,
  REQUIRED_P0_FIELD_KEYS,
  CHIEF_COMPLAINT_CATEGORIES,
  EMERGENCY_KEYWORDS_MESSAGE,
  CONSENT_SCRIPT,
} from './intakeSchema.js';
import { checkEmergency, looksLikeClinicalAdviceRequest } from './guardrails.js';
import { dobToDigits } from './demoPatients.js';

// ---------------------------------------------------------------------------------------------
// Gemini client + model fallback
// ---------------------------------------------------------------------------------------------

const genAI = new GoogleGenerativeAI(config.gemini.apiKey);

// Model name fallback list. 'gemini-2.0-flash', 'gemini-1.5-flash', and 'gemini-1.5-pro' all 404
// against this project's API key (confirmed live, not a transient issue — this key is scoped to
// a newer model generation) and were previously kept at the end of this list "just in case."
// That's actively harmful: on a real call, a transient hiccup on the primary model burned through
// three guaranteed-404 candidates before failing, and that extra latency is a likely cause of a
// live demo call getting cut off with Twilio's own generic error message instead of our graceful
// fallback line. Only candidates confirmed working against this key belong here.
export const MODEL_CANDIDATES = [
  'gemini-flash-latest',
  'gemini-3-flash-preview',
];

let cachedModelName = null;

// Twilio's TwiML webhook has a hard ~15s response deadline — without this, a stalled Gemini
// call (no timeout by default) hangs the whole turn past that deadline and Twilio kills the
// call with its own generic "An application error has occurred" message instead of our
// graceful fallback line. Bounding each candidate's call lets safeVoiceHandler's catch block
// produce that fallback instead.
const GEMINI_REQUEST_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------------------------
// In-memory per-call session state (Map keyed by callSid). No persistence — that's Supabase's job
// in another module.
// ---------------------------------------------------------------------------------------------

const sessions = new Map();

function getSession(callSid) {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      stage: 'greeting',
      greetingSent: false,
      greetingRetries: 0,
      dobRetries: 0,
      dobVerified: false,
      appointmentRetries: 0,
      appointmentVerified: false,
      consentGiven: false,
      history: [], // Gemini Content[] used to reconstruct the interview chat each turn
    });
  }
  return sessions.get(callSid);
}

// Exposed for tests / callers that want to reset state between simulated calls.
export function resetSession(callSid) {
  sessions.delete(callSid);
}

// ---------------------------------------------------------------------------------------------
// Yes/no keyword classification (used for greeting confirmation).
// Deliberately simple/keyword-based per task guidance: "keep it simple and reliable over clever."
// ---------------------------------------------------------------------------------------------

const AFFIRM_PHRASES = [
  'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'of course', 'correct',
  "that's right", 'that is right', 'affirmative', 'go ahead', 'please do', 'sounds good',
  'continue', 'fine by me',
  // Common idioms that contain the literal word "no" but mean agreement — must be checked
  // before the bare 'no' decline phrase or these get misclassified as a decline.
  'no problem', 'no worries', 'not a problem',
];

const DECLINE_PHRASES = [
  'no', 'nope', 'nah', "don't", 'do not', "i'd rather not", 'i would rather not',
  'not really', 'incorrect', "that's wrong", 'no thanks', 'no thank you', 'stop',
  "i don't want", 'rather not',
];

function containsPhrase(text, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i');
  return re.test(` ${text} `);
}

// Idioms containing the literal word "no" that unambiguously mean agreement — checked first so
// they short-circuit before the bare 'no' decline phrase gets a chance to misfire.
const AFFIRM_IDIOM_OVERRIDES = ['no problem', 'no worries', 'not a problem'];

function classifyYesNo(text) {
  if (!text || !text.trim()) return 'unclear';
  if (AFFIRM_IDIOM_OVERRIDES.some((p) => containsPhrase(text, p))) return 'affirm';
  const hasAffirm = AFFIRM_PHRASES.some((p) => containsPhrase(text, p));
  const hasDecline = DECLINE_PHRASES.some((p) => containsPhrase(text, p));
  if (hasDecline && !hasAffirm) return 'decline';
  if (hasAffirm && !hasDecline) return 'affirm';
  return 'unclear';
}

// ---------------------------------------------------------------------------------------------
// Field-state helpers (used to compute which verification/update tasks remain so we can steer the
// LLM and deterministically detect completion, on top of whatever the LLM decides).
// ---------------------------------------------------------------------------------------------

// capturedFieldsSnapshot entries may be either `{ value, state }` (matching intakeSchema's JSONB
// shape) or a bare scalar (treated as `captured` if non-null/non-empty). Missing keys are simply
// absent.
function getFieldState(snapshot, key) {
  if (!snapshot || !(key in snapshot)) return undefined;
  const entry = snapshot[key];
  if (entry && typeof entry === 'object' && 'state' in entry) return entry.state;
  if (entry !== undefined && entry !== null && entry !== '') return 'captured';
  return undefined;
}

// Projects this turn's tool calls on top of the caller-provided snapshot so we can tell, within
// the SAME turn, whether the interview just became complete (rather than waiting for the caller
// to persist to Supabase and pass a fresh snapshot on the next turn).
function projectSnapshot(snapshot, toolCalls) {
  const merged = { ...(snapshot || {}) };
  for (const call of toolCalls) {
    const group = FIELD_GROUPS.find((g) => g.tool === call.tool);
    if (!group) continue;
    for (const key of group.fields) {
      const hasValue = Object.prototype.hasOwnProperty.call(call.args || {}, key);
      const hasState = Object.prototype.hasOwnProperty.call(call.args || {}, `${key}_state`);
      if (!hasValue && !hasState) continue;
      const value = call.args[key] ?? null;
      const state = call.args[`${key}_state`] || (value != null ? 'captured' : 'unable_to_capture');
      merged[key] = { value, state };
    }
  }
  return merged;
}

function fieldValue(snapshot, key) {
  const entry = snapshot?.[key];
  if (entry && typeof entry === 'object' && 'value' in entry) return entry.value;
  return entry;
}

const FINAL_CALL_RESOLUTION_STATES = new Set([
  'verified',
  'updated',
  'captured',
  'patient_declined',
  'unable_to_capture',
  'not_applicable',
]);

const GROUP_BY_FIELD = new Map();
for (const group of FIELD_GROUPS) {
  for (const field of group.fields) {
    GROUP_BY_FIELD.set(field, group.group);
  }
}

const FIELD_LABELS = {
  date_of_birth: 'date of birth',
  appointment_datetime: 'appointment date and time',
  clinic_name: 'clinic',
  specialist_name: 'specialist',
  appointment_type: 'appointment type',
  patient_stated_reason: 'patient-stated reason',
  chief_complaint_category: 'reason category',
  onset_duration: 'onset or duration',
  changes_since_booking: 'what changed since booking',
  visit_goal: 'visit goal',
  current_medications: 'current medications',
  medication_changes: 'medication additions or removals',
  medication_unknowns: 'medication unknowns',
  known_allergies: 'known allergies',
  new_allergies: 'new allergies',
  allergy_reactions: 'allergy reactions',
  relevant_conditions: 'visit-relevant conditions',
  relevant_procedures: 'visit-relevant procedures',
  relevant_events: 'visit-relevant events',
  insurance_payer_name: 'insurance payer',
  insurance_member_id: 'insurance member ID',
  insurance_group_number: 'insurance group number',
  preferred_contact_method: 'preferred contact method',
  preferred_language: 'preferred language',
};

const PATIENT_CONTEXT_FIELD_MAP = {
  full_name: 'fullName',
  date_of_birth: 'dateOfBirth',
  phone_number: 'phoneNumber',
  appointment_datetime: 'appointmentDatetime',
  clinic_name: 'clinicName',
  specialist_name: 'specialistName',
  appointment_type: 'appointmentType',
  booking_reason: 'bookingReason',
  referral_note: 'referralNote',
  referring_provider_name: 'referringProviderName',
  insurance_payer_name: 'insurancePayerName',
  insurance_member_id: 'insuranceMemberId',
  insurance_group_number: 'insuranceGroupNumber',
  preferred_contact_method: 'preferredContactMethod',
  preferred_language: 'preferredLanguage',
  current_medications: 'knownMedications',
  known_allergies: 'knownAllergies',
  relevant_conditions: 'relevantConditions',
};

function isBlank(value) {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function normalizeContextValue(value) {
  if (Array.isArray(value)) return value.filter((item) => !isBlank(item)).join('; ');
  return value;
}

function fieldLabel(key) {
  return FIELD_LABELS[key] || key.replace(/_/g, ' ');
}

function contextFieldValue(snapshot, patientContext, key) {
  const snapshotValue = fieldValue(snapshot, key);
  if (!isBlank(snapshotValue)) return normalizeContextValue(snapshotValue);

  const preloadedValue = patientContext?.preloadedIntakeFields?.[key]?.value;
  if (!isBlank(preloadedValue)) return normalizeContextValue(preloadedValue);

  const patientContextKey = PATIENT_CONTEXT_FIELD_MAP[key];
  if (!patientContextKey) return undefined;
  return normalizeContextValue(patientContext?.[patientContextKey]);
}

function contextFieldState(snapshot, patientContext, key) {
  const snapshotState = getFieldState(snapshot, key);
  if (snapshotState) return snapshotState;
  const preloadedState = patientContext?.preloadedIntakeFields?.[key]?.state;
  if (preloadedState) return preloadedState;
  return isBlank(contextFieldValue(snapshot, patientContext, key)) ? undefined : 'preloaded';
}

function contextFieldEntry(snapshot, patientContext, key) {
  const snapshotEntry = snapshot?.[key];
  if (snapshotEntry && typeof snapshotEntry === 'object' && 'state' in snapshotEntry) {
    return snapshotEntry;
  }
  const preloadedEntry = patientContext?.preloadedIntakeFields?.[key];
  if (preloadedEntry) return preloadedEntry;

  const value = contextFieldValue(snapshot, patientContext, key);
  if (isBlank(value)) return null;
  const needsConfirmationReason = patientContext?.needsConfirmation?.[key];
  const lastConfirmedAt = patientContext?.lastConfirmedAt?.[key];
  return {
    value,
    state: 'preloaded',
    ...(lastConfirmedAt ? { lastConfirmedAt } : {}),
    ...(needsConfirmationReason
      ? { needsConfirmation: true, needsConfirmationReason }
      : { needsConfirmation: false }),
  };
}

function fieldNeedsConfirmation(snapshot, patientContext, key) {
  const entry = contextFieldEntry(snapshot, patientContext, key);
  return Boolean(entry?.needsConfirmation || patientContext?.needsConfirmation?.[key]);
}

function fieldNeedsConfirmationReason(snapshot, patientContext, key) {
  const entry = contextFieldEntry(snapshot, patientContext, key);
  return entry?.needsConfirmationReason || patientContext?.needsConfirmation?.[key] || '';
}

function hasPreloadedOrCapturedValue(snapshot, patientContext, key) {
  return !isBlank(contextFieldValue(snapshot, patientContext, key));
}

function isFinalResolved(snapshot, key) {
  return FINAL_CALL_RESOLUTION_STATES.has(getFieldState(snapshot, key));
}

function shouldAskConditionalAdminField(snapshot, patientContext, key) {
  if (isFinalResolved(snapshot, key)) return false;
  if (fieldNeedsConfirmation(snapshot, patientContext, key)) return true;
  return !hasPreloadedOrCapturedValue(snapshot, patientContext, key);
}

function shouldAskRequiredField(snapshot, patientContext, key) {
  if (isFinalResolved(snapshot, key)) return false;

  const group = GROUP_BY_FIELD.get(key);
  if (group === 'conditional_admin_update') {
    return shouldAskConditionalAdminField(snapshot, patientContext, key);
  }

  // Identity, appointment, medication, allergy, visit-reason, and visit-relevant history groups
  // all require a call resolution. Preloaded values are referenced back for verification or update,
  // not recollected as blank fields.
  return true;
}

function pendingRequiredFields(snapshot, patientContext) {
  const pending = [];
  for (const group of FIELD_GROUPS) {
    if (!group.required) continue;
    for (const key of group.fields) {
      if (shouldAskRequiredField(snapshot, patientContext, key)) pending.push(key);
    }
  }
  return pending;
}

function describeFields(keys) {
  if (!keys.length) return 'None.';
  return keys.map((key) => fieldLabel(key)).join(', ');
}

function describePending(pendingKeys) {
  if (pendingKeys.length === 0) return 'None — all required conversation tasks are resolved.';
  const byGroup = FIELD_GROUPS
    .filter((group) => group.required)
    .map((group) => {
      const groupKeys = group.fields.filter((key) => pendingKeys.includes(key));
      if (!groupKeys.length) return null;
      return `${group.group}: ${describeFields(groupKeys)}`;
    })
    .filter(Boolean);
  return byGroup.join(' | ');
}

function describeDoNotAskFields(snapshot, patientContext, pendingKeys) {
  const pending = new Set(pendingKeys);
  const alreadyHandled = REQUIRED_P0_FIELD_KEYS.filter((key) => {
    if (pending.has(key)) return false;
    return hasPreloadedOrCapturedValue(snapshot, patientContext, key) || getFieldState(snapshot, key);
  });
  return describeFields(alreadyHandled);
}

function describeContextLines(snapshot, patientContext) {
  const groups = [
    ['Identity context', ['full_name', 'date_of_birth', 'phone_number']],
    ['Appointment context', ['appointment_datetime', 'clinic_name', 'specialist_name', 'appointment_type']],
    ['Known visit context', ['booking_reason', 'referring_provider_name']],
    ['Existing clinical context', ['current_medications', 'known_allergies', 'relevant_conditions']],
    ['Existing admin context', ['insurance_payer_name', 'insurance_member_id', 'insurance_group_number', 'preferred_contact_method', 'preferred_language']],
  ];

  const lines = [];
  for (const [label, keys] of groups) {
    const parts = [];
    for (const key of keys) {
      const value = contextFieldValue(snapshot, patientContext, key);
      if (isBlank(value)) continue;
      const state = contextFieldState(snapshot, patientContext, key);
      const reason = fieldNeedsConfirmationReason(snapshot, patientContext, key);
      parts.push(`${fieldLabel(key)}: ${value}${state ? ` [${state}]` : ''}${reason ? ` (needs update: ${reason})` : ''}`);
    }
    if (parts.length) lines.push(`${label}: ${parts.join('; ')}`);
  }

  const referralNote = contextFieldValue(snapshot, patientContext, 'referral_note');
  if (!isBlank(referralNote)) {
    lines.push(`Internal referral context, do not read verbatim unless the patient raises it: ${referralNote}`);
  }

  return lines.length ? lines.join('\n') : 'No preloaded clinic context was provided.';
}

// ---------------------------------------------------------------------------------------------
// Gemini tool/function-calling schema, built from FIELD_GROUPS (single source of truth).
// ---------------------------------------------------------------------------------------------

function buildFieldProperties(fields) {
  const properties = {};
  for (const field of fields) {
    const isCategory = field === 'chief_complaint_category';
    properties[field] = {
      type: SchemaType.STRING,
      ...(isCategory ? { enum: CHIEF_COMPLAINT_CATEGORIES } : {}),
      description: isCategory
        ? 'Closest matching structured category for the chief complaint.'
        : `Value for ${field}. For preloaded information, repeat the clinic value only when the patient verifies it, or send the updated value when they correct it.`,
    };
    properties[`${field}_state`] = {
      type: SchemaType.STRING,
      enum: FIELD_STATES,
      description:
        `State of ${field}. Use 'verified' when the patient confirms preloaded data is still correct, ` +
        "'updated' when they change preloaded data, 'captured' for new information, " +
        "'not_applicable' when the field does not apply to this visit, 'patient_declined' when they decline, " +
        `or 'unable_to_capture' when still unclear after one re-ask. Defaults to 'captured' if omitted and ${field} has a value.`,
    };
  }
  return properties;
}

function buildFunctionDeclarations() {
  const fieldGroupTools = FIELD_GROUPS.map((group) => ({
    name: group.tool,
    description:
      `Record ${group.group.replace(/_/g, ' ')} information the patient has just provided or declined. ` +
      `${group.required ? 'This is a required P0 field group.' : 'This is an optional (nice-to-have) field group.'} ` +
      'Call with only the field(s) addressed this turn; call it again later if more fields in this group come up.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: buildFieldProperties(group.fields),
    },
  }));

  return [
    ...fieldGroupTools,
    {
      name: 'confirm_appointment',
      description: "Record whether the patient confirmed their upcoming appointment date/time is correct.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: { confirmed: { type: SchemaType.BOOLEAN } },
        required: ['confirmed'],
      },
    },
    {
      name: 'end_interview',
      description:
        'Call once all required intake fields have been verified, updated, captured, declined, marked ' +
        'unable_to_capture, or marked not_applicable, and the patient has nothing more to add. This ends the interview.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: { reason: { type: SchemaType.STRING } },
      },
    },
  ];
}

const FUNCTION_DECLARATIONS = buildFunctionDeclarations();

// ---------------------------------------------------------------------------------------------
// System prompt (PRD Section 6 conversational UX + Section 10 guardrails)
// ---------------------------------------------------------------------------------------------

const EXACT_REFUSAL_LINE = "I can't advise on that, your doctor will review this with you at your visit.";

function buildSystemInstruction({
  pendingKeys,
  capturedFieldsSnapshot,
  patientContext,
  adviceFlagThisTurn,
}) {
  return [
    'You are a warm, human-sounding pre-appointment intake assistant for a medical office, speaking with a patient over the phone.',
    'You are NOT a clinician. Persona: friendly data-collection assistant, never a diagnostician.',
    '',
    'Preloaded clinic context and current field states:',
    describeContextLines(capturedFieldsSnapshot, patientContext),
    '',
    `Required topics still needing call resolution: ${describePending(pendingKeys)}`,
    `Do not ask again about resolved, declined, unable, not-applicable, or preloaded-not-stale fields: ${describeDoNotAskFields(capturedFieldsSnapshot, patientContext, pendingKeys)}`,
    '',
    'Ask-update rules:',
    '- Identity and appointment/specialist context must be verified before medical intake. If appointment details are already verified by the stage machine, do not repeat them.',
    '- For visit reason, do not merely restate the booking reason. Reference it briefly if present, then ask what changed since booking, the patient-stated reason in their own words, onset/duration when relevant, and the goal for the specialist visit.',
    "- For medications, read back the medication list on file if present and ask what has been added, stopped, changed, or is unknown. If the patient says there are no changes, call record_medication_update with current_medications_state='verified', medication_changes_state='not_applicable', and medication_unknowns_state='not_applicable'.",
    "- For allergies, read back the allergy list on file if present and ask whether there are new allergies or reaction updates. If there are no changes, call record_allergy_update with known_allergies_state='verified', new_allergies_state='not_applicable', and allergy_reactions_state='not_applicable'.",
    '- Use a confirm-back before moving on from medications or allergies: briefly repeat the final medication/allergy update you heard in the same spoken reply.',
    "- Relevant history means only conditions, procedures, or events related to this visit reason or referral context. Do not collect a broad medical history. If no relevant history applies, use 'not_applicable' for the relevant history fields.",
    '- Ask insurance/contact/admin updates only when the field is listed as pending because it is missing, stale, or specifically needs confirmation. If admin info is preloaded and not pending, do not mention it.',
    "- When a patient corrects preloaded information, use state 'updated'. When they confirm preloaded information is still accurate, use state 'verified'. Use 'captured' only for new information that was not already in the clinic context.",
    '- Optional P1 groups should only be recorded if the patient volunteers them or all P0 work is done and the conversation naturally allows it.',
    '- Never recollect a field that is already resolved, preloaded and not pending, verified, updated, captured, patient_declined, unable_to_capture, or not_applicable.',
    '',
    'Conversation style:',
    '- Sound like a caring human, not a robocall reading a form. Use natural, brief sentences suited for text-to-speech.',
    '- Let the patient describe the visit reason and relevant history in their own words; use the record_* tools to extract structured data rather than forcing multiple-choice answers.',
    "- Graceful decline handling: if the patient says \"I don't know\" or declines a question, call the matching tool with the field's state set to 'patient_declined' (or 'unable_to_capture' if just unclear after one re-ask) and move on. Never press twice on the same field, never dead-end, never loop.",
    '- Only ask one or two things per turn, do not interrogate with a long list of questions at once.',
    '- Every time the patient gives you new information (even if unprompted / out of order, e.g. they volunteer insurance info before you asked), call the appropriate record_* tool immediately.',
    '',
    'Hard guardrails (never violate these):',
    `- You must NEVER diagnose, triage, or give medical/clinical advice, treatment suggestions, or medication recommendations of any kind. If the patient asks something clinical (e.g. "what do you think this is", "should I be worried", "what should I take for this"), you must refuse using EXACTLY this sentence, verbatim, then continue with intake: "${EXACT_REFUSAL_LINE}"`,
    "- Emergencies are handled by a separate hard-coded system before your turn even runs — you do not need to detect them, but if a patient's message still sounds like an active emergency, gently urge them to hang up and call 911 rather than continuing the interview.",
    '- Never leave a required field silently blank — always resolve it to verified, updated, captured, patient_declined, unable_to_capture, or not_applicable.',
    '',
    adviceFlagThisTurn
      ? `IMPORTANT: The patient's latest message looks like it may be asking you for a diagnosis or medical advice. You MUST use the exact refusal line above before continuing.`
      : '',
    '',
    'When every required field is resolved and the patient has nothing more to add, call end_interview with a short reason, and say a brief warm goodbye.',
    'Always produce a short spoken reply for every turn, in addition to any tool calls.',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------------------------
// Gemini call with model-name fallback (tries MODEL_CANDIDATES in order, caches the first that works)
// ---------------------------------------------------------------------------------------------

const RETRY_BACKOFF_MS = 500;

// 503 (overloaded) and 429 (rate limited) are Google-side and often clear within under a second —
// worth one same-model retry before burning a whole fallback slot on them. Anything else (4xx
// config/schema errors, etc.) won't be fixed by retrying, so fail straight to the next candidate.
function isRetryableStatus(err) {
  return err && (err.status === 503 || err.status === 429);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendInterviewTurn(session, transcript, systemInstruction) {
  const candidates = cachedModelName
    ? [cachedModelName, ...MODEL_CANDIDATES.filter((m) => m !== cachedModelName)]
    : MODEL_CANDIDATES;

  let lastErr;
  for (const modelName of candidates) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const model = genAI.getGenerativeModel(
          {
            model: modelName,
            systemInstruction,
            tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
          },
          { timeout: GEMINI_REQUEST_TIMEOUT_MS }
        );
        const chat = model.startChat({ history: session.history || [] });
        const result = await chat.sendMessage(transcript);

        let response = result.response;
        let toolCalls = (response.functionCalls() || []).map((fc) => ({ tool: fc.name, args: fc.args || {} }));
        let replyText = (response.text() || '').trim();

        // Demo reliability: do not spend a second Gemini round trip just to get spoken text after
        // function calls. The caller has a fallback reply, and this avoids blowing Twilio's webhook
        // response window when Gemini is slow.

        cachedModelName = modelName;
        session.history = await chat.getHistory();
        return { toolCalls, replyText, modelName };
      } catch (err) {
        lastErr = err;
        if (attempt === 0 && isRetryableStatus(err)) {
          await sleep(RETRY_BACKOFF_MS);
          continue;
        }
        break;
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------------------------
// Greeting / consent templating
// ---------------------------------------------------------------------------------------------

function buildGreeting(capturedFieldsSnapshot, patientContext) {
  if (patientContext?.fullName) {
    const appt = patientContext.appointmentDatetime || capturedFieldsSnapshot?.appointment_datetime;
    const specialist = patientContext.specialistName ? ` with ${patientContext.specialistName}` : '';
    const apptPhrase = appt ? ` about your upcoming appointment ${appt}${specialist}` : ' about an upcoming appointment';
    return `Hi, this is Riverside Cardiology calling for ${patientContext.fullName}${apptPhrase}. To protect your privacy, please enter the patient's eight digit date of birth using your keypad. For example, January second, nineteen eighty would be zero one zero two one nine eight zero.`;
  }

  const name = fieldValue(capturedFieldsSnapshot, 'full_name');
  // `appointment_datetime` is NOT part of ALL_FIELD_KEYS / the intake schema contract — it's an
  // optional convenience key the caller may pass in capturedFieldsSnapshot (e.g. looked up from
  // the appointment record before dialing) purely so the greeting can reference it. If absent we
  // degrade gracefully and ask the patient to state it.
  const apptDateTime = capturedFieldsSnapshot?.appointment_datetime;

  if (name && apptDateTime) {
    return `Hi! Hope you're having a good day. This is your doctor's office calling ahead of your upcoming visit on ${apptDateTime} — am I speaking with ${name}?`;
  }
  if (name) {
    return `Hi! Hope you're doing well today. This is your doctor's office calling ahead of your upcoming appointment. Am I speaking with ${name}, and can you confirm the date and time of your visit?`;
  }
  return "Hi there! Hope you're having a good day. This is your doctor's office calling ahead of your upcoming appointment. Could I get your name, and can you confirm the date and time of your visit?";
}

function buildIdentityVerificationToolCalls(patientContext) {
  if (!patientContext?.dateOfBirth) return [];
  return [
    {
      tool: 'record_identity_verification',
      args: {
        date_of_birth: patientContext.dateOfBirth,
        date_of_birth_state: 'verified',
      },
    },
  ];
}

function appointmentFieldArgsForState(capturedFieldsSnapshot, patientContext, state) {
  const args = {};
  const group = FIELD_GROUPS.find((item) => item.group === 'appointment_verification');
  for (const key of group?.fields || []) {
    if (state === 'verified' || state === 'updated') {
      const value = contextFieldValue(capturedFieldsSnapshot, patientContext, key);
      if (!isBlank(value)) args[key] = value;
    }
    args[`${key}_state`] = state;
  }
  return args;
}

function buildAppointmentToolCalls(capturedFieldsSnapshot, patientContext, state) {
  const args = appointmentFieldArgsForState(capturedFieldsSnapshot, patientContext, state);
  if (Object.keys(args).length === 0) return [];
  return [
    {
      tool: 'record_appointment_verification',
      args,
    },
    {
      tool: 'confirm_appointment',
      args: { confirmed: state === 'verified' || state === 'updated' },
    },
  ];
}

function buildAppointmentPhrase(capturedFieldsSnapshot, patientContext) {
  const datetime = contextFieldValue(capturedFieldsSnapshot, patientContext, 'appointment_datetime');
  const clinic = contextFieldValue(capturedFieldsSnapshot, patientContext, 'clinic_name');
  const specialist = contextFieldValue(capturedFieldsSnapshot, patientContext, 'specialist_name');
  const appointmentType = contextFieldValue(capturedFieldsSnapshot, patientContext, 'appointment_type');

  const parts = [];
  if (!isBlank(appointmentType)) parts.push(`a ${appointmentType}`);
  if (!isBlank(datetime)) parts.push(datetime);
  if (!isBlank(specialist) && !isBlank(clinic)) {
    parts.push(`with ${specialist} at ${clinic}`);
  } else if (!isBlank(specialist)) {
    parts.push(`with ${specialist}`);
  } else if (!isBlank(clinic)) {
    parts.push(`at ${clinic}`);
  }

  return parts.join(' ');
}

function buildAppointmentVerificationQuestion(capturedFieldsSnapshot, patientContext) {
  const appointmentPhrase = buildAppointmentPhrase(capturedFieldsSnapshot, patientContext);
  if (!appointmentPhrase) return '';
  return `Before we talk about any medical details, I have you scheduled for ${appointmentPhrase}. Is that correct?`;
}

function buildVisitReasonQuestion(capturedFieldsSnapshot, patientContext) {
  const bookingReason = contextFieldValue(capturedFieldsSnapshot, patientContext, 'booking_reason');
  const specialist = contextFieldValue(capturedFieldsSnapshot, patientContext, 'specialist_name') || 'the specialist';
  if (!isBlank(bookingReason)) {
    return `The booking note says ${bookingReason}. In your own words, what has changed since booking, and what would you like ${specialist} to focus on at the visit?`;
  }
  return `In your own words, what is the main reason for this visit, and what would you like ${specialist} to focus on?`;
}

function beginInterview(session, capturedFieldsSnapshot, patientContext, prefix = '', toolCalls = []) {
  session.stage = 'interview';
  const bridge = prefix ? `${prefix} ` : '';
  return {
    replyText: `${bridge}${buildVisitReasonQuestion(capturedFieldsSnapshot, patientContext)}`,
    toolCalls,
    consentGiven: session.consentGiven,
    stage: 'interview',
    emergencyDetected: false,
    endCall: false,
    useTts: false,
  };
}

function beginVerificationAfterDisclosure(
  session,
  capturedFieldsSnapshot,
  patientContext,
  prefix = '',
  toolCalls = [],
) {
  session.consentGiven = true;
  const bridge = prefix ? `${prefix} ` : '';
  const appointmentQuestion = buildAppointmentVerificationQuestion(capturedFieldsSnapshot, patientContext);
  if (appointmentQuestion) {
    session.stage = 'appointment_verification';
    return {
      replyText: `${bridge}${CONSENT_SCRIPT} ${appointmentQuestion}`,
      toolCalls,
      consentGiven: true,
      stage: 'appointment_verification',
      emergencyDetected: false,
      endCall: false,
      useTts: false,
    };
  }

  session.stage = 'interview';
  return {
    replyText:
      `${bridge}${CONSENT_SCRIPT} ` +
      'Before we talk about any medical details, please confirm the appointment date and time, clinic or specialist, and visit type so I know I am preparing the right chart.',
    toolCalls,
    consentGiven: true,
    stage: 'interview',
    emergencyDetected: false,
    endCall: false,
    useTts: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------------------------

/**
 * @param {{ callSid: string, transcript: string|null, capturedFieldsSnapshot: object }} args
 * @returns {Promise<{replyText: string, toolCalls: Array<{tool: string, args: object}>, consentGiven: boolean, stage: string, emergencyDetected: boolean, endCall: boolean}>}
 */
export async function runTurn({ callSid, transcript, capturedFieldsSnapshot = {} }) {
  return runTurnWithContext({ callSid, transcript, capturedFieldsSnapshot });
}

/**
 * @param {{ callSid: string, transcript?: string|null, digits?: string|null, capturedFieldsSnapshot?: object, patientContext?: object|null }} args
 */
export async function runTurnWithContext({
  callSid,
  transcript,
  digits = null,
  capturedFieldsSnapshot = {},
  patientContext = null,
}) {
  const session = getSession(callSid);
  const text = (transcript || '').trim();
  const digitText = String(digits || '').replace(/\D/g, '');

  // ---- Hard-coded emergency pre-check, runs before anything reaches Gemini (PRD Section 10). ----
  if (text && checkEmergency(text)) {
    return {
      replyText: EMERGENCY_KEYWORDS_MESSAGE,
      toolCalls: [],
      consentGiven: session.consentGiven,
      stage: session.stage,
      emergencyDetected: true,
      endCall: false, // let the caller decide whether to hang up; the patient may still respond
    };
  }

  // ---- Stage: greeting ----
  if (session.stage === 'greeting') {
    if (!session.greetingSent) {
      session.greetingSent = true;
      return {
        replyText: buildGreeting(capturedFieldsSnapshot, patientContext),
        toolCalls: [],
        consentGiven: false,
        stage: 'greeting',
        emergencyDetected: false,
        endCall: false,
        inputMode: patientContext?.dateOfBirth ? 'dtmf' : 'speech',
        numDigits: patientContext?.dateOfBirth ? 8 : undefined,
        useTts: false,
      };
    }

    if (patientContext?.dateOfBirth && !session.dobVerified) {
      const expectedDob = dobToDigits(patientContext.dateOfBirth);
      if (digitText && digitText === expectedDob) {
        session.dobVerified = true;
        return {
          ...beginVerificationAfterDisclosure(
            session,
            capturedFieldsSnapshot,
            patientContext,
            'Thank you, that matches our records.',
            buildIdentityVerificationToolCalls(patientContext),
          ),
          verifiedDateOfBirth: patientContext.dateOfBirth,
        };
      }

      if (session.dobRetries === 0) {
        session.dobRetries += 1;
        return {
          replyText:
            "Sorry, that didn't match our records. Please try once more: enter the patient's eight digit date of birth using your keypad.",
          toolCalls: [],
          consentGiven: false,
          stage: 'greeting',
          emergencyDetected: false,
          endCall: false,
          inputMode: 'dtmf',
          numDigits: 8,
          useTts: false,
        };
      }

      session.stage = 'done';
      return {
        replyText:
          "I'm sorry, I couldn't verify the date of birth, so I can't continue this intake call. Please contact the office directly. Goodbye.",
        toolCalls: [],
        consentGiven: false,
        stage: 'verification_failed',
        emergencyDetected: false,
        endCall: true,
        callStatus: 'verification_failed',
        useTts: false,
      };
    }

    // This turn's transcript is the patient's reply to the greeting/identity confirmation.
    const verdict = classifyYesNo(text);
    if (verdict === 'decline' && session.greetingRetries === 0) {
      session.greetingRetries += 1;
      return {
        replyText: "Sorry about that — could you confirm your name and the date and time of your appointment?",
        toolCalls: [],
        consentGiven: false,
        stage: 'greeting',
        emergencyDetected: false,
        endCall: false,
        useTts: false,
      };
    }
    // Affirm, unclear, or a second decline: proceed rather than dead-ending (no infinite retry).
    return beginVerificationAfterDisclosure(
      session,
      capturedFieldsSnapshot,
      patientContext,
      'Great, thank you!',
    );
  }

  // ---- Stage: appointment_verification ----
  if (session.stage === 'appointment_verification') {
    const verdict = classifyYesNo(text);
    if (verdict === 'affirm') {
      session.appointmentVerified = true;
      return beginInterview(
        session,
        capturedFieldsSnapshot,
        patientContext,
        'Thanks, that confirms the appointment.',
        buildAppointmentToolCalls(capturedFieldsSnapshot, patientContext, 'verified'),
      );
    }

    if (verdict === 'decline' && session.appointmentRetries === 0) {
      session.appointmentRetries += 1;
      return {
        replyText:
          'Thanks for catching that. What should I update about the date, time, clinic, specialist, or appointment type?',
        toolCalls: [],
        consentGiven: session.consentGiven,
        stage: 'appointment_verification',
        emergencyDetected: false,
        endCall: false,
        useTts: false,
      };
    }

    if (session.appointmentRetries === 0) {
      session.appointmentRetries += 1;
      return {
        replyText:
          'Could you confirm whether the appointment date, clinic, specialist, and visit type I read are correct?',
        toolCalls: [],
        consentGiven: session.consentGiven,
        stage: 'appointment_verification',
        emergencyDetected: false,
        endCall: false,
        useTts: false,
      };
    }

    session.appointmentVerified = false;
    return beginInterview(
      session,
      capturedFieldsSnapshot,
      patientContext,
      "Thanks. I'll flag the appointment details for the office to review.",
      buildAppointmentToolCalls(capturedFieldsSnapshot, patientContext, 'unable_to_capture'),
    );
  }

  // ---- Stage: wrapup (deterministic close — one turn after completion was detected) ----
  if (session.stage === 'wrapup') {
    session.stage = 'done';
    return {
      replyText: "Perfect, that's everything I need. Thank you so much — your doctor will have this ready before your visit. Take care, goodbye!",
      toolCalls: [],
      consentGiven: session.consentGiven,
      stage: 'done',
      emergencyDetected: false,
      endCall: true,
      useTts: false,
    };
  }

  // ---- Stage: done ----
  if (session.stage === 'done') {
    return {
      replyText: '',
      toolCalls: [],
      consentGiven: session.consentGiven,
      stage: 'done',
      emergencyDetected: false,
      endCall: true,
    };
  }

  // ---- Stage: interview (main LLM tool-calling loop) ----
  const pendingBefore = pendingRequiredFields(capturedFieldsSnapshot, patientContext);
  const adviceFlagThisTurn = looksLikeClinicalAdviceRequest(text);
  const systemInstruction = buildSystemInstruction({
    pendingKeys: pendingBefore,
    capturedFieldsSnapshot,
    patientContext,
    adviceFlagThisTurn,
  });

  const { toolCalls: rawToolCalls, replyText: modelReply } = await sendInterviewTurn(
    session,
    text || "(the patient hasn't said anything yet — greet them and ask about the reason for their visit)",
    systemInstruction,
  );

  // Defensive disclosure invariant: interview should only be reachable after the disclosure has
  // been played and continuation consent has been logged. If state ever drifts, suppress intake
  // writes rather than persisting medical details without that marker.
  let toolCalls = rawToolCalls;
  if (!session.consentGiven) {
    toolCalls = toolCalls.filter((tc) => tc.tool === 'confirm_appointment' || tc.tool === 'end_interview');
  }

  let replyText = modelReply;
  // Backstop for the clinical-advice guardrail: the system prompt is the primary defense: if the
  // question looked clinical but the model's reply doesn't read like the required refusal, force it.
  if (adviceFlagThisTurn && !/can't advise|cannot advise|review this with you/i.test(replyText)) {
    replyText = `${EXACT_REFUSAL_LINE} ${replyText}`.trim();
  }
  if (!replyText) {
    replyText = "Got it, thank you. Could you tell me a bit more?";
  }

  const calledEndInterview = toolCalls.some((tc) => tc.tool === 'end_interview');
  const projected = projectSnapshot(capturedFieldsSnapshot, toolCalls);
  const pendingAfter = pendingRequiredFields(projected, patientContext);

  if (calledEndInterview && pendingAfter.length > 0) {
    toolCalls = toolCalls.filter((tc) => tc.tool !== 'end_interview');
  }

  let stage = 'interview';
  let endCall = false;
  if (pendingAfter.length === 0) {
    stage = 'wrapup';
  }
  session.stage = stage;

  return {
    replyText,
    toolCalls,
    consentGiven: session.consentGiven,
    stage,
    emergencyDetected: false,
    endCall,
  };
}
