import express from 'express';
import twilio from 'twilio';
import { config } from '../config.js';
import { runTurnWithContext } from '../lib/conversation.js';
import { upsertRecord, upsertField, logEvent, getRecord } from '../lib/supabase.js';
import { synthesizeAndStore } from '../lib/tts.js';
import { sendSms } from '../twilioClient.js';
import { sendConfirmationEmail } from '../lib/email.js';
import { FIELD_GROUPS, FIELD_STATES, EMERGENCY_KEYWORDS_MESSAGE, ALL_FIELD_KEYS } from '../lib/intakeSchema.js';
import { getDemoPatient, getDemoPatientByPhone } from '../lib/demoPatients.js';

const router = express.Router();
const { VoiceResponse } = twilio.twiml;

const TOOL_TO_GROUP = Object.fromEntries(FIELD_GROUPS.map((g) => [g.tool, g]));
const FIELD_STATE_SET = new Set(FIELD_STATES);
const TOOL_ALIASES = {
  record_identity: 'record_identity_verification',
  record_appointment: 'record_appointment_verification',
  record_visit_reason: 'record_visit_reason_update',
  record_medications: 'record_medication_update',
  record_allergies: 'record_allergy_update',
  record_medical_history: 'record_relevant_history_update',
  record_admin: 'record_conditional_admin_update',
  record_insurance: 'record_conditional_admin_update',
  record_patient_concerns: 'record_patient_questions',
};
const CONSENT_REQUIRED_GROUPS = new Set(
  FIELD_GROUPS
    .filter((g) => !['identity_verification', 'appointment_verification'].includes(g.group))
    .map((g) => g.tool)
);
const APPOINTMENT_VERIFICATION_FIELDS =
  FIELD_GROUPS.find((g) => g.group === 'appointment_verification')?.fields || [];
const noiseRetries = new Map();
const TERMINAL_NON_SUMMARY_STATUSES = new Set([
  'voicemail',
  'dropped',
  'verification_failed',
  'consent_declined',
  'emergency_escalated',
]);
const SUMMARY_FIELD_ORDER = [
  'full_name',
  'date_of_birth',
  'phone_number',
  'appointment_datetime',
  'clinic_name',
  'specialist_name',
  'appointment_type',
  'booking_reason',
  ...ALL_FIELD_KEYS,
];
const PATIENT_SUMMARY_EXCLUDED_FIELDS = new Set(['referral_note', 'referring_provider_name']);
const FIELD_LABELS = {
  full_name: 'Name',
  date_of_birth: 'Date of birth',
  phone_number: 'Phone',
  appointment_datetime: 'Appointment',
  clinic_name: 'Clinic',
  specialist_name: 'Specialist',
  appointment_type: 'Appointment type',
  booking_reason: 'Booking reason',
  patient_stated_reason: 'Reason for visit',
  chief_complaint_category: 'Visit category',
  onset_duration: 'Onset/duration',
  changes_since_booking: 'Changes since booking',
  visit_goal: 'Visit goal',
  current_medications: 'Current medications',
  medication_changes: 'Medication changes',
  medication_unknowns: 'Medication unknowns',
  known_allergies: 'Known allergies',
  new_allergies: 'New allergies',
  allergy_reactions: 'Allergy reactions',
  relevant_conditions: 'Relevant conditions',
  relevant_procedures: 'Relevant procedures',
  relevant_events: 'Relevant events',
  insurance_payer_name: 'Insurance payer',
  insurance_member_id: 'Insurance member ID',
  insurance_group_number: 'Insurance group number',
  preferred_contact_method: 'Preferred contact method',
  preferred_language: 'Preferred language',
  patient_questions: 'Questions for specialist',
  emergency_contact_name: 'Emergency contact',
  emergency_contact_relationship: 'Emergency contact relationship',
  emergency_contact_phone: 'Emergency contact phone',
  smoking_alcohol: 'Smoking/alcohol',
  occupation: 'Occupation',
  specialty_specific_social_history: 'Specialty-specific social history',
};
const SUMMARY_STATE_LABELS = {
  preloaded: 'on file before call',
  verified: 'verified from information on file',
  updated: 'updated during call',
  captured: 'provided during call',
  patient_declined: 'declined during call',
  unable_to_capture: 'needs office follow-up',
  not_applicable: 'not applicable',
};
const SUMMARY_SECTIONS = [
  { title: 'New or updated during this call', states: new Set(['updated', 'captured']) },
  { title: 'Verified or already on file', states: new Set(['verified', 'preloaded']) },
  { title: 'Needs office follow-up', states: new Set(['patient_declined', 'unable_to_capture']) },
  { title: 'Not applicable', states: new Set(['not_applicable']) },
];

