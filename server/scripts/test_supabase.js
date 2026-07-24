// Standalone smoke test for src/lib/supabase.js.
//
// Run with: node scripts/test_supabase.js
//
// Always runs deterministic completeness/state checks locally. Live Supabase writes run only when
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are present.

import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { FIELD_STATES, REQUIRED_P0_FIELD_KEYS } from '../src/lib/intakeSchema.js';

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../.env') });

const REQUIRED_SUPABASE_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missingSupabaseEnv = REQUIRED_SUPABASE_ENV.filter((name) => !process.env[name]);
const hasLiveSupabaseEnv = missingSupabaseEnv.length === 0;
const allowLiveSmokeSkip = process.env.ALLOW_LIVE_SMOKE_SKIP === '1';

// supabase.js creates a client at import time. Prime missing vars with inert values so the
// deterministic computeCompleteness checks can run without live credentials.
for (const [key, value] of Object.entries({
  TWILIO_ACCOUNT_SID: 'offline-smoke',
  TWILIO_AUTH_TOKEN: 'offline-smoke',
  GEMINI_API_KEY: 'offline-smoke',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'offline-smoke',
})) {
  if (!process.env[key]) process.env[key] = value;
}

const {
  upsertRecord,
  upsertField,
  getRecord,
  logEvent,
  computeCompleteness,
} = await import('../src/lib/supabase.js');

const COMPLETENESS_STATES = [
  'verified',
  'updated',
  'captured',
  'patient_declined',
  'unable_to_capture',
  'not_applicable',
];

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function sampleValueFor(key, state) {
  if (state === 'patient_declined' || state === 'unable_to_capture' || state === 'not_applicable') {
    return null;
  }
  return `sample ${key}`;
}

function buildCompleteFields() {
  return Object.fromEntries(
    REQUIRED_P0_FIELD_KEYS.map((key, index) => {
      const state = COMPLETENESS_STATES[index % COMPLETENESS_STATES.length];
      return [
        key,
        {
          value: sampleValueFor(key, state),
          state,
          updated_at: '2026-07-22T00:00:00.000Z',
        },
      ];
    }),
  );
}

async function runDeterministicChecks() {
  section('offline state and completeness checks');

  for (const state of ['preloaded', ...COMPLETENESS_STATES]) {
    assert.ok(FIELD_STATES.includes(state), `FIELD_STATES should accept ${state}`);
  }

  const completeFields = buildCompleteFields();
  const complete = computeCompleteness(completeFields);
  assert.equal(complete.totalRequired, REQUIRED_P0_FIELD_KEYS.length);
  assert.equal(complete.resolved, REQUIRED_P0_FIELD_KEYS.length);
  assert.deepEqual(complete.missing, []);
  assert.ok(complete.captured > 0, 'captured fields should be counted');
  assert.ok(complete.declinedOrUnable > 0, 'declined/unable fields should be counted');
  assert.ok(complete.unableToCapture.length > 0, 'unable_to_capture fields should be tracked');
  assert.deepEqual(complete.deskFollowUp, complete.unableToCapture);

  const preloadedOnlyFields = {
    ...completeFields,
    date_of_birth: {
      value: '1984-09-14',
      state: 'preloaded',
      updated_at: '2026-07-22T00:00:00.000Z',
    },
  };
  const preloadedOnly = computeCompleteness(preloadedOnlyFields);
  assert.equal(preloadedOnly.resolved, REQUIRED_P0_FIELD_KEYS.length - 1);
  assert.ok(preloadedOnly.missing.includes('date_of_birth'));

  const conditionalAdminPreloaded = computeCompleteness(
    {
      ...completeFields,
      insurance_payer_name: undefined,
      insurance_member_id: undefined,
      insurance_group_number: undefined,
      preferred_contact_method: undefined,
      preferred_language: undefined,
    },
    {
      existing_admin_info: {
        insurance_payer_name: 'Aetna',
        insurance_member_id: 'AET4829156',
        insurance_group_number: 'GRP-1048',
        preferred_contact_method: 'SMS',
        preferred_language: 'English',
      },
    },
  );
  assert.deepEqual(
    conditionalAdminPreloaded.missing.filter((key) => key.startsWith('insurance_') || key.startsWith('preferred_')),
    [],
    'preloaded conditional admin fields should resolve API completeness',
  );

  const malformedValueStates = computeCompleteness({
    ...completeFields,
    patient_stated_reason: { value: null, state: 'updated', updated_at: '2026-07-22T00:00:00.000Z' },
    current_medications: { value: '', state: 'captured', updated_at: '2026-07-22T00:00:00.000Z' },
    known_allergies: { value: null, state: 'verified', updated_at: '2026-07-22T00:00:00.000Z' },
  });
  assert.ok(malformedValueStates.missing.includes('patient_stated_reason'));
  assert.ok(malformedValueStates.missing.includes('current_medications'));
  assert.ok(malformedValueStates.missing.includes('known_allergies'));

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

  await assert.rejects(
    () => upsertField('offline-invalid-state', 'preferred_language', 'English', 'bogus_state'),
    /invalid state/,
  );

  console.log('PASS: expanded states and completeness behavior match the current schema contract.');
}

