# **PRD: AI Voice Pre-Visit Intake Agent for Specialist Clinics**

**Hackathon:** AI Healthcare Hack NYC (Arya Health x Twilio AI Startup Searchlight) **Track focus:** Flow A — Pre-Appointment Intake (per team brainstorm, chosen over Flow B for its stronger clinical/guardrail story) **Deadline:** Jul 11, 2026, 3:30pm EDT **Status:** Build-in-progress spec — scoped to what ships in the remaining window, not a full roadmap

---

## **1\. Problem Statement**

Patients book appointments online (Zocdoc-style) or through referrals, but specialist intake still often happens through paper forms, portals, or repeated verbal questioning at check-in. The clinic usually already has some context - patient identity, appointment details, scheduling reason, insurance on file, or referral notes - but the patient is still asked to start from scratch. Front-desk staff chase missing or stale fields, clinicians start visits without an updated pre-chart, and patients experience friction before care begins.

**Who's affected:** patients (friction, repeated questions), front-desk staff (manual chasing), clinicians (incomplete charts at visit start).

**Cost of not solving it:** wasted staff time, incomplete or stale pre-visit charts, worse patient experience, and a slower path to the visit actually starting on time.

## **2\. Goals**

1. Verify the patient, appointment, and clinic/specialist context using information already available to the clinic.
2. Collect only information that is missing from the known clinic context, stale or needing patient confirmation, safety-relevant for the upcoming visit, or directly relevant to the patient's stated reason for visit.
3. Ask the patient to update known clinical/admin information rather than recollecting it from scratch, especially medications, allergies, insurance, contact information, and visit reason.
4. Produce a structured pre-visit summary that is available to clinic staff before the appointment and viewable in a demo dashboard by the time the call ends.
5. Avoid silent blanks by marking each required item as `preloaded`, `verified`, `updated`, `captured`, `patient_declined`, `unable_to_capture`, or `not_applicable`.
6. Patient receives a confirmation (SMS or email) summarizing what was captured or updated, within 60 seconds of call end.

## **3\. Non-Goals (explicitly out of scope for this build)**

* **No clinical judgment.** The agent never diagnoses, triages, or gives medical advice — it only collects self-reported information. Rationale: safety, and out of scope for a data-collection agent.  
* **No insurance eligibility adjudication.** It verifies or updates insurance info as stated; it does not verify coverage. Rationale: requires payer API integration, not feasible in the window.  
* **No live EHR integration.** A real EHR (Epic, Athena, etc.) integration is not achievable in hours. A mock EHR (Supabase table \+ simple dashboard) stands in, with the integration point clearly designed as a swap-in.  
* **No autonomous rescheduling.** The agent cannot move or cancel appointments. Rationale: no-goal explicitly stated in team doc; too risky for demo.  
* **No outbound calling to real patient phone numbers during judging** unless a judge opts in live — demo uses the team's own verified numbers or a fixed demo line. Rationale: telephony compliance and Twilio trial number restrictions.

## **4\. Intake Data Schema (the contract the whole system is built around)**

This is the single source of truth. Every conversation state, prompt, and DB column maps back to this. The product assumes the clinic or specialist has some preloaded context before the call, and the agent's job is to verify, update, or fill only the gaps that matter for the visit.

### **4.1 Preloaded Clinic Context**

These fields may be present before the call from scheduling, referral, or a mock EHR record. The agent should verify or reference them when useful, not recollect them from scratch.

| Context group | Fields | Required for MVP? |
| ----- | ----- | ----- |
| Patient identity | full name, date of birth, phone | Yes |
| Appointment context | appointment date/time, clinic, specialist/provider, appointment type | Yes |
| Known reason/referral context | booking reason, referral note, referring provider if already present | P1 for demo richness; not patient-facing MVP intake |
| Existing admin info | insurance on file, preferred contact method, preferred language if known | Yes, but verify/update only if missing or stale |
| Existing clinical info | known medications, allergies, relevant conditions if available | Yes, but ask for updates rather than recollecting from scratch |

