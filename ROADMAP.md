# Roadmap — AI Voice Pre-Visit Intake Agent

The delivery view: what's shipped, what's being built now, and what's queued — tracking **sequence and status**. The detailed product spec lives in [PRD.md](./PRD.md); the executable task list lives in **beads** (`bd ready`, `bd list`). Where this file and the PRD overlap, the PRD is the source of truth for *what and why*; this file owns *what's next and in what order*.

_Last updated: 2026-07-28._

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
- **Specialty question packs** (beads epic `c78`, closed) — cardiology base behavior plus dermatology and dialysis / nephrology overlays, pack-aware conversation guidance, completeness, persistence, dashboard readiness, demo data, static HTML labels, offline smokes, and clinic-configurable keying design. Spec: [PRD.md](./PRD.md) Section 14.
  - *Validation status:* implemented and passing offline smoke tests; live specialty-pack validation is tracked in epic `8ar`.

## Now — Live demo validation · beads epic `8ar`

Validate the completed specialist intake and specialty question pack work against the live Twilio, Gemini, Supabase, ElevenLabs, dashboard, and confirmation paths before starting the next product epic.

Build order (each unlocks when its prerequisites close; start at `8ar.1`):

| Bead | Task | Priority | Depends on |
|------|------|----------|------------|
| `8ar.1` | Verify live environment readiness | P1 | — |
| `8ar.2` | Run live service smoke tests | P1 | `8ar.1` |
| `8ar.3` | Validate one full cardiology live call | P1 | `8ar.2` |
| `8ar.4` | Validate dermatology and dialysis live call paths | P1 | `8ar.2` |
| `8ar.5` | Capture live-run findings and follow-up beads | P1 | `8ar.3`, `8ar.4` |

## Next (selected P1 design, not started)

Descriptions in [PRD.md](./PRD.md) Section 7 (Nice-to-Have).

- **Low-confidence speech re-ask** — selected as the next offline-buildable P1 while live validation waits on environment credentials. Design: [PRD.md](./PRD.md) Section 15.

Proposed build order (create beads only after explicit approval):

| Step | Task | Priority | Depends on |
|------|------|----------|------------|
| 1 | Design approval: thresholds, retry policy, and call copy | P1 | — |
| 2 | Add pure speech-confidence classifier | P1 | 1 |
| 3 | Add offline classifier tests | P1 | 2 |
| 4 | Integrate confidence layer into `/voice/gather` | P1 | 3 |
| 5 | Add safer high-risk and emergency behavior | P1 | 4 |
| 6 | Add event logging for auditability | P1 | 4 |
| 7 | Regression verification | P1 | 5, 6 |

## Next (agreed P1 backlog, not started)

- **Multi-language support (Spanish first)** — bilingual prompts, TTS voice, and confirmation copy; motivated by the NYC audience.
- **Live "call-in-progress" dashboard** — required fields populating in real time during the call (today it polls every ~3s).
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
