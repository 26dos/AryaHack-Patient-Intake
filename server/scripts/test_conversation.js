// Manual/live test harness for src/lib/conversation.js — NOT a unit test framework, just a
// scripted multi-turn simulated call run against the REAL Gemini API (per task instructions).
//
// Run with: node scripts/test_conversation.js
//
// Simulates a patient call end-to-end: greeting -> disclosure -> interview (including a decline,
// an unprompted volunteered field, and a mid-interview emergency utterance) -> wrapup/done.
//
// This script plays the role the Twilio webhook layer will eventually play: it owns a local
// `snapshot` object standing in for Supabase, and after every turn applies the engine's
// `toolCalls` onto that snapshot (mirroring the intended `upsertField` mapping described at the
// top of conversation.js), then passes the updated snapshot into the next runTurn() call.

import { runTurn, resetSession } from '../src/lib/conversation.js';
import { FIELD_GROUPS } from '../src/lib/intakeSchema.js';

const CALL_SID = 'TEST_CALL_SID_001';

function applyToolCalls(snapshot, toolCalls) {
  for (const call of toolCalls) {
    const group = FIELD_GROUPS.find((g) => g.tool === call.tool);
    if (!group) continue; // confirm_appointment / end_interview: nothing to persist
    for (const key of group.fields) {
      const hasValue = Object.prototype.hasOwnProperty.call(call.args || {}, key);
      const hasState = Object.prototype.hasOwnProperty.call(call.args || {}, `${key}_state`);
      if (!hasValue && !hasState) continue;
      const value = call.args[key] ?? null;
      const state = call.args[`${key}_state`] || (value != null ? 'captured' : 'unable_to_capture');
      snapshot[key] = { value, state, updated_at: new Date().toISOString() };
    }
  }
}

// Turn 0 transcript is null (call just connected). Every later turn is a scripted fake patient
// utterance designed to exercise: identity confirm, an unprompted volunteered field (insurance
// before being asked), an explicit decline (marks patient_declined), and an emergency phrase that
// must short-circuit Gemini.
const PATIENT_TURNS = [
  null, // triggers greeting
  "Yes, this is John Doe, and yes, my appointment is this Thursday at 10 AM.",
  "I've had a bad cough and sore throat for about a week, that's why I'm coming in. Oh, and by the way, my insurance is Blue Cross Blue Shield, member ID BC-88213-A.",
  "My date of birth is March 4th, 1990, and I'd rather not give you my emergency contact right now.",
  "Actually hold on -- I'm having chest pain and I can't breathe well right now.",
  "Sorry, I'm okay, false alarm, just needed a second. My emergency contact is my wife Sarah Doe, her number is 555-201-3344.",
  "I'm on lisinopril 10mg daily, and I'm allergic to penicillin. No prior conditions otherwise. That's everything I think.",
  "Oh sorry, my full name is John Doe, I speak English, and the group number on my insurance card is GRP-5567.",
  "Nope, that's everything, thank you!",
];

async function main() {
  resetSession(CALL_SID);
  const snapshot = {};

  console.log('='.repeat(80));
  console.log('Simulated call:', CALL_SID);
  console.log('='.repeat(80));

  for (let i = 0; i < PATIENT_TURNS.length; i++) {
    const transcript = PATIENT_TURNS[i];
    console.log(`\n--- Turn ${i} ---`);
    console.log('Patient said:', transcript === null ? '(call connected, no speech yet)' : JSON.stringify(transcript));

    let result;
    try {
      result = await runTurn({ callSid: CALL_SID, transcript, capturedFieldsSnapshot: snapshot });
    } catch (err) {
      console.error('\n!!! runTurn threw an error !!!');
      console.error('Message:', err?.message);
      if (err?.status) console.error('Status:', err.status);
      if (err?.statusText) console.error('StatusText:', err.statusText);
      if (err?.errorDetails) console.error('Details:', JSON.stringify(err.errorDetails, null, 2));
      console.error('\nFull error:', err);
      process.exitCode = 1;
      return;
    }

    console.log('Agent stage:', result.stage);
    console.log('Emergency detected:', result.emergencyDetected);
    console.log('Consent given:', result.consentGiven);
    console.log('Agent replyText:', result.replyText);
    console.log('Tool calls:', JSON.stringify(result.toolCalls, null, 2));
    console.log('End call:', result.endCall);

    applyToolCalls(snapshot, result.toolCalls);

    if (result.endCall) {
      console.log('\n(call ended by engine — stopping simulation)');
      break;
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('Final captured snapshot:');
  console.log(JSON.stringify(snapshot, null, 2));
  console.log('='.repeat(80));
}

main().catch((err) => {
  console.error('Unhandled error in test script:', err);
  process.exitCode = 1;
});
