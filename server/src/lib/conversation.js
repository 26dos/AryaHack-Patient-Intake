// Conversation / LLM engine for the AI voice intake agent (PRD Sections 6 & 10).
//
// Scope: conversation stage machine + Gemini tool-calling loop + guardrail wiring ONLY.
// This module has NO side effects beyond in-memory per-call conversation state (stage, consent
// status, chat history). It does not touch Twilio, TTS, or Supabase — the caller (Twilio webhook
// layer) is responsible for turning `toolCalls` into Supabase writes via something like
// `upsertField(callSid, fieldKey, value, state)`, and for feeding `replyText` to TTS.
//
// ---------------------------------------------------------------------------------------------
// TOOL-CALL ARGUMENT SHAPE (read this before wiring the Supabase side) --------------------------
// ---------------------------------------------------------------------------------------------
// One Gemini function per FIELD_GROUPS entry (e.g. `record_identity`, `record_insurance`, ...),
// plus two control tools: `confirm_appointment` and `end_interview`.
//
// For a field-group tool, each field `<key>` in that group's `fields` array has TWO optional
// argument slots:
//   - `<key>`        : the captured value (string). Present + non-null  => state defaults to
//                        'captured' if `<key>_state` is omitted.
//   - `<key>_state`   : one of FIELD_STATES ('captured' | 'patient_declined' | 'unable_to_capture').
//                        The model is instructed to send this explicitly whenever the patient
//                        declines or an answer stays unclear after one re-ask, in which case
//                        `<key>` itself should be omitted or null.
//
// The model only includes keys for fields it actually has new information about this turn — a
// tool call may partially fill a group (e.g. `record_medical_history({ medications: '...',
// medications_state: 'captured' })` now, `allergies` in a later call once mentioned).
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
      consentGiven: false,
      consentRetries: 0,
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
// Yes/no keyword classification (used for the consent gate and greeting confirmation).
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
// Field-state helpers (used to compute what's still missing so we can steer the LLM and to
// deterministically detect completion, on top of whatever the LLM decides).
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

