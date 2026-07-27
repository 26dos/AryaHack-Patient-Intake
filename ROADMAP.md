# Roadmap — AI Voice Pre-Visit Intake Agent

The delivery view: what's shipped, what's being built now, and what's queued — tracking **sequence and status**. The detailed product spec lives in [PRD.md](./PRD.md); the executable task list lives in **beads** (`bd ready`, `bd list`). Where this file and the PRD overlap, the PRD is the source of truth for *what and why*; this file owns *what's next and in what order*.

_Last updated: 2026-07-27._

## How to read this

- **Shipped** — built and in the repo.
- **Now** — actively being built (has open beads).
- **Next** — agreed direction, not yet started.
- **Later** — deliberately deferred, but designed so it isn't blocked.

For the single next actionable task at any time: `bd ready`.

## Shipped

- **Base voice-intake MVP** — live Twilio call loop, Gemini tool-calling conversation, AI/recording disclosure, structured intake written to Supabase (mock EHR), front-desk dashboard, and SMS/email confirmation. Spec: [PRD.md](./PRD.md) Sections 4–10.
- **Specialist pre-visit intake** (beads epic `p0e`, closed) — preloaded clinic context, verify / update / capture resolution states, the "no silent blanks" rule, and a pre-chart readiness dashboard. Spec: [PRD.md](./PRD.md) Sections 4 & 6.
  - *Validation status:* implemented and passing the offline smoke tests; a full live run against Twilio / Gemini / Supabase is still pending credentials (carried from the epic's close note).

## Now — Specialty question packs · beads epic `c78`

Make the interview adapt to the appointment's specialty instead of one-size-fits-all: cardiology (unchanged base) plus **dermatology** and **dialysis / nephrology**, each turning on the relevant extra topics and steering the questions — with no new database changes. Full spec and the resolved design decisions: [PRD.md](./PRD.md) Section 14.

Build order (each unlocks when its prerequisites close; start at `c78.1`):

| Bead | Task | Priority | Depends on |
|------|------|----------|------------|
| `c78.1` | Pack data model (`intakeSchema.js`) | P1 | — |
| `c78.2` | Pack-aware conversation engine (`conversation.js`) | P1 | `c78.1` |
| `c78.3` | Pack-aware completeness + storage (`supabase.js`) | P1 | `c78.1` |
| `c78.4` | Voice route resolves / saves the active pack (`voice.js`) | P1 | `c78.1`, `c78.3` |
| `c78.5` | Pack-aware dashboard (`dashboard.js`) | P1 | `c78.3` |
| `c78.6` | Demo data: dermatology + dialysis patients (`demoPatients.js`) | P1 | `c78.1` |
| `c78.7` | Static demo HTML labels | P2 | `c78.5` |
| `c78.8` | Offline smoke tests | P1 | `c78.2`, `c78.3`, `c78.6` |
| `c78.9` | Stretch: clinic-configurable keying (design only) | P2 | `c78.1` |

## Next (agreed P1, not started)

Descriptions in [PRD.md](./PRD.md) Section 7 (Nice-to-Have).

- **Multi-language support (Spanish first)** — bilingual prompts, TTS voice, and confirmation copy; motivated by the NYC audience.
- **Live "call-in-progress" dashboard** — required fields populating in real time during the call (today it polls every ~3s).
- **Low-confidence speech re-ask** — graceful re-ask when speech-to-text confidence is low, instead of guessing.
- **Patient concerns / questions for the specialist** — partly picked up by the packs work (the dialysis pack turns this topic on); generalize it across specialties.

## Later (P2 / future — deferred, not blocked)

Detail in [PRD.md](./PRD.md) Section 7 (Future Considerations).

- **Flow B — waitlist rescue**, reusing the same orchestrator.
- **Real EHR / Zocdoc integration** via FHIR (Supabase is today's mock EHR).
- **Insurance eligibility verification** via a payer API.
- **Clinic-configurable question sets per specialty** — the pack model (Section 14) is the on-ramp; bead `c78.9` sketches the design.
- **Deeper referral-document ingestion and summarization.**

## Pointers

- **Spec / requirements:** [PRD.md](./PRD.md)
- **Run it:** [README.md](./README.md), [server/README.md](./server/README.md)
- **Task tracker:** beads — `bd ready` (next actionable), `bd list --all` (everything)
