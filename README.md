# AryaHack-Patient-Intake

An AI voice intake agent that calls patients ahead of a scheduled appointment, conducts a structured
pre-visit intake interview over a live phone call, and syncs the results to a mock EHR dashboard —
built for AI Healthcare Hack NYC (Arya Health x Twilio AI Startup Searchlight).

Full product spec: [`PRD.md`](./PRD.md). Original brainstorm: [`Arya Hackathon (2).md`](./Arya%20Hackathon%20(2).md).

## Stack

Twilio Voice (telephony + built-in STT) → Gemini (tool-calling conversation engine) → ElevenLabs
(TTS, falls back to Twilio `<Say>`) → Supabase (idempotent structured intake records + live dashboard).

## Running it

See [`server/README.md`](./server/README.md) for setup, environment variables, and how to place a
live test call end-to-end.
