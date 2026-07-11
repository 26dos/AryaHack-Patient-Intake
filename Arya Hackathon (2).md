# **Idea: AI Voice Agent for Patient Intake & Waitlist Rescue**

## **1\. Product Summary**

  Build a HIPAA-ready voice AI intake agent that calls patients before a scheduled  
  appointment, conducts a structured intake interview, confirms appointment details,  
  captures patient history, generates a completed intake form, syncs data to the clinic’s  
  EHR/practice-management system, and sends the patient a confirmation copy.

  The intake baseline should cover demographics, emergency contact, insurance, medical  
  history, current symptoms, social history, PCP/referral details, and consent/HIPAA  
  acknowledgments, matching common patient intake form requirements described by Freed.  [https://www.getfreed.ai/resources/patient-intake-form-template](https://www.getfreed.ai/resources/patient-intake-form-template) 

## **2\. Problem**

Two connected pain points in healthcare scheduling:

* **Patient intake is manual and slow.** Front-desk staff (or the patient themselves) spend time filling out repetitive intake forms before appointments, often via clipboard or clunky portals.   
  * Pain point: Patients often book appointments online but still complete intake through paper forms, portal friction, and repeated questioning. Clinics lose staff time chasing missing fields, clinicians enter visits without complete context, and patients experience administrative friction before care begins.  
    * Patients are sent a long tedious intake form  
    * When they arrive at their appointment, the physicians need to repeat the same questions  
* **Cancellations \= lost revenue.** When a slot opens up, clinics rarely refill it fast enough. No-shows and empty slots cost the healthcare system an estimated **\~$150B/year**.

## **3\. Core Concept** 

A voice AI agent (via Twilio) that plugs into the scheduling lifecycle at two moments:

1. **Before the appointment** — calls the patient to conduct the intake interview, so the visit starts with a completed chart instead of a blank form.   
2. **When a cancellation happens** — immediately works the waitlist by phone to refill the slot in near real-time, instead of losing it.

Both flows share the same underlying voice agent infrastructure, differing mainly in *purpose* and *downstream integration*.

## **4\. User Flows \- Focus an MVP on flow A first**

### **Flow A — Pre-Appointment Intake**

Zocdoc (or similar) → patient finds a provider online → books an appointment  
        → provider confirms date, time, and chief complaint  
        → \[Before appointment\] AI agent calls the patient  
        → patient picks up → agent conducts intake interview  
        → call ends  
        → collected info feeds into clinic's EHR / practice-management system  
        → patient receives a confirmation \+ the filled-out form

Reference for intake form structure: [Freed AI — Patient Intake Form Template](https://www.getfreed.ai/resources/patient-intake-form-template)

### **Flow B — Waitlist Rescue**

Cancellation hits the calendar  
        → agent immediately calls down the waitlist  
        → first patient to say "yes" gets the slot  
        → calendar updates live (demoable on a projector)

* Empty slots are pure lost revenue — this flow reframes the pitch as **"we refill slots in 90 seconds instead of losing them."**  
* Architecturally, this is close to a Vapi-style voice → Google Calendar → Supabase build (e.g. a restaurant reservation bot), repurposed for healthcare — making it the **fastest path to a working demo**.  
* **Weak point:** the guardrail/clinical story is thinner here since it's an ops workflow, not a clinical one. Compensate with a strong **reliability** story instead:  
  * Idempotent booking (no double-books)  
  * SMS confirmations  
  * Graceful voicemail handling

## **5\. Design Pillars (Non-Negotiables)**

### Goals 

* **Reliability, guardrails, security, and scalability** — the prerequisite bar, not extras.  
* **Strong voice AI solution architecture** — clean orchestration of telephony, STT/TTS, and agent logic.  
* **Best-in-class user experience** — provide a warm, trustworthy phone experience that feels human, fast, and respectful  
* **PII / privacy & data security** — patient data (identity, health info, insurance) must be handled with proper safeguards throughout the call and in storage.  
* **Downstream integration readiness** — designed to eventually plug into platforms like **Zocdoc** and clinic **EHR/practice-management systems**, not built as a standalone toy.

## No-Goals for MVP

* No diagnosis, treatment recommendations, clinical triage, emergency advice beyond  escalation instructions, insurance eligibility adjudication, payment collection, or autonomous appointment rescheduling unless explicitly approved by clinic configuration.

## **6\. Strengths & Weaknesses**

|  | Flow A: Intake | Flow B: Waitlist Rescue |
| ----- | ----- | ----- |
| **Strength** | Clear clinical/guardrail story (handling patient health data, chief complaints) | Fastest to build; reuses proven voice-booking architecture; clean, quantifiable business pitch ($150B/year problem) |
| **Weakness** | More complex conversation design (medical intake questions, sensitive data) | Thinner guardrail/clinical narrative — needs a reliability-focused pitch instead |

## **7\. Open Questions / Next Steps**

* Decide whether to build both flows or focus the demo on one (Waitlist Rescue is faster to ship; Intake has a stronger clinical guardrails story).  
* Define the exact EHR/practice-management integration point (mock vs. real API).  
* Design the intake question set based on the Freed AI template as a starting point.  
* Confirm Twilio call flow: outbound call trigger, voicemail detection, confirmation SMS.

