// Standalone smoke test for src/lib/supabase.js against the LIVE Supabase project.
// Run with: node scripts/test_supabase.js
//
// Requires supabase/schema.sql to have been applied to the project first
// (intake_records, call_events tables + merge_intake_field() function).

import {
  upsertRecord,
  upsertField,
  getRecord,
  logEvent,
  computeCompleteness,
} from '../src/lib/supabase.js';

function section(title) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  const callSid = `test-${Date.now()}`;
  console.log(`Using fake call_sid: ${callSid}`);

  section('upsertRecord (create)');
  const created = await upsertRecord(callSid, {
    call_status: 'in_progress',
    phone_number: '+15551234567',
  });
  console.log(created);

  section('upsertRecord (patch again — same call_sid, should update not duplicate)');
  const patched = await upsertRecord(callSid, {
    appointment_datetime: '2026-07-15T14:00:00-04:00',
  });
  console.log(patched);

  section('upsertField x3 (including a repeat of the same key to prove idempotency)');
  await upsertField(callSid, 'full_name', 'Jane Doe', 'captured');
  await upsertField(callSid, 'date_of_birth', '1990-01-01', 'captured');
  // Call the SAME key twice — should overwrite, not duplicate/append.
  await upsertField(callSid, 'full_name', 'Jane A. Doe', 'captured');
  await upsertField(callSid, 'insurance_payer_name', null, 'patient_declined');
  await upsertField(callSid, 'emergency_contact_phone', null, 'unable_to_capture');

  section('upsertField invalid state should throw');
  try {
    await upsertField(callSid, 'preferred_language', 'en', 'bogus_state');
    console.log('ERROR: expected throw, did not throw');
  } catch (err) {
    console.log('OK, threw as expected:', err.message);
  }

  section('logEvent');
  const event = await logEvent(callSid, 'turn', { speaker: 'patient', text: 'My name is Jane Doe.' });
  console.log(event);

  section('getRecord (final)');
  const record = await getRecord(callSid);
  console.log(JSON.stringify(record, null, 2));

  section('computeCompleteness');
  console.log(computeCompleteness(record.fields));

  section('DONE');
  console.log(`call_sid ${callSid} — inspect intake_records / call_events tables to confirm.`);
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err);
  process.exit(1);
});
