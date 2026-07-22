// Smoke test for src/lib/conversation.js.
//
// Run with: node scripts/test_conversation.js
//
// Always runs deterministic verification/disclosure checks. The multi-turn medical intake smoke
// uses the live Gemini API only when GEMINI_API_KEY is present.

import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { FIELD_GROUPS, REQUIRED_P0_FIELD_KEYS, CONSENT_SCRIPT } from '../src/lib/intakeSchema.js';
import { dobToDigits, getDemoPatient } from '../src/lib/demoPatients.js';

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../.env') });

const hasLiveGeminiEnv = Boolean(process.env.GEMINI_API_KEY);

// conversation.js imports config.js and creates a Gemini client at import time. Prime unrelated
// missing vars with inert values so deterministic checks run even without live credentials.
for (const [key, value] of Object.entries({
  TWILIO_ACCOUNT_SID: 'offline-smoke',
  TWILIO_AUTH_TOKEN: 'offline-smoke',
  GEMINI_API_KEY: 'offline-smoke',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'offline-smoke',
})) {
  if (!process.env[key]) process.env[key] = value;
}

const { runTurnWithContext, resetSession } = await import('../src/lib/conversation.js');

const FINAL_RESOLUTION_STATES = new Set([
  'verified',
  'updated',
  'captured',
  'patient_declined',
  'unable_to_capture',
  'not_applicable',
]);

const MEDICAL_TOOLS = new Set([
  'record_visit_reason_update',
  'record_medication_update',
  'record_allergy_update',
  'record_relevant_history_update',
  'record_conditional_admin_update',
  'record_patient_questions',
  'record_emergency_contact_update',
  'record_social_history_update',
]);

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function clonePreloadedSnapshot(patient) {
  return Object.fromEntries(
    Object.entries(patient.preloadedIntakeFields || {}).map(([key, entry]) => [
      key,
      {
        value: entry.value,
        state: entry.state || 'preloaded',
        updated_at: '2026-07-22T00:00:00.000Z',
      },
    ]),
  );
}

function applyToolCalls(snapshot, toolCalls) {
  for (const call of toolCalls || []) {
    const group = FIELD_GROUPS.find((g) => g.tool === call.tool);
    if (!group) continue;
    for (const key of group.fields) {
      const hasValue = Object.prototype.hasOwnProperty.call(call.args || {}, key);
      const hasState = Object.prototype.hasOwnProperty.call(call.args || {}, `${key}_state`);
      if (!hasValue && !hasState) continue;
      const value = hasValue ? call.args[key] : snapshot[key]?.value ?? null;
      const state = call.args[`${key}_state`] || (value != null ? 'captured' : 'unable_to_capture');
      snapshot[key] = { value, state, updated_at: new Date().toISOString() };
    }
  }
}

function toolNames(toolCalls) {
  return (toolCalls || []).map((call) => call.tool);
}

function findTool(toolCalls, name) {
  return (toolCalls || []).find((call) => call.tool === name);
}

function assertToolCalled(toolCalls, name) {
  assert.ok(findTool(toolCalls, name), `expected tool call ${name}; saw ${toolNames(toolCalls).join(', ') || 'none'}`);
}

function assertState(snapshot, key, allowedStates) {
  const state = snapshot[key]?.state;
  assert.ok(
    allowedStates.includes(state),
    `expected ${key} state in ${allowedStates.join(', ')}; saw ${state || 'missing'}`,
  );
}

function assertNoMedicalToolsBeforeDisclosure(results) {
  const earlyMedicalTools = results
    .flatMap((result) => result.toolCalls || [])
    .filter((call) => MEDICAL_TOOLS.has(call.tool));
  assert.deepEqual(earlyMedicalTools, [], 'medical intake tools should not fire before disclosure/appointment verification');
}

function unresolvedP0Fields(snapshot) {
  return REQUIRED_P0_FIELD_KEYS.filter((key) => {
    const state = snapshot[key]?.state;
    return !FINAL_RESOLUTION_STATES.has(state);
  });
}