async function runLiveSupabaseChecks() {
  section('live Supabase writes');

  if (!hasLiveSupabaseEnv) {
    const message = `missing live Supabase credentials: ${missingSupabaseEnv.join(', ')}`;
    if (allowLiveSmokeSkip) {
      console.log(`SKIP: ${message}; ALLOW_LIVE_SMOKE_SKIP=1`);
      return;
    }
    throw new Error(`${message}. Set ALLOW_LIVE_SMOKE_SKIP=1 only when intentionally running offline checks.`);
  }

  const callSid = `smoke-${Date.now()}`;
  console.log(`Using fake call_sid: ${callSid}`);

  await upsertRecord(callSid, {
    call_status: 'in_progress',
    phone_number: '+15551234567',
    appointment_datetime: 'Thursday, July 23, 2026 at 2:30 PM',
    consent_given: true,
    preloaded_context: {
      patient_identity: {
        full_name: 'Maya Rivera',
        date_of_birth: '1984-09-14',
        phone_number: '+15551234567',
      },
      appointment_context: {
        appointment_datetime: 'Thursday, July 23, 2026 at 2:30 PM',
        clinic_name: 'Riverside Cardiology',
        specialist_name: 'Dr. Priya Shah, MD',
        appointment_type: 'New patient cardiology consult',
      },
    },
  });

  await upsertRecord(callSid, { appointment_confirmed: true });

  const stateWrites = [
    ['phone_number', '+15551234567', 'preloaded'],
    ['date_of_birth', '1984-09-14', 'verified'],
    ['patient_stated_reason', 'Palpitations are more frequent since booking', 'updated'],
    ['current_medications', 'Lisinopril continued; atorvastatin stopped', 'updated'],
    ['medication_unknowns', null, 'unable_to_capture'],
    ['known_allergies', 'Penicillin rash', 'verified'],
    ['new_allergies', null, 'not_applicable'],
    ['insurance_member_id', null, 'patient_declined'],
    ['preferred_language', 'English', 'captured'],
  ];

  for (const [fieldKey, value, state] of stateWrites) {
    await upsertField(callSid, fieldKey, value, state);
  }

  await upsertField(callSid, 'full_name', 'Maya Rivera', 'captured');
  await upsertField(callSid, 'full_name', 'Maya A. Rivera', 'updated');
  await logEvent(callSid, 'smoke_test_turn', { speaker: 'patient', text: 'I updated my medications.' });

  const record = await getRecord(callSid);
  assert.ok(record, 'record should exist after live smoke writes');
  assert.equal(record.call_sid, callSid);
  assert.equal(record.fields.full_name.value, 'Maya A. Rivera');
  assert.equal(record.fields.full_name.state, 'updated');

  for (const [, , state] of stateWrites) {
    assert.ok(
      Object.values(record.fields).some((entry) => entry.state === state),
      `expected at least one persisted field with state ${state}`,
    );
  }

  console.log('PASS: live Supabase upserts accepted expanded states and idempotent field updates.');
}

try {
  await runDeterministicChecks();
  await runLiveSupabaseChecks();
  section('DONE');
} catch (err) {
  console.error('\nTEST FAILED:', err?.message || err);
  if (err?.status) console.error('Status:', err.status);
  if (err?.statusText) console.error('StatusText:', err.statusText);
  if (err?.details) console.error('Details:', err.details);
  process.exitCode = 1;
}
