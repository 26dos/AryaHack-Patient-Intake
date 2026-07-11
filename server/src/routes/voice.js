import express from 'express';
import twilio from 'twilio';
import { config } from '../config.js';
import { runTurn } from '../lib/conversation.js';
import { upsertRecord, upsertField, logEvent, getRecord } from '../lib/supabase.js';
import { synthesizeAndStore } from '../lib/tts.js';
import { sendSms } from '../twilioClient.js';
import { FIELD_GROUPS, EMERGENCY_KEYWORDS_MESSAGE, ALL_FIELD_KEYS } from '../lib/intakeSchema.js';

const router = express.Router();
const { VoiceResponse } = twilio.twiml;

const TOOL_TO_GROUP = Object.fromEntries(FIELD_GROUPS.map((g) => [g.tool, g]));

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
async function appendSpeech(node, text) {
  const audioPath = await synthesizeAndStore(text);
  if (audioPath) {
    node.play(`${config.publicBaseUrl}${audioPath}`);
  } else {
    node.say({ voice: 'Polly.Joanna' }, text);
  }
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

async function buildTurnTwiml({ callSid, transcript }) {
  const record = await getRecord(callSid);
  const capturedFieldsSnapshot = record?.fields || {};

  const result = await runTurn({ callSid, transcript, capturedFieldsSnapshot });
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

  await applyToolCalls(callSid, result.toolCalls);
  await logEvent(callSid, 'turn', { transcript, reply: result.replyText, stage: result.stage });

  if (result.endCall) {
    await appendSpeech(twiml, result.replyText);
    twiml.hangup();
    await upsertRecord(callSid, { call_status: 'completed' });
    return twiml;
  }

  const gather = twiml.gather({
    input: 'speech',
    action: '/voice/gather',
    method: 'POST',
    speechTimeout: 'auto',
    speechModel: 'phone_call',
  });
  await appendSpeech(gather, result.replyText);
  twiml.redirect({ method: 'POST' }, '/voice/gather-fallback');

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

  await upsertRecord(callSid, { phone_number: patientNumber, call_status: 'in_progress' });
  await logEvent(callSid, 'call_started', { patientNumber, direction, answeredBy });

  if (answeredBy && answeredBy.startsWith('machine')) {
    const twiml = new VoiceResponse();
    await appendSpeech(
      twiml,
      "Hi, this is Arya Health calling to complete your pre-visit intake. Please call us back at your convenience so we can get your chart ready before your appointment. Thank you!"
    );
    twiml.hangup();
    await upsertRecord(callSid, { call_status: 'voicemail' });
    res.type('text/xml').send(twiml.toString());
    return;
  }

  const twiml = await buildTurnTwiml({ callSid, transcript: null });
  res.type('text/xml').send(twiml.toString());
}));

router.post('/voice/gather', safeVoiceHandler(async (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult || '';
  await logEvent(callSid, 'speech_result', { speechResult, confidence: req.body.Confidence });
  const twiml = await buildTurnTwiml({ callSid, transcript: speechResult });
  res.type('text/xml').send(twiml.toString());
}));

router.post('/voice/gather-fallback', safeVoiceHandler(async (req, res) => {
  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    action: '/voice/gather',
    method: 'POST',
    speechTimeout: 'auto',
    speechModel: 'phone_call',
  });
  await appendSpeech(gather, "Sorry, I didn't catch that — could you say that again?");
  twiml.redirect({ method: 'POST' }, '/voice/gather-fallback-2');
  res.type('text/xml').send(twiml.toString());
}));

router.post('/voice/gather-fallback-2', safeVoiceHandler(async (req, res) => {
  const callSid = req.body.CallSid;
  const twiml = new VoiceResponse();
  await appendSpeech(
    twiml,
    "It looks like I'm having trouble hearing you, so I'll let you go for now. We'll follow up by text. Take care!"
  );
  twiml.hangup();
  await upsertRecord(callSid, { call_status: 'dropped' });
  res.type('text/xml').send(twiml.toString());
}));

function buildSmsSummary(record) {
  const fields = record.fields || {};
  const lines = ['Thanks for completing your pre-visit intake with Arya Health! Summary:'];
  for (const key of ALL_FIELD_KEYS) {
    const f = fields[key];
    if (!f) continue;
    const label = key.replace(/_/g, ' ');
    if (f.state === 'captured' && f.value) {
      lines.push(`- ${label}: ${f.value}`);
    } else if (f.state === 'patient_declined') {
      lines.push(`- ${label}: declined to share`);
    }
  }
  lines.push('If anything looks wrong, call us back before your visit.');
  return lines.join('\n');
}

router.post('/voice/status', async (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;

  try {
    await logEvent(callSid, 'call_status', { callStatus });
    if (callStatus === 'completed') {
      const record = await getRecord(callSid);
      if (record && !['completed', 'voicemail', 'emergency_escalated'].includes(record.call_status)) {
        await upsertRecord(callSid, { call_status: 'completed' });
      }
      if (record && !record.sms_sent && record.phone_number) {
        try {
          const summary = buildSmsSummary(record);
          await sendSms(record.phone_number, summary);
          await upsertRecord(callSid, { sms_sent: true, sms_sent_at: new Date().toISOString() });
        } catch (err) {
          console.error('SMS send failed', err);
          await logEvent(callSid, 'sms_error', { error: String(err) });
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
