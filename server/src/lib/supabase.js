import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { FIELD_GROUPS, FIELD_STATES, REQUIRED_P0_FIELD_KEYS } from './intakeSchema.js';

export const supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey);

const RECORD_PATCH_KEYS = [
  'call_status',
  'phone_number',
  'appointment_datetime',
  'consent_given',
  'consent_logged_at',
  'appointment_confirmed',
  'preloaded_context',
  'sms_sent',
  'sms_sent_at',
  'email_sent',
  'email_sent_at',
];

const INTENDED_FIELD_STATES = [
  'preloaded',
  'verified',
  'updated',
  'captured',
  'patient_declined',
  'unable_to_capture',
  'not_applicable',
];

const RESOLVED_COMPLETENESS_STATES = new Set([
  'verified',
  'updated',
  'captured',
  'patient_declined',
  'unable_to_capture',
  'not_applicable',
]);
const VALUE_REQUIRED_STATES = new Set(['preloaded', 'verified', 'updated', 'captured']);
const CONDITIONAL_ADMIN_FIELD_KEYS = new Set(
  FIELD_GROUPS.find((g) => g.group === 'conditional_admin_update')?.fields || []
);

function validFieldStates() {
  return Array.from(new Set([
    ...(Array.isArray(FIELD_STATES) ? FIELD_STATES : []),
    ...INTENDED_FIELD_STATES,
  ]));
}

function hasProvidedValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function valueFromFieldEntry(entry) {
  if (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'value')) {
    return entry.value;
  }
  return entry;
}

function findInPreloadedContext(context, fieldKey) {
  for (const groupValue of Object.values(context || {})) {
    if (!groupValue || typeof groupValue !== 'object') continue;
    if (Object.prototype.hasOwnProperty.call(groupValue, fieldKey)) {
      return valueFromFieldEntry(groupValue[fieldKey]);
    }
  }
  return undefined;
}

function completenessEntryFor(fields, preloadedContext, key) {
  const entry = fields?.[key];
  if (entry) return entry;
  if (!CONDITIONAL_ADMIN_FIELD_KEYS.has(key)) return null;
  const preloadedValue = findInPreloadedContext(preloadedContext, key);
  if (!hasProvidedValue(preloadedValue)) return null;
  return { value: preloadedValue, state: 'preloaded' };
}

function isCompletenessResolved(key, entry) {
  if (!entry || !entry.state) return false;
  if (entry.state === 'preloaded') {
    return CONDITIONAL_ADMIN_FIELD_KEYS.has(key) && hasProvidedValue(valueFromFieldEntry(entry));
  }
  if (!RESOLVED_COMPLETENESS_STATES.has(entry.state)) return false;
  if (VALUE_REQUIRED_STATES.has(entry.state) && !hasProvidedValue(valueFromFieldEntry(entry))) return false;
  return true;
}

/**
 * Idempotent upsert of top-level intake_records fields, keyed by call_sid.
 * Creates the row if missing. Safe to call repeatedly for the same call_sid
 * (e.g. on Twilio webhook retries after a dropped/reconnected call) — this
 * never inserts a second row for the same call_sid because call_sid is UNIQUE
 * and we upsert on that conflict target.
 *
 * @param {string} callSid
 * @param {Partial<Record<typeof RECORD_PATCH_KEYS[number], any>>} patch
 */
export async function upsertRecord(callSid, patch = {}) {
  if (!callSid) throw new Error('upsertRecord requires a callSid');

  const row = { call_sid: callSid };
  for (const key of RECORD_PATCH_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      row[key] = patch[key];
    }
  }

  const { data, error } = await supabase
    .from('intake_records')
    .upsert(row, { onConflict: 'call_sid' })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Merge one field into the `fields` JSONB column, keyed by call_sid.
 * Safe to call repeatedly / out of order (idempotent) — calling it twice for
 * the same fieldKey just overwrites that key's value/state/updated_at, never
 * duplicates. Also safe under concurrent calls for *different* field keys on
 * the same call_sid, because the merge happens atomically in Postgres (see
 * merge_intake_field() in supabase/schema.sql) rather than via an
 * application-level read-modify-write, which would risk clobbering a
 * concurrent write to a different key.
 *
 * @param {string} callSid
 * @param {string} fieldKey
 * @param {any} value
 * @param {'preloaded'|'verified'|'updated'|'captured'|'patient_declined'|'unable_to_capture'|'not_applicable'} state
 */
export async function upsertField(callSid, fieldKey, value, state) {
  if (!callSid) throw new Error('upsertField requires a callSid');
  if (!fieldKey) throw new Error('upsertField requires a fieldKey');
  const states = validFieldStates();
  if (!states.includes(state)) {
    throw new Error(`upsertField: invalid state "${state}". Must be one of: ${states.join(', ')}`);
  }

  const patch = {
    [fieldKey]: {
      value,
      state,
      updated_at: new Date().toISOString(),
    },
  };

  const { data, error } = await supabase
    .rpc('merge_intake_field', { p_call_sid: callSid, p_patch: patch })
    .single();

  if (error) throw error;
  return data;
}

/** Returns the intake_records row for a call_sid, or null if none exists. */
export async function getRecord(callSid) {
  if (!callSid) throw new Error('getRecord requires a callSid');

  const { data, error } = await supabase
    .from('intake_records')
    .select('*')
    .eq('call_sid', callSid)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

/** Insert an append-only event into call_events (turn, consent_logged, emergency_flag, etc). */
export async function logEvent(callSid, eventType, payload = null) {
  if (!callSid) throw new Error('logEvent requires a callSid');
  if (!eventType) throw new Error('logEvent requires an eventType');

  const { data, error } = await supabase
    .from('call_events')
    .insert({ call_sid: callSid, event_type: eventType, payload })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/** For the dashboard: most recently updated intake records first. */
export async function listRecentRecords(limit = 20) {
  const { data, error } = await supabase
    .from('intake_records')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

/**
 * Given a record's `fields` JSONB, compute completeness against the P0 required
 * field keys from intakeSchema.js.
 *
 * @param {Record<string, {value: any, state: string, updated_at: string}>} fields
 * @param {Record<string, any>} preloadedContext
 * @returns {{ totalRequired: number, resolved: number, captured: number, declinedOrUnable: number, unableToCapture: string[], unableToCaptureCount: number, deskFollowUp: string[], missing: string[] }}
 */
export function computeCompleteness(fields = {}, preloadedContext = {}) {
  const safeFields = fields || {};
  let resolved = 0;
  let captured = 0;
  let declinedOrUnable = 0;
  const unableToCapture = [];
  const deskFollowUp = [];
  const missing = [];

  for (const key of REQUIRED_P0_FIELD_KEYS) {
    const entry = completenessEntryFor(safeFields, preloadedContext, key);
    if (!isCompletenessResolved(key, entry)) {
      missing.push(key);
      continue;
    }
    resolved += 1;

    if (entry.state === 'captured') {
      captured += 1;
    } else if (entry.state === 'patient_declined' || entry.state === 'unable_to_capture') {
      declinedOrUnable += 1;
    }

    if (entry.state === 'unable_to_capture') {
      unableToCapture.push(key);
      deskFollowUp.push(key);
    }
  }

  return {
    totalRequired: REQUIRED_P0_FIELD_KEYS.length,
    resolved,
    captured,
    declinedOrUnable,
    unableToCapture,
    unableToCaptureCount: unableToCapture.length,
    deskFollowUp,
    missing,
  };
}
