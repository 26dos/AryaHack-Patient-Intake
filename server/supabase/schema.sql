-- Mock EHR / intake schema (PRD Section 4).
-- Two tables:
--   intake_records — one row per call_sid, upserted idempotently as fields are captured
--   call_events    — append-only log of everything that happens on a call (for debugging/audit)
--
-- Safe to run multiple times (all statements are guarded with IF NOT EXISTS / OR REPLACE).

create extension if not exists pgcrypto;

create table if not exists intake_records (
  id uuid primary key default gen_random_uuid(),
  call_sid text unique not null,
  call_status text not null default 'in_progress', -- in_progress | completed | voicemail | dropped | emergency_escalated
  phone_number text,
  appointment_datetime text,
  consent_given boolean not null default false,
  consent_logged_at timestamptz,
  appointment_confirmed boolean not null default false,
  fields jsonb not null default '{}'::jsonb,
  sms_sent boolean not null default false,
  sms_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists call_events (
  id uuid primary key default gen_random_uuid(),
  call_sid text not null,
  event_type text not null, -- e.g. turn, consent_logged, emergency_flag, field_captured, error, call_status
  payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists call_events_call_sid_idx on call_events (call_sid);
create index if not exists intake_records_updated_at_idx on intake_records (updated_at desc);

-- Keep updated_at current on every update, so "record appears on dashboard within 5s of
-- call end" and "listRecentRecords order by updated_at desc" both stay accurate.
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists intake_records_set_updated_at on intake_records;
create trigger intake_records_set_updated_at
  before update on intake_records
  for each row
  execute function set_updated_at();

-- Atomic single-field merge into the `fields` JSONB column, keyed by call_sid.
-- Using the jsonb `||` concat operator inside one UPDATE (rather than an
-- application-level read-modify-write) means concurrent calls for *different*
-- field keys on the same call_sid never clobber each other, and the row is
-- created on first use — this is what upsertField() in src/lib/supabase.js
-- calls via supabase.rpc('merge_intake_field', ...).
create or replace function merge_intake_field(
  p_call_sid text,
  p_patch jsonb
)
returns intake_records as $$
  insert into intake_records (call_sid, fields)
  values (p_call_sid, p_patch)
  on conflict (call_sid)
  do update set fields = intake_records.fields || excluded.fields
  returning *;
$$ language sql;