### **4.2 Call-Verified / Call-Collected Intake**

These are the items the call must resolve for the pre-visit summary. Resolution can mean verifying known data, updating stale data, capturing missing data, or marking why it could not be resolved.

| Field group | Fields | Required for MVP? |
| ----- | ----- | ----- |
| Identity verification | date of birth or clinic-approved verification method | Yes |
| Appointment verification | appointment date/time, clinic/specialist, appointment type | Yes |
| Visit reason update | patient-stated reason in their own words, closest structured category, onset/duration if relevant, what changed since booking, visit goal | Yes |
| Medication update | current medications, additions/removals since last record, unknowns | Yes |
| Allergy update | known allergies, new allergies, reaction if volunteered | Yes |
| Relevant history update | only conditions, procedures, or events relevant to this visit | Yes |
| Insurance/contact update | insurance and best callback/contact method only if missing, stale, or needed for confirmation | Yes |
| Patient concerns/questions | questions or concerns the patient wants the specialist to know before the visit | P1 |
| Emergency contact | name, relationship, phone | P1 or clinic-configurable; not core to specialist pre-charting MVP |
| Social history | smoking/alcohol use, occupation, or other specialty-specific questions | P1 or clinic-configurable |

Every call-resolved item has one of these states: `preloaded`, `verified`, `updated`, `captured`, `patient_declined`, `unable_to_capture`, or `not_applicable`. No required item is ever silently blank - this is the core "no silent data loss" acceptance bar.

Consent/disclosure is not an ordinary intake field. It is a P0 guardrail state: the disclosure must be played and logged under the chosen consent policy before medical intake begins.

## **5\. Architecture**

Twilio Voice (inbound trigger / outbound test call)  
        │  Media Stream (bidirectional audio, WebSocket)  
        ▼  
Agent Orchestrator (Node.js/Python service)  
        │  
        ├─► STT (Deepgram or Twilio built-in STT) — streaming transcription  
        ├─► Conversation State Machine \+ LLM (Claude, via Anthropic API)  
        │        \- system prompt \= clinical intake interviewer persona \+ guardrails  
        │        \- function/tool calls to update structured intake record per turn  
        ├─► TTS (ElevenLabs or Twilio \<Say\>/Polly) — streamed back to caller  
        │  
        ▼  
Structured Intake Record (Supabase/Postgres)  
        │  
        ├─► Mock EHR Dashboard (simple web view, read-only, "clinic side")  
        └─► Confirmation dispatch (Twilio SMS to patient with summary)

**Why this shape:** Twilio is mandatory for prize eligibility (telephony). An LLM-driven state machine (rather than a rigid IVR tree) is what makes the conversation feel natural while still guaranteeing every required item is resolved. The LLM is doing the *talking*, the state machine is doing the *bookkeeping*, and preloaded context determines what should be verified, updated, skipped, or asked.

**Agent framework choice:** don't hand-roll turn management from scratch. Use a thin orchestration layer (LangGraph, or even a simple Python state loop) around Claude tool calls — one tool per intake field group, called as the conversation naturally surfaces that info, so the LLM can go conversational/non-linear (patient volunteers insurance info before being asked) without breaking the schema.

## **6\. Conversation Design (the UX bar)**

Judging weights "UI/UX" and "Idea Uniqueness" — the conversation itself *is* the product here, so this section is P0, not filler.

**Design principles:**