// Express 4 does NOT catch rejected promises thrown inside async route handlers — an unhandled
// rejection there crashes the whole process (verified: a Supabase error mid-call took down the
// entire server, dashboard and all in-progress calls included). Every route below is wrapped in
// this so a single bad turn degrades to a graceful hangup instead of killing the server.
function safeVoiceHandler(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[voice] handler error on ${req.path}:`, err);
      const callSid = req.body?.CallSid;
      if (callSid) {
        try {
          await logEvent(callSid, 'handler_error', { path: req.path, error: String(err) });
        } catch (logErr) {
          console.error('[voice] failed to log handler_error:', logErr);
        }
      }
      const twiml = new VoiceResponse();
      twiml.say(
        { voice: 'Polly.Joanna' },
        "I'm sorry, I'm having a technical issue on my end. We'll follow up with you shortly. Thank you for your patience."
      );
      twiml.hangup();
      res.type('text/xml').send(twiml.toString());
    }
  };
}

// Appends a spoken line to any TwiML node (root VoiceResponse or a nested <Gather>) — both expose the
// same .play()/.say() API in the Twilio Node SDK. Falls back to <Say> if ElevenLabs synthesis fails.
async function appendSpeech(node, text, { useTts = true } = {}) {
  const audioPath = useTts ? await synthesizeAndStore(text) : null;
  if (audioPath) {
    node.play(`${config.publicBaseUrl}${audioPath}`);
  } else {
    node.say({ voice: 'Polly.Joanna' }, text);
  }
}

function patientFromRequest(req, phoneNumber) {
  return getDemoPatient(req.query?.patientId) || getDemoPatientByPhone(phoneNumber);
}

function routePath(path, patient) {
  if (!patient?.id) return path;
  return `${path}?patientId=${encodeURIComponent(patient.id)}`;
}

function buildGather(twiml, result, patient) {
  if (result.inputMode === 'dtmf') {
    return twiml.gather({
      input: 'dtmf',
      action: routePath('/voice/gather', patient),
      method: 'POST',
      numDigits: result.numDigits || 8,
      timeout: result.timeoutSeconds || 7,
    });
  }

  return twiml.gather({
    input: 'speech',
    action: routePath('/voice/gather', patient),
    method: 'POST',
    speechTimeout: String(result.speechTimeoutSeconds || 2),
    timeout: result.timeoutSeconds || 5,
    speechModel: 'phone_call',
    actionOnEmptyResult: true,
  });
}

function isLikelyNoise(speechResult, confidence) {
  const text = (speechResult || '').trim();
  if (!text) return true;
  const compact = text.replace(/[^a-z0-9]/gi, '');
  if (compact.length < 2) return true;
  const numericConfidence = Number(confidence);
  if (Number.isFinite(numericConfidence) && numericConfidence > 0 && numericConfidence < 0.35) {
    return true;
  }
  return false;
}

function hasProvidedValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function valueFromFieldEntry(entry) {
  if (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'value')) {
    return entry.value;
  }
  return entry;
}

function seededPreloadedContext(patient, phoneNumber) {
  const context = { ...(patient?.preloadedContext || {}) };
  const identity = { ...(context.patient_identity || {}) };
  if (!identity.phone_number && phoneNumber) identity.phone_number = phoneNumber;
  if (Object.keys(identity).length > 0) context.patient_identity = identity;
  return context;
}

function findInPreloadedContext(context, fieldKey) {
  for (const groupValue of Object.values(context || {})) {
    if (!groupValue || typeof groupValue !== 'object') continue;
    if (Object.prototype.hasOwnProperty.call(groupValue, fieldKey)) {
      return groupValue[fieldKey];
    }
  }
  return undefined;
}

function fieldValueFromRecordOrPatient(record, patient, fieldKey) {
  const recordFieldValue = valueFromFieldEntry(record?.fields?.[fieldKey]);
  if (hasProvidedValue(recordFieldValue)) return recordFieldValue;

  const patientFieldValue = valueFromFieldEntry(patient?.preloadedIntakeFields?.[fieldKey]);
  if (hasProvidedValue(patientFieldValue)) return patientFieldValue;

  const recordContextValue = findInPreloadedContext(record?.preloaded_context, fieldKey);
  if (hasProvidedValue(recordContextValue)) return recordContextValue;

  const patientContextValue = findInPreloadedContext(patient?.preloadedContext, fieldKey);
  if (hasProvidedValue(patientContextValue)) return patientContextValue;

  if (fieldKey === 'appointment_datetime') return record?.appointment_datetime || patient?.appointmentDatetime;
  if (fieldKey === 'phone_number') return record?.phone_number || patient?.phoneNumber;
  return undefined;
}

function normalizeToolName(toolName) {
  return TOOL_ALIASES[toolName] || toolName;
}

function valuesMatchForVerification(expected, actual) {
  if (!hasProvidedValue(expected) || !hasProvidedValue(actual)) return false;
  return String(expected).trim().toLowerCase() === String(actual).trim().toLowerCase();
}

function defaultStateForField(group, fieldKey, value, record, patient) {
  if (!hasProvidedValue(value)) return 'unable_to_capture';
  if (group.group === 'identity_verification') {
    const expected = fieldValueFromRecordOrPatient(record, patient, fieldKey);
    return valuesMatchForVerification(expected, value) ? 'verified' : 'captured';
  }
  if (group.group === 'appointment_verification') {
    const expected = fieldValueFromRecordOrPatient(record, patient, fieldKey);
    return valuesMatchForVerification(expected, value) ? 'verified' : 'updated';
  }
  if (group.group.endsWith('_update')) return 'updated';
  return 'captured';
}

function normalizeFieldState(rawState, value, group, fieldKey, record, patient) {
  if (rawState && FIELD_STATE_SET.has(rawState)) {
    if (rawState === 'verified' && group.group === 'identity_verification') {
      const expected = fieldValueFromRecordOrPatient(record, patient, fieldKey);
      const valueToVerify = hasProvidedValue(value) ? value : expected;
      return valuesMatchForVerification(expected, valueToVerify) ? 'verified' : 'captured';
    }
    return rawState;
  }
  return defaultStateForField(group, fieldKey, value, record, patient);
}

function orderedSummaryKeys(fields = {}) {
  return Array.from(new Set([...SUMMARY_FIELD_ORDER, ...Object.keys(fields)])).filter((key) =>
    Object.prototype.hasOwnProperty.call(fields, key)
  );
}

function labelForField(key) {
  return FIELD_LABELS[key] || key.replace(/_/g, ' ');
}

function formatSummaryValue(value) {
  if (Array.isArray(value)) return value.filter(hasProvidedValue).join('; ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value ?? '').trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function buildNoiseRetryTwiml(callSid, patient) {
  const count = (noiseRetries.get(callSid) || 0) + 1;
  noiseRetries.set(callSid, count);

  const twiml = new VoiceResponse();
  if (count <= 1) {
    const gather = buildGather(twiml, { inputMode: 'speech', speechTimeoutSeconds: 1, timeoutSeconds: 5 }, patient);
    await appendSpeech(gather, "Sorry, I didn't catch that clearly. Could you say that once more?", { useTts: false });
    twiml.redirect({ method: 'POST' }, routePath('/voice/gather-fallback-2', patient));
  } else {
    await appendSpeech(
      twiml,
      "I'm still having trouble hearing you clearly, so I'll stop this call for now. The office can follow up with you.",
      { useTts: false },
    );
    twiml.hangup();
    await upsertRecord(callSid, { call_status: 'dropped' });
  }

  return twiml;
}

async function seedDemoPatient(callSid, patient, phoneNumber) {
  if (!patient) return;
  const seededPhoneNumber = patient.phoneNumber || phoneNumber;
  const preloadedContext = seededPreloadedContext(patient, seededPhoneNumber);
  await upsertRecord(callSid, {
    phone_number: seededPhoneNumber,
    appointment_datetime: patient.appointmentDatetime,
    preloaded_context: preloadedContext,
  });

  const preloadedFields = { ...(patient.preloadedIntakeFields || {}) };
  if (seededPhoneNumber) {
    preloadedFields.phone_number = {
      ...(preloadedFields.phone_number || {}),
      value: seededPhoneNumber,
      state: preloadedFields.phone_number?.state || 'preloaded',
    };
  }

  const seededFieldKeys = [];
  for (const [fieldKey, entry] of Object.entries(preloadedFields)) {
    const value = valueFromFieldEntry(entry);
    if (!hasProvidedValue(value)) continue;
    const state = FIELD_STATE_SET.has(entry?.state) ? entry.state : 'preloaded';
    await upsertField(callSid, fieldKey, value, state);
    seededFieldKeys.push(fieldKey);
  }

  await logEvent(callSid, 'demo_patient_seeded', {
    patientId: patient.id,
    preloadedFieldKeys: seededFieldKeys,
  });
}

async function applyToolCalls(callSid, toolCalls = [], { record = null, patient = null, consentLogged = false } = {}) {
  for (const call of toolCalls) {
    try {
      const toolName = normalizeToolName(call.tool);
      if (toolName === 'confirm_appointment') {
        await upsertRecord(callSid, { appointment_confirmed: !!call.args?.confirmed });
        if (call.args?.confirmed) {
          for (const field of APPOINTMENT_VERIFICATION_FIELDS) {
            const value = fieldValueFromRecordOrPatient(record, patient, field);
            if (hasProvidedValue(value)) {
              await upsertField(callSid, field, value, 'verified');
            }
          }
        }
        continue;
      }
      if (toolName === 'end_interview') {
        await logEvent(callSid, 'end_interview', call.args);
        continue;
      }
      const group = TOOL_TO_GROUP[toolName];
      if (!group) {
        await logEvent(callSid, 'unknown_tool_call', call);
        continue;
      }
      if (CONSENT_REQUIRED_GROUPS.has(group.tool) && !consentLogged) {
        await logEvent(callSid, 'tool_call_suppressed_before_consent', call);
        continue;
      }
      for (const field of group.fields) {
        const args = call.args || {};
        if (!(field in args) && !(`${field}_state` in args)) continue; // untouched this turn
        const hasValue = Object.prototype.hasOwnProperty.call(args, field);
        const rawValue = hasValue ? args[field] : null;
        const rawState = args[`${field}_state`];
        if (rawState && !FIELD_STATE_SET.has(rawState)) {
          await logEvent(callSid, 'invalid_field_state', { tool: call.tool, field, state: rawState });
        }
        const state = normalizeFieldState(rawState, rawValue, group, field, record, patient);
        const value =
          !hasValue && ['preloaded', 'verified'].includes(state)
            ? fieldValueFromRecordOrPatient(record, patient, field) ?? null
            : rawValue;
        await upsertField(callSid, field, value, state);
      }
    } catch (err) {
      console.error('applyToolCalls error', call, err);
      await logEvent(callSid, 'tool_call_error', { call: JSON.stringify(call), error: String(err) });
    }
  }
}

async function buildTurnTwiml({ callSid, transcript, digits, patient }) {
  const record = await getRecord(callSid);
  const resolvedPatient = patient || getDemoPatientByPhone(record?.phone_number);
  const capturedFieldsSnapshot = { ...(record?.fields || {}) };
  if (record?.appointment_datetime && !capturedFieldsSnapshot.appointment_datetime) {
    capturedFieldsSnapshot.appointment_datetime = { value: record.appointment_datetime, state: 'preloaded' };
  }

  const result = await runTurnWithContext({
    callSid,
    transcript,
    digits,
    capturedFieldsSnapshot,
    patientContext: resolvedPatient,
  });
  const twiml = new VoiceResponse();

  if (result.emergencyDetected) {
    await logEvent(callSid, 'emergency_flag', { transcript });
    await upsertRecord(callSid, { call_status: 'emergency_escalated' });
    await appendSpeech(twiml, EMERGENCY_KEYWORDS_MESSAGE);
    twiml.hangup();
    return twiml;
  }

  let consentLoggedForWrites = record?.consent_given === true;
  if (result.consentGiven === true && !consentLoggedForWrites) {
    const consentLoggedAt = new Date().toISOString();
    await upsertRecord(callSid, {
      consent_given: true,
      consent_logged_at: consentLoggedAt,
    });
    await logEvent(callSid, 'consent_logged', { consent_logged_at: consentLoggedAt, stage: result.stage });
    consentLoggedForWrites = true;
  } else if (result.consentGiven === false && result.callStatus === 'consent_declined') {
    await upsertRecord(callSid, {
      consent_given: false,
      consent_logged_at: null,
      call_status: 'consent_declined',
    });
    await logEvent(callSid, 'consent_declined', { stage: result.stage });
  }

  if (result.verifiedDateOfBirth) {
    await upsertField(callSid, 'date_of_birth', result.verifiedDateOfBirth, 'verified');
    if (resolvedPatient?.fullName) {
      await upsertField(callSid, 'full_name', resolvedPatient.fullName, 'verified');
    }
  }
  await applyToolCalls(callSid, result.toolCalls, {
    record,
    patient: resolvedPatient,
    consentLogged: consentLoggedForWrites,
  });
  await logEvent(callSid, 'turn', { transcript, reply: result.replyText, stage: result.stage });

  if (result.endCall) {
    await appendSpeech(twiml, result.replyText, { useTts: result.useTts !== false });
    twiml.hangup();
    await upsertRecord(callSid, { call_status: result.callStatus || 'completed' });
    return twiml;
  }

  const gather = buildGather(twiml, result, resolvedPatient);
  await appendSpeech(gather, result.replyText, { useTts: result.useTts !== false });
  twiml.redirect({ method: 'POST' }, routePath('/voice/gather-fallback', resolvedPatient));

  return twiml;
}

router.post('/voice/incoming', safeVoiceHandler(async (req, res) => {
  const callSid = req.body.CallSid;
  const answeredBy = req.body.AnsweredBy;
  // For outbound-api calls, From is OUR Twilio number and To is the patient — the reverse of
  // inbound calls. Pick whichever side is actually the patient so SMS confirmations (and the
  // dashboard) never end up with our own number.
  const direction = req.body.Direction || '';
  const patientNumber = direction.startsWith('outbound') ? req.body.To : req.body.From;
  const patient = patientFromRequest(req, patientNumber);

  await upsertRecord(callSid, { phone_number: patientNumber, call_status: 'in_progress' });
  await seedDemoPatient(callSid, patient, patientNumber);
  await logEvent(callSid, 'call_started', { patientNumber, direction, answeredBy });

  if (answeredBy && answeredBy.startsWith('machine')) {
    const twiml = new VoiceResponse();
    await appendSpeech(
      twiml,
      "Hi, this is Riverside Cardiology calling to complete your pre-visit intake. Please call us back at your convenience so we can get your chart ready before your appointment. Thank you!",
      { useTts: false },
    );
    twiml.hangup();
    await upsertRecord(callSid, { call_status: 'voicemail' });
    res.type('text/xml').send(twiml.toString());
    return;
  }

  const twiml = await buildTurnTwiml({ callSid, transcript: null, patient });
  res.type('text/xml').send(twiml.toString());
}));

router.post('/voice/gather', safeVoiceHandler(async (req, res) => {
  const callSid = req.body.CallSid;
  const record = await getRecord(callSid);
  const patient = patientFromRequest(req, record?.phone_number);
  const digits = req.body.Digits || '';
  const speechResult = req.body.SpeechResult || '';
  await logEvent(callSid, 'speech_result', { speechResult, confidence: req.body.Confidence });

  if (!digits && isLikelyNoise(speechResult, req.body.Confidence)) {
    await logEvent(callSid, 'speech_noise_ignored', { speechResult, confidence: req.body.Confidence });
    const twiml = await buildNoiseRetryTwiml(callSid, patient);
    res.type('text/xml').send(twiml.toString());
    return;
  }

  noiseRetries.delete(callSid);
  const twiml = await buildTurnTwiml({ callSid, transcript: speechResult, digits, patient });
  res.type('text/xml').send(twiml.toString());
}));

router.post('/voice/gather-fallback', safeVoiceHandler(async (req, res) => {
  const callSid = req.body.CallSid;
  const record = callSid ? await getRecord(callSid) : null;
  const patient = patientFromRequest(req, record?.phone_number);
  const twiml = new VoiceResponse();
  const gather = buildGather(twiml, { inputMode: 'speech', speechTimeoutSeconds: 1, timeoutSeconds: 5 }, patient);
  await appendSpeech(gather, "Sorry, I didn't catch that — could you say that again?", { useTts: false });
  twiml.redirect({ method: 'POST' }, routePath('/voice/gather-fallback-2', patient));
  res.type('text/xml').send(twiml.toString());
}));

router.post('/voice/gather-fallback-2', safeVoiceHandler(async (req, res) => {
  const callSid = req.body.CallSid;
  const twiml = new VoiceResponse();
  await appendSpeech(
    twiml,
    "It looks like I'm having trouble hearing you, so I'll let you go for now. We'll follow up by text. Take care!",
    { useTts: false },
  );
  twiml.hangup();
  await upsertRecord(callSid, { call_status: 'dropped' });
  res.type('text/xml').send(twiml.toString());
}));

router.post('/voice/amd', safeVoiceHandler(async (req, res) => {
  const callSid = req.body.CallSid;
  const answeredBy = req.body.AnsweredBy || req.body.AnsweredByResult;
  await logEvent(callSid, 'async_amd_result', { answeredBy });
  if (answeredBy && String(answeredBy).startsWith('machine')) {
    const record = await getRecord(callSid);
    if (record && record.call_status === 'in_progress') {
      await upsertRecord(callSid, { call_status: 'voicemail' });
    }
  }
  res.sendStatus(200);
}));

function buildIntakeSummaryItems(record) {
  const fields = record.fields || {};
  const items = [];
  for (const key of orderedSummaryKeys(fields)) {
    if (PATIENT_SUMMARY_EXCLUDED_FIELDS.has(key)) continue;
    const f = fields[key];
    if (!f || !FIELD_STATE_SET.has(f.state)) continue;
    const value = formatSummaryValue(f.value);
    const stateLabel = SUMMARY_STATE_LABELS[f.state] || f.state.replace(/_/g, ' ');

    if (['preloaded', 'verified', 'updated', 'captured'].includes(f.state)) {
      if (!hasProvidedValue(value)) continue;
      items.push({
        key,
        state: f.state,
        line: `${labelForField(key)}: ${value} (${stateLabel})`,
      });
    } else {
      items.push({
        key,
        state: f.state,
        line: `${labelForField(key)}: ${stateLabel}`,
      });
    }
  }
  return items;
}

function buildIntakeSummarySections(record) {
  const items = buildIntakeSummaryItems(record);
  return SUMMARY_SECTIONS
    .map((section) => ({
      title: section.title,
      lines: items.filter((item) => section.states.has(item.state)).map((item) => item.line),
    }))
    .filter((section) => section.lines.length > 0);
}

function buildSmsSummary(record) {
  const sections = buildIntakeSummarySections(record);
  const lines = ['Thanks for completing your pre-visit intake with Arya Health. Summary:'];
  if (sections.length === 0) {
    lines.push('- No intake details were recorded.');
  } else {
    for (const section of sections) {
      lines.push(`${section.title}:`);
      lines.push(...section.lines.map((line) => `- ${line}`));
    }
  }
  lines.push('If anything looks wrong, call us back before your visit.');
  return lines.join('\n');
}

function buildEmailSummary(record) {
  const sections = buildIntakeSummarySections(record);
  const text = [
    'Thanks for completing your pre-visit intake with Arya Health!',
    '',
    'Summary of what was captured, updated, verified, or already on file:',
    ...(sections.length
      ? sections.flatMap((section) => ['', `${section.title}:`, ...section.lines.map((line) => `- ${line}`)])
      : ['', '- No intake details were recorded.']),
    '',
    'If anything looks wrong, call us back before your visit.',
  ].join('\n');
  const html = `
    <p>Thanks for completing your pre-visit intake with Arya Health!</p>
    <p><strong>Summary of what was captured, updated, verified, or already on file:</strong></p>
    ${
      sections.length
        ? sections
            .map(
              (section) =>
                `<h3>${escapeHtml(section.title)}</h3><ul>${section.lines
                  .map((line) => `<li>${escapeHtml(line)}</li>`)
                  .join('')}</ul>`
            )
            .join('')
        : '<ul><li>No intake details were recorded.</li></ul>'
    }
    <p>If anything looks wrong, call us back before your visit.</p>
  `;
  return { text, html };
}

router.post('/voice/status', async (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;

  try {
    await logEvent(callSid, 'call_status', { callStatus });
    if (callStatus === 'completed') {
      const record = await getRecord(callSid);
      if (record && record.call_status === 'in_progress') {
        await upsertRecord(callSid, { call_status: 'completed' });
      }
      const finalRecord = await getRecord(callSid);
      if (!finalRecord || finalRecord.call_status !== 'completed' || TERMINAL_NON_SUMMARY_STATUSES.has(finalRecord.call_status)) {
        res.sendStatus(200);
        return;
      }
      // SMS is best-effort: this Twilio account's numbers are blocked from delivering SMS by
      // carrier-level A2P 10DLC / toll-free compliance (errors 30034/30032), which requires
      // business registration that takes hours-to-days — not something an API call can fix. We
      // still attempt it (free if it ever clears), but email (below) is the PRD-sanctioned
      // fallback channel ("SMS or email") and the one actually relied on for the demo.
      if (!finalRecord.sms_sent && finalRecord.phone_number) {
        try {
          const summary = buildSmsSummary(finalRecord);
          await sendSms(finalRecord.phone_number, summary);
          await upsertRecord(callSid, { sms_sent: true, sms_sent_at: new Date().toISOString() });
        } catch (err) {
          console.error('SMS send failed', err);
          await logEvent(callSid, 'sms_error', { error: String(err) });
        }
      }

      if (!finalRecord.email_sent) {
        try {
          const { text, html } = buildEmailSummary(finalRecord);
          await sendConfirmationEmail({
            subject: `Your pre-visit intake is complete — Arya Health (${finalRecord.phone_number || callSid})`,
            text,
            html,
          });
          await upsertRecord(callSid, { email_sent: true, email_sent_at: new Date().toISOString() });
        } catch (err) {
          console.error('Email send failed', err);
          await logEvent(callSid, 'email_error', { error: String(err) });
        }
      }
    } else if (['busy', 'failed', 'no-answer', 'canceled'].includes(callStatus)) {
      const record = await getRecord(callSid);
      if (record && record.call_status === 'in_progress') {
        await upsertRecord(callSid, { call_status: 'dropped' });
      }
    }
  } catch (err) {
    console.error('/voice/status handler error', err);
  }

  res.sendStatus(200);
});

export default router;