async function startVerifiedCall({ callSid, patient }) {
  resetSession(callSid);
  const snapshot = clonePreloadedSnapshot(patient);
  const preDisclosureResults = [];

  let result = await runTurnWithContext({
    callSid,
    transcript: null,
    capturedFieldsSnapshot: snapshot,
    patientContext: patient,
  });
  preDisclosureResults.push(result);
  assert.equal(result.stage, 'greeting');
  assert.equal(result.inputMode, 'dtmf');
  assert.equal(result.consentGiven, false);
  assert.match(result.replyText, new RegExp(patient.fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.replyText, /upcoming appointment/i);

  result = await runTurnWithContext({
    callSid,
    digits: dobToDigits(patient.dateOfBirth),
    capturedFieldsSnapshot: snapshot,
    patientContext: patient,
  });
  preDisclosureResults.push(result);
  assert.equal(result.stage, 'appointment_verification');
  assert.equal(result.consentGiven, true);
  assert.match(result.replyText, new RegExp(CONSENT_SCRIPT.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.replyText, /Before we talk about any medical details/i);
  assert.doesNotMatch(result.replyText, /what has changed since booking|main reason for this visit/i);
  assertToolCalled(result.toolCalls, 'record_identity_verification');
  applyToolCalls(snapshot, result.toolCalls);
  assertState(snapshot, 'date_of_birth', ['verified']);

  assertNoMedicalToolsBeforeDisclosure(preDisclosureResults);

  result = await runTurnWithContext({
    callSid,
    transcript: "Yes, that's correct.",
    capturedFieldsSnapshot: snapshot,
    patientContext: patient,
  });
  assert.equal(result.stage, 'interview');
  assert.equal(result.consentGiven, true);
  assertToolCalled(result.toolCalls, 'record_appointment_verification');
  assertToolCalled(result.toolCalls, 'confirm_appointment');
  assert.match(result.replyText, /booking note|in your own words|changed since booking/i);
  applyToolCalls(snapshot, result.toolCalls);

  for (const key of ['appointment_datetime', 'clinic_name', 'specialist_name', 'appointment_type']) {
    assertState(snapshot, key, ['verified']);
  }

  return { snapshot, firstInterviewPrompt: result.replyText };
}

async function runDeterministicVerificationSmoke(patient) {
  section('deterministic verification and disclosure checks');
  const { snapshot, firstInterviewPrompt } = await startVerifiedCall({
    callSid: `CONV_DETERMINISTIC_${Date.now()}`,
    patient,
  });

  assert.match(firstInterviewPrompt, /booking note/i);
  assert.equal(snapshot.preferred_contact_method?.state, 'preloaded');
  assert.equal(snapshot.preferred_language?.state, 'preloaded');

  for (const oldOptionalKey of [
    'primary_care_provider',
    'referral_note',
    'referring_provider_name',
    'emergency_contact_name',
    'emergency_contact_relationship',
    'emergency_contact_phone',
  ]) {
    assert.ok(!REQUIRED_P0_FIELD_KEYS.includes(oldOptionalKey), `${oldOptionalKey} should not be P0-required`);
  }

  console.log('PASS: preloaded context, identity verification, appointment verification, and disclosure gate are deterministic.');
}

async function runLiveGeminiWorkflowSmoke(patient) {
  section('live Gemini workflow checks');

  if (!hasLiveGeminiEnv) {
    console.log('SKIP: missing live Gemini credential: GEMINI_API_KEY');
    return;
  }

  const callSid = `CONV_LIVE_${Date.now()}`;
  const { snapshot } = await startVerifiedCall({ callSid, patient });
  const allToolCalls = [];

  const turns = [
    'The booking note is right, but the palpitations are happening more often since booking. They started about two weeks ago during workouts, and my goal is for Dr. Shah to decide whether I need more testing.',
    'For medicines, I still take lisinopril 10 mg daily, I stopped atorvastatin last week, I started magnesium, and I am not sure of the magnesium dose.',
    'For allergies, penicillin is still correct. I have no new allergies and no new reaction details.',
    'For relevant history, hypertension and high cholesterol are still relevant. I have had no heart procedures and no other events besides the palpitations.',
    'For insurance, it is still Aetna, but my member ID changed to AET999000 and my group number is CARD2026.',
    'I do not have any questions for the specialist right now.',
  ];

  for (const [index, transcript] of turns.entries()) {
    const result = await runTurnWithContext({
      callSid,
      transcript,
      capturedFieldsSnapshot: snapshot,
      patientContext: patient,
    });

    console.log(`Turn ${index + 1}: stage=${result.stage}; tools=${toolNames(result.toolCalls).join(', ') || 'none'}`);
    allToolCalls.push(...(result.toolCalls || []));
    applyToolCalls(snapshot, result.toolCalls);

    if (result.stage === 'wrapup') {
      const done = await runTurnWithContext({
        callSid,
        transcript: 'That is all, thank you.',
        capturedFieldsSnapshot: snapshot,
        patientContext: patient,
      });
      console.log(`Wrapup: stage=${done.stage}; endCall=${done.endCall}`);
      break;
    }
  }

  assertToolCalled(allToolCalls, 'record_visit_reason_update');
  assertToolCalled(allToolCalls, 'record_medication_update');
  assertToolCalled(allToolCalls, 'record_allergy_update');
  assertToolCalled(allToolCalls, 'record_relevant_history_update');
  assertToolCalled(allToolCalls, 'record_conditional_admin_update');

  assertState(snapshot, 'patient_stated_reason', ['captured', 'updated']);
  assertState(snapshot, 'changes_since_booking', ['captured', 'updated']);
  assertState(snapshot, 'current_medications', ['verified', 'updated', 'captured']);
  assertState(snapshot, 'medication_changes', ['updated', 'captured']);
  assertState(snapshot, 'medication_unknowns', ['unable_to_capture', 'captured', 'updated']);
  assertState(snapshot, 'known_allergies', ['verified', 'updated', 'captured']);
  assertState(snapshot, 'new_allergies', ['not_applicable', 'verified', 'captured']);
  assertState(snapshot, 'insurance_member_id', ['updated', 'captured']);
  assertState(snapshot, 'insurance_group_number', ['updated', 'captured']);

  assert.equal(snapshot.preferred_contact_method?.state, 'preloaded');
  assert.equal(snapshot.preferred_language?.state, 'preloaded');
  assert.ok(
    !allToolCalls.some((call) => call.tool === 'record_emergency_contact_update'),
    'emergency contact should not be required in the P0 workflow',
  );

  const unresolved = unresolvedP0Fields(snapshot).filter((key) => {
    if (key === 'preferred_contact_method' || key === 'preferred_language') return false;
    return true;
  });
  assert.deepEqual(unresolved, []);

  console.log('PASS: live workflow covered visit reason, meds, allergies, relevant history, and conditional admin updates.');
}

try {
  const patient = getDemoPatient('pat-maya-rivera');
  assert.ok(patient, 'expected demo patient pat-maya-rivera');

  await runDeterministicVerificationSmoke(patient);
  await runLiveGeminiWorkflowSmoke(patient);
  section('DONE');
} catch (err) {
  console.error('\nTEST FAILED:', err?.message || err);
  if (err?.status) console.error('Status:', err.status);
  if (err?.statusText) console.error('StatusText:', err.statusText);
  if (err?.errorDetails) console.error('Details:', JSON.stringify(err.errorDetails, null, 2));
  process.exitCode = 1;
}