* Open with a warm, human framing, not "Please state your date of birth" robocall energy. E.g. confirm identity and appointment, then transition naturally into "before your visit on \[date\], I just need to confirm a few updates so your specialist has everything ready."  
* Let the patient talk in their own words for chief complaint and history; the agent extracts structured data via tool calls rather than forcing multiple-choice answers.  
* Confirm-back pattern for anything safety-relevant (medications, allergies): agent repeats what it heard before moving on. This doubles as the guardrail against mis-transcription.  
* Graceful handling: if patient says "I don't know" or declines, agent marks `patient_declined` and moves on without pressing — no dead ends, no infinite retry loops.  
* Ask for updates, not repetition: when a field is already known, the agent should say what the clinic has on file and ask whether anything changed.
* Voicemail/no-answer detection: if the call reaches voicemail, agent leaves a brief callback message rather than attempting the interview to a machine.  
* Hard interrupt handling: patient can barge in / interrupt the agent mid-sentence (this is table stakes for the call to feel human, not a nice-to-have).

**Consent script (must play verbatim, early in call):** a short, clear statement that the call is being recorded for the purpose of completing intake, info will be shared with their care team, and they can decline any question. This is the P0 HIPAA-adjacent guardrail — treat it as a required gate before any medical info is collected, not an afterthought.

## **7\. Requirements**

_Live delivery status and sequencing for these items: see [ROADMAP.md](./ROADMAP.md)._

### **Must-Have (P0) — cannot demo without these**

* \[ \] Twilio outbound call successfully connects and streams audio bidirectionally  
* \[ \] STT transcription accurate enough for structured field extraction in a live demo environment  
* \[ \] LLM-driven conversation resolves all P0 call-verified items from Section 4 in one call  
* \[ \] Consent/disclosure script plays and is logged before medical questions begin  
* \[ \] Structured record written to Supabase, viewable on a live dashboard by end of call  
* \[ \] Confirmation SMS sent to patient with a summary of captured or updated info  
* \[ \] Interrupt handling (patient can talk over agent without breaking the flow)  
* \[ \] Idempotent write — a dropped/reconnected call does not double-write or corrupt the record

### **Nice-to-Have (P1) — build if P0 is done with time to spare**

* \[ \] Patient concerns/questions for the specialist  
* \[x\] Specialty-specific question packs, including social history where clinically relevant — **built under beads epic `c78`; offline smokes pass; live validation tracked in [ROADMAP.md](./ROADMAP.md)**
* \[ \] Multi-language support (at least Spanish, since NYC demo audience)  
* \[ \] Live "call in progress" view on the dashboard (fields populating in real time as the call happens) — strong demo visual  
* \[ \] Retry logic with a graceful re-ask if STT confidence is low, rather than guessing — **selected P1 design; see Section 15**

### **Future Considerations (P2) — do not build, but design so these aren't blocked later**

* Flow B (waitlist rescue) reusing the same orchestrator  
* Real EHR/Zocdoc integration via FHIR  
* Insurance eligibility verification API  
* Clinic-configurable question sets per specialty — **the Section 14 pack model lays the foundation; full clinic-level configuration remains P2**
* Deeper referral-document ingestion and summarization

## **8\. Acceptance Criteria (per P0 requirement, checklist format)**

* \[ \] Given a patient answers the call, when the agent greets them, then it verifies identity and appointment/specialist context before proceeding  
* \[ \] Given the consent/disclosure script has played, when the consent policy is satisfied, then the state machine logs the disclosure/consent state before any medical-history tool call fires  
* \[ \] Given a known field is preloaded, when the agent reaches that topic, then it asks whether the information is still accurate or needs an update instead of recollecting it from scratch
* \[ \] Given a field is not missing, stale, safety-relevant, or visit-relevant, when the intake plan is built, then the agent does not ask it during the call
* \[ \] Given the patient interrupts mid-sentence, when they start speaking, then the agent stops talking and listens (barge-in works)  
* \[ \] Given a field the patient declines to answer, when they say "I'd rather not say," then that field is marked `patient_declined`, not left null, and the interview continues  
* \[ \] Given the call ends (patient hangs up or interview completes), when the final record is written, then it appears on the dashboard within 5 seconds  
* \[ \] Given the call completes, when 60 seconds pass, then the patient has received a confirmation SMS  
* \[ \] Given a call drops and Twilio retries/reconnects, when the record is written again, then no duplicate or corrupted record is created

