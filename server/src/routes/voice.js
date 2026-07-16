import express from 'express';
import twilio from 'twilio';
import { config } from '../config.js';
import { runTurnWithContext } from '../lib/conversation.js';
import { upsertRecord, upsertField, logEvent, getRecord } from '../lib/supabase.js';
import { synthesizeAndStore } from '../lib/tts.js';
import { sendSms } from '../twilioClient.js';
import { sendConfirmationEmail } from '../lib/email.js';
import { FIELD_GROUPS, EMERGENCY_KEYWORDS_MESSAGE, ALL_FIELD_KEYS } from '../lib/intakeSchema.js';
import { getDemoPatient, getDemoPatientByPhone } from '../lib/demoPatients.js';

const router = express.Router();
const { VoiceResponse } = twilio.twiml;

const TOOL_TO_GROUP = Object.fromEntries(FIELD_GROUPS.map((g) => [g.tool, g]));
const noiseRetries = new Map();
const TERMINAL_NON_SUMMARY_STATUSES = new Set([
  'voicemail',
  'dropped',
  'verification_failed',
  'consent_declined',
  'emergency_escalated',
]);

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
  await upsertRecord(callSid, {
    phone_number: patient.phoneNumber || phoneNumber,
    appointment_datetime: patient.appointmentDatetime,
  });
  await upsertField(callSid, 'full_name', patient.fullName, 'captured');
  await upsertField(callSid, 'preferred_language', patient.preferredLanguage, 'captured');
  await logEvent(callSid, 'demo_patient_seeded', { patientId: patient.id });
}

async function applyToolCalls(callSid, toolCalls = []) {
  for (const call of toolCalls) {
    try {
      if (call.tool === 'confirm_appointment') {
        await upsertRecord(callSid, { appointment_confirmed: !!call.args?.confirmed });
        continue;
      }
      if (call.tool === 'end_interview') {
        await logEvent(callSid, 'end_interview', call.args);
        continue;
      }
      const group = TOOL_TO_GROUP[call.tool];
      if (!group) {
        await logEvent(callSid, 'unknown_tool_call', call);
        continue;
      }
      for (const field of group.fields) {
        const args = call.args || {};
        if (!(field in args) && !(`${field}_state` in args)) continue; // untouched this turn
        const value = args[field] ?? null;
        const state = args[`${field}_state`] || (value != null ? 'captured' : 'unable_to_capture');
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
  if (record?.appointment_datetime) capturedFieldsSnapshot.appointment_datetime = record.appointment_datetime;

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

  if (result.consentGiven !== undefined) {
    await upsertRecord(callSid, {
      consent_given: result.consentGiven,
      consent_logged_at: result.consentGiven ? new Date().toISOString() : null,
    });
  }

  if (result.verifiedDateOfBirth) {
    await upsertField(callSid, 'date_of_birth', result.verifiedDateOfBirth, 'captured');
  }
  await applyToolCalls(callSid, result.toolCalls);
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

function buildIntakeSummaryLines(record) {
  const fields = record.fields || {};
  const lines = [];
  for (const key of ALL_FIELD_KEYS) {
    const f = fields[key];
    if (!f) continue;
    const label = key.replace(/_/g, ' ');
    if (f.state === 'captured' && f.value) {
      lines.push(`${label}: ${f.value}`);
    } else if (f.state === 'patient_declined') {
      lines.push(`${label}: declined to share`);
    }
  }
  return lines;
}

function buildSmsSummary(record) {
  const lines = buildIntakeSummaryLines(record).map((l) => `- ${l}`);
  return [
    'Thanks for completing your pre-visit intake with Arya Health! Summary:',
    ...lines,
    'If anything looks wrong, call us back before your visit.',
  ].join('\n');
}

function buildEmailSummary(record) {
  const lines = buildIntakeSummaryLines(record);
  const text = [
    'Thanks for completing your pre-visit intake with Arya Health!',
    '',
    'Summary of what we captured:',
    ...lines.map((l) => `- ${l}`),
    '',
    'If anything looks wrong, call us back before your visit.',
  ].join('\n');
  const html = `
    <p>Thanks for completing your pre-visit intake with Arya Health!</p>
    <p><strong>Summary of what we captured:</strong></p>
    <ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul>
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
