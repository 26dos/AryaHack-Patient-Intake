# Arya Health — AI Voice Intake Agent

Twilio + Gemini + ElevenLabs + Supabase pre-appointment intake voice agent, per `/Users/aarya/Desktop/hack-arya/PRD.md`.

## Setup

1. `.env` is already populated with live credentials (Twilio, Gemini, ElevenLabs, Supabase).
2. Apply `supabase/schema.sql` once via the Supabase SQL Editor (service-role key can't run DDL).
3. `npm install`
4. Start ngrok: `ngrok http 3000` (or reuse the running tunnel) and set `PUBLIC_BASE_URL` in `.env` to the `https://` forwarding URL.
5. Buy a Twilio number (once KYC/Trust Hub compliance is approved on the account): `npm run buy-number`
6. Point the number's webhooks at the tunnel: `node scripts/configure_number.js $PUBLIC_BASE_URL`
7. `npm start` (or `npm run dev` for auto-reload)

## Test end-to-end

- Place an outbound call to the verified test number: `npm run test-call`
- Watch the live dashboard at `$PUBLIC_BASE_URL/` (or `http://localhost:3000/`)
- Confirmation SMS should arrive within 60s of hangup

## Demo patients

The server has a generated demo patient roster with name, DOB, insurance ID, and
phone placeholders. `TEST_PATIENT_PHONE_NUMBER` is the default phone override for
Maya Rivera. Additional real test numbers can be supplied with:

```bash
DEMO_PATIENT_MAYA_PHONE=...
DEMO_PATIENT_DANIEL_PHONE=...
DEMO_PATIENT_ELENA_PHONE=...
DEMO_PATIENT_ID=pat-maya-rivera
```

Calls seed the selected patient before dialing, verify DOB by keypad, then play
the AI/recording disclosure and move to intake. Insurance ID remains self-reported intake data for the
demo, not a verifier.

## Module map

- `src/index.js` — Express app entry, mounts all routers
- `src/routes/voice.js` — Twilio webhook handlers (`/voice/incoming`, `/voice/gather`, `/voice/status`), TwiML generation, tool-call → Supabase field mapping, SMS summary dispatch
- `src/routes/dashboard.js` — live "mock EHR" dashboard (`/`, `/api/records`)
- `src/routes/audio.js` — serves ElevenLabs-synthesized clips for `<Play>`
- `src/lib/conversation.js` — Gemini tool-calling conversation engine (stage machine: greeting → disclosure → interview → wrapup)
- `src/lib/guardrails.js` — hard-coded emergency keyword pre-check + clinical-advice-request detector
- `src/lib/supabase.js` — idempotent record/field upserts, event log, completeness calc
- `src/lib/tts.js` / `src/lib/audioStore.js` — ElevenLabs synthesis + in-memory audio serving, falls back to Twilio `<Say>`
- `src/lib/intakeSchema.js` — single source of truth for field groups/keys/states (PRD Section 4)

## Known limitations (by design, for the hackathon window)

- Turn-taking uses Twilio `<Gather input="speech">` (Twilio's built-in ASR) rather than raw bidirectional Media Streams — faster to build reliably; barge-in works because `<Gather>` starts listening as soon as its nested `<Say>/<Play>` begins.
- Voicemail detection uses Twilio's `MachineDetection` on outbound calls only.
- No live EHR integration — Supabase is the mock EHR per PRD non-goals.