function missingRequiredFields(snapshot) {
  return REQUIRED_P0_FIELD_KEYS.filter((key) => !FIELD_STATES.includes(getFieldState(snapshot, key)));
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
        : `Captured value for ${field}. Omit this key (and set ${field}_state instead) if the patient declined or the answer was unclear.`,
    };
    properties[`${field}_state`] = {
      type: SchemaType.STRING,
      enum: FIELD_STATES,
      description:
        `State of ${field}: 'captured' (value provided), 'patient_declined' (patient declined to answer), ` +
        `or 'unable_to_capture' (still unclear after one re-ask). Defaults to 'captured' if omitted and ${field} has a value.`,
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
        'Call once all required intake fields have been captured, declined, or marked unable_to_capture, ' +
        'and the patient has nothing more to add. This ends the interview.',
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

function describeMissing(missingKeys) {
  if (missingKeys.length === 0) return 'None — all required fields are resolved.';
  return missingKeys.join(', ');
}

function buildSystemInstruction({ missingKeys, adviceFlagThisTurn }) {
  return [
    'You are a warm, human-sounding pre-appointment intake assistant for a medical office, speaking with a patient over the phone.',
    'You are NOT a clinician. Persona: friendly data-collection assistant, never a diagnostician.',
    '',
    'Conversation style:',
    '- Sound like a caring human, not a robocall reading a form. Use natural, brief sentences suited for text-to-speech.',
    '- Let the patient describe their chief complaint and medical history in their own words; use the record_* tools to extract structured data rather than forcing multiple-choice answers.',
    '- Confirm-back pattern: for anything safety-relevant (medications, allergies), briefly repeat back what you heard before moving on, to catch mis-transcription.',
    "- Graceful decline handling: if the patient says \"I don't know\" or declines a question, call the matching tool with the field's state set to 'patient_declined' (or 'unable_to_capture' if just unclear) and move on. Never press twice on the same field, never dead-end, never loop.",
    '- Only ask one or two things per turn, do not interrogate with a long list of questions at once.',
    '- Every time the patient gives you new information (even if unprompted / out of order, e.g. they volunteer insurance info before you asked), call the appropriate record_* tool immediately.',
    '',
    'Hard guardrails (never violate these):',
    `- You must NEVER diagnose, triage, or give medical/clinical advice, treatment suggestions, or medication recommendations of any kind. If the patient asks something clinical (e.g. "what do you think this is", "should I be worried", "what should I take for this"), you must refuse using EXACTLY this sentence, verbatim, then continue with intake: "${EXACT_REFUSAL_LINE}"`,
    "- Emergencies are handled by a separate hard-coded system before your turn even runs — you do not need to detect them, but if a patient's message still sounds like an active emergency, gently urge them to hang up and call 911 rather than continuing the interview.",
    '- Never leave a required field silently blank — always resolve it to captured, patient_declined, or unable_to_capture.',
    '',
    `Fields still missing (steer the conversation to naturally fill these, in whatever order fits): ${describeMissing(missingKeys)}`,
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
    const apptPhrase = appt ? ` about your upcoming appointment ${appt}` : ' about an upcoming appointment';
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
        session.stage = 'consent';
        return {
          replyText: `Thank you, that matches our records. ${CONSENT_SCRIPT}`,
          toolCalls: [],
          consentGiven: false,
          stage: 'consent',
          emergencyDetected: false,
          endCall: false,
          verifiedDateOfBirth: patientContext.dateOfBirth,
          useTts: false,
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
    session.stage = 'consent';
    return {
      // A short warm bridge, then the verbatim consent script (PRD Section 6 — the disclosure
      // itself must play verbatim, so the warmth goes before it, not woven into it).
      replyText: `Great, thank you! ${CONSENT_SCRIPT}`,
      toolCalls: [],
      consentGiven: false,
      stage: 'consent',
      emergencyDetected: false,
      endCall: false,
      useTts: false,
    };
  }

  // ---- Stage: consent (hard gate — no medical tool calls until this returns true) ----
  if (session.stage === 'consent') {
    const verdict = classifyYesNo(text);

    if (verdict === 'affirm') {
      session.consentGiven = true;
      session.stage = 'interview';
      return {
        replyText:
          "Great, thank you. Let's get started — I just need to grab a few details so your doctor has everything ready for your visit. To begin, what's the main reason for your visit?",
        toolCalls: [],
        consentGiven: true,
        stage: 'interview',
        emergencyDetected: false,
        endCall: false,
        useTts: false,
      };
    }

    if (session.consentRetries === 0) {
      session.consentRetries += 1;
      return {
        replyText:
          "No problem — just to confirm, is it okay if I continue and note a few details for your visit? You can say yes to continue, or no if you'd rather not.",
        toolCalls: [],
        consentGiven: false,
        stage: 'consent',
        emergencyDetected: false,
        endCall: false,
        useTts: false,
      };
    }

    // Declined (or still ambiguous) after one re-ask: cannot collect medical info. End gracefully.
    session.consentGiven = false;
    session.stage = 'done';
    return {
      replyText:
        "That's okay, we won't collect any medical details today. Thank you for your time, and we'll see you at your appointment. Goodbye.",
      toolCalls: [],
      consentGiven: false,
      stage: 'done',
      emergencyDetected: false,
      endCall: true,
      callStatus: 'consent_declined',
      useTts: false,
    };
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
  const missingBefore = missingRequiredFields(capturedFieldsSnapshot);
  const adviceFlagThisTurn = looksLikeClinicalAdviceRequest(text);
  const systemInstruction = buildSystemInstruction({ missingKeys: missingBefore, adviceFlagThisTurn });

  const { toolCalls: rawToolCalls, replyText: modelReply } = await sendInterviewTurn(
    session,
    text || "(the patient hasn't said anything yet — greet them and ask about the reason for their visit)",
    systemInstruction,
  );

  // Defensive consent gate: interview stage structurally requires consentGiven === true already,
  // but per the hard requirement that the STATE MACHINE (not the LLM) gates medical tool calls,
  // strip any field-group tool calls here too if consent somehow isn't logged.
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
  const missingAfter = missingRequiredFields(projected);

  let stage = 'interview';
  let endCall = false;
  if (calledEndInterview || missingAfter.length === 0) {
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