## **9\. Success Metrics (demo-context, not production)**

**Leading (measurable live during judging):**

* Task completion rate: 1 full live/recorded call resolves all P0 pre-visit items — target 100% for the demo call itself  
* Turn-taking latency: subjectively natural, target under \~1.5s agent response time  
* Zero silent data loss: every required item in a completed call is in one of the defined resolution states

**Lagging (part of the pitch narrative, not measured live):**

* Business case carried over from the brainstorm doc: reducing per-patient front-desk intake time and improving chart completeness at visit start  
* Tie to Flow B's $150B/year no-show economics as the "why this matters at scale" close, even though Flow B isn't built

## **10\. Guardrails / Security Notes (judged criterion: Technical Implementation)**

* No diagnosis or clinical advice — system prompt explicitly constrains the agent to data collection only, with a hard refusal pattern if the patient asks something clinical ("I can't advise on that, your doctor will review this with you at your visit").  
* Emergency language handling: if the patient describes something that sounds like an active emergency (chest pain, can't breathe, etc.) during free-text chief complaint, the agent breaks script and tells them to hang up and call 911 — this is a hard-coded interrupt, not left to the LLM's discretion alone. Build this as a keyword/classifier pre-check on transcribed text before it reaches the conversational LLM turn.  
* PII handling: don't log raw audio or full transcripts to any third-party analytics; store only structured fields plus a redacted transcript if needed for debugging.  
* Twilio call recording (if enabled) disclosed via the consent script, not silent.

## **11\. Open Questions**

* **Blocking, engineering:** STT provider — Twilio's built-in vs. Deepgram streaming. Deepgram is likely more accurate but adds a hop; decide based on whichever you can wire up fastest given the clock.  
* **Blocking, engineering:** TTS provider — ElevenLabs voice quality is noticeably better for the "engaging conversation" UX bar but Twilio `<Say>` is zero-setup. If time is under 2 hours remaining, default to Twilio `<Say>` and don't burn time on ElevenLabs integration.  
* **Non-blocking, team:** Does the demo use a live call to a judge's/team's phone, or a pre-recorded call played back? Live is a stronger demo if reliable; have a recorded backup regardless.  
* **Non-blocking, team:** Exact chief-complaint category list — can be finalized during the interview script drafting step, doesn't block infra setup.

## **12\. Timeline Considerations — Hour-by-Hour Given the Clock**

This assumes roughly 4 hours to the 3:30pm EDT deadline. Adjust the anchor time, not the sequence, if less/more remains.

| Time block | Focus |
| ----- | ----- |
| Hour 1 | Twilio account/number setup, Media Streams webhook scaffolding, Supabase schema from Section 4, preloaded demo patient context, skeleton orchestrator that can hold a call open and echo audio |
| Hour 2 | Wire STT → LLM (Claude) tool-calling loop → TTS. Get one full field (e.g. name \+ DOB confirmation) working end-to-end on a real call |
| Hour 3 | Fill out the rest of the P0 conversation flow (Section 7 checklist), consent script, interrupt handling, dashboard view, confirmation SMS |
| Last \~30–45 min | Freeze features. Run the acceptance checklist (Section 8\) against a real test call. Prep the live/backup demo call and the team explanation narrative (problem → $150B framing → live call → dashboard) |

**Hard cutoff rule:** if P1 items (Section 7\) aren't started by the top of the last hour, cut them. A complete, reliable P0 flow beats a broken P1 feature every time in front of judges.

## **13\. Judging Alignment (for the pitch)**

| Criterion | How this PRD addresses it |
| ----- | ----- |
| Technical Implementation | Real Twilio telephony, streaming STT/TTS, tool-calling state machine, idempotent writes, guardrails (Section 10\) |
| Idea Uniqueness | Conversational (not IVR-tree) intake that adapts to how the patient naturally talks, with the $150B no-show framing as the larger opportunity |
| Team Explanation | Clear before/after: repeated forms and stale context → updated pre-chart before the visit starts |
| UI/UX | The call itself is the UX (Section 6); dashboard gives judges something visual beyond just audio |

---

## **14\. Specialty Question Packs — Shipped Roadmap Feature**

**Status:** Built and closed under beads epic `c78` on 2026-07-27 after the specialist pre-visit intake epic. Offline smoke tests passed. Live validation across Twilio, Gemini, Supabase, ElevenLabs, dashboard, and confirmation paths is tracked in [ROADMAP.md](./ROADMAP.md) under beads epic `8ar`.

**Goal:** Make the intake question set adapt to the appointment's specialty instead of the current one-size-fits-all flow. A *question pack* is a small, declarative overlay on the Section 4 intake schema that, for a given specialty: (a) turns on otherwise-optional topics (social/lifestyle history, patient questions for the specialist), (b) adds a short block of specialty-specific interviewer guidance to the system prompt, and (c) tailors the structured reason-for-visit categories. Packs never add new field keys or new tools — they only change which existing topics are active and how the agent is steered, so the single-source-of-truth schema and the cached tool declarations stay intact.

**Initial demo specialties:**

* **Cardiology** — unchanged; the existing base flow and the current three demo patients.
* **Dermatology** — activates social/lifestyle history; guidance to capture the skin concern in the patient's own words (location, duration, change in size/color/bleeding), sun-exposure history, and family history of skin cancer.
* **Dialysis / nephrology** — activates social/lifestyle history and patient questions; guidance to confirm dialysis schedule and logistics, the patient's own description of their access site, recent changes, and questions for the care team. The medication-heavy dialysis population is already covered by the base medication step.

**Design decisions (resolved 2026-07-27):**

1. **One shared reason-for-visit category list**, with the agent steered by prompt toward the relevant subset — rather than a separate list per specialty. The tool schema is built once at server start and reused every call; per-specialty lists would force a rebuild each call and add latency against Twilio's ~15s webhook deadline. The category is a soft filing label, so occasional cross-specialty mislabeling is low-stakes.
2. **Active-pack persistence via the existing record**, stored inside `preloaded_context` as a namespaced `__active_pack__ = { id, requiredKeys }`. No database migration; the dashboard reads it back so its "ready for check-in" math matches the agent's completion logic.
3. **Pack resolution from an explicit `specialty` attribute** on the patient/appointment (mapped to a pack id; default = base). Structured so a future clinic-level configuration can layer on without rework — this is the on-ramp for the P2 "clinic-configurable question sets" item.
4. **Demo patients are live-call-ready:** the two new patients get their own phone-number settings (like the existing demo patients) so they can be dialed live. Numbers must be verified in Twilio per the Section 3 telephony constraint; this is a demo-setup cost, not a code dependency.
5. **Whole-topic activation:** when a pack turns a topic on, every field in it must reach a resolution state; fields that do not apply to a given patient are marked `not_applicable` rather than skipped, preserving the Section 4 "no silent blanks" bar.

**Invariants preserved:** the AI/recording disclosure gate still precedes all medical intake; no silent blanks; deterministic completion (a call ends only when every active required topic is resolved); idempotent writes keyed by `CallSid`; offline-testable pack logic.

**Delivery sequence & live status:** tracked in [ROADMAP.md](./ROADMAP.md) and beads (`bd ready` shows the next actionable task) — kept there rather than duplicated here.

---

## **15\. Low-Confidence Speech Re-Ask — Selected P1 Design**

**Status:** Design direction selected 2026-07-28; not implemented. This is the next offline-buildable P1 while live validation waits on environment credentials. The delivery sequence belongs in [ROADMAP.md](./ROADMAP.md) and beads once the work is created.

**Goal:** Add a deterministic pre-LLM speech confidence layer so uncertain Twilio speech is repeated, clarified, or safely failed before Gemini extracts structured intake fields. The feature should improve correctness and auditability, not shorten latency. Confident turns add only local classification overhead; low-confidence turns intentionally add one extra phone turn when guessing would be unsafe.

**Product behavior:**

* **Confident speech:** pass through to the conversation engine with no user-visible change.
* **Empty, tiny, or obvious noise:** ask a natural repeat prompt: "Sorry, I missed that. Could you say it once more?"
* **Usable but low-confidence narrative:** ask for a repeat without exposing ASR uncertainty: "Could you say that one more time so I get it right?"
* **Short high-risk values:** use a precise confirmation only when readback helps, for example: "Just to confirm, was that atorvastatin?" High-risk topics include consent, appointment verification, medications, allergies/reactions, DOB or identity, phone number, insurance IDs, and contact preference.
* **Corrections:** when the patient corrects a low-confidence readback, send the correction to Gemini rather than the original uncertain transcript.
* **Explicit emergency language:** do not suppress it because of low confidence; continue to trigger the emergency guardrail.
* **Ambiguous safety language:** ask one direct clarification: "I may have heard something urgent, like chest pain or trouble breathing. Are you having a medical emergency right now?"
* **Retry exhaustion:** avoid loops. During interview, one failed re-ask should mark the targeted item `unable_to_capture` or move it to office follow-up; repeated global no-input/noise should end gracefully and tell the patient the office can follow up.

**Technical design:**

1. Add a pure helper module, likely `server/src/lib/speechConfidence.js`, that parses Twilio confidence and classifies each speech turn as `accept`, `repeat`, `confirm_short_value`, `safety_clarify`, or `fail`.
2. Intercept `SpeechResult` and `Confidence` in `/voice/gather` before calling the Gemini-backed conversation turn.
3. Bypass the confidence layer for DTMF digits so DOB keypad verification stays deterministic.
4. Store per-call clarification state in memory, keyed by `CallSid`, with the original transcript, confidence, retry count, prompt context, and created-at timestamp.
5. Keep the first version coarse-grained: use stage/topic hints and known high-risk moments instead of a large conversation-state refactor.
6. Do not change the database schema. Use existing `call_events` for audit evidence.
7. Future refinement can let `conversation.js` return `speechContext` metadata such as risk level and expected topic for the next patient response.

**Initial thresholds:**

* Noise threshold: confidence below `0.35`, empty text, or tiny/noise fragments.
* General low-confidence threshold: below `0.55`.
* High-risk confirmation threshold: below `0.75`.
* Missing Twilio confidence is not automatically low-confidence; fall back to text/noise heuristics.

**Events for auditability:** log outcomes such as `speech_low_confidence`, `speech_reask_prompted`, `speech_reask_resolved`, `speech_reask_failed`, and safety clarification events. Payloads should include confidence, classification, retry count, prompt context, and a short excerpt rather than duplicating full transcripts beyond existing speech-result logging.

**Dashboard scope:** no dashboard UI change is required for this P1. Acceptance can be proven through offline tests and `call_events`. A later dashboard enhancement can expose "speech clarified" or "office follow-up needed" if useful.

**Offline test strategy:** add deterministic classifier tests that do not require Twilio, Gemini, Supabase, or live credentials. Test empty/noise, low-confidence narrative, high-risk thresholds, DTMF bypass, explicit emergency handling, ambiguous safety clarification, retry exhaustion, confirmation, and correction behavior. After implementation, run the new classifier test plus existing offline conversation and Supabase smoke tests with live skips.

**Proposed delivery sequence:**

| Step | Task | Priority | Depends on |
|------|------|----------|------------|
| 1 | Design approval: thresholds, retry policy, and call copy | P1 | — |
| 2 | Add pure speech-confidence classifier | P1 | 1 |
| 3 | Add offline classifier tests | P1 | 2 |
| 4 | Integrate confidence layer into `/voice/gather` | P1 | 3 |
| 5 | Add safer high-risk and emergency behavior | P1 | 4 |
| 6 | Add event logging for auditability | P1 | 4 |
| 7 | Regression verification | P1 | 5, 6 |
