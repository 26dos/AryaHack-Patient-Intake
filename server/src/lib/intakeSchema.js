// Single source of truth for the intake data contract (PRD Section 4).
// Every call-resolved field lives flat in the `fields` JSONB column as:
//   { [key]: { value: any, state: FIELD_STATES[number], updated_at: iso } }

export const FIELD_STATES = [
  'preloaded',
  'verified',
  'updated',
  'captured',
  'patient_declined',
  'unable_to_capture',
  'not_applicable',
];

export const PRELOADED_CONTEXT_GROUPS = [
  {
    group: 'patient_identity',
    fields: ['full_name', 'date_of_birth', 'phone_number'],
  },
  {
    group: 'appointment_context',
    fields: ['appointment_datetime', 'clinic_name', 'specialist_name', 'appointment_type'],
  },
  {
    group: 'known_reason_referral_context',
    patientFacing: false,
    fields: ['booking_reason', 'referral_note', 'referring_provider_name'],
  },
  {
    group: 'existing_admin_info',
    fields: ['insurance_payer_name', 'insurance_member_id', 'insurance_group_number', 'preferred_contact_method', 'preferred_language'],
  },
  {
    group: 'existing_clinical_info',
    fields: ['current_medications', 'known_allergies', 'relevant_conditions'],
  },
];

export const FIELD_GROUPS = [
  {
    group: 'identity_verification',
    tool: 'record_identity_verification',
    required: true,
    fields: ['date_of_birth'],
  },
  {
    group: 'appointment_verification',
    tool: 'record_appointment_verification',
    required: true,
    fields: ['appointment_datetime', 'clinic_name', 'specialist_name', 'appointment_type'],
  },
  {
    group: 'visit_reason_update',
    tool: 'record_visit_reason_update',
    required: true,
    fields: ['patient_stated_reason', 'chief_complaint_category', 'onset_duration', 'changes_since_booking', 'visit_goal'],
  },
  {
    group: 'medication_update',
    tool: 'record_medication_update',
    required: true,
    fields: ['current_medications', 'medication_changes', 'medication_unknowns'],
  },
  {
    group: 'allergy_update',
    tool: 'record_allergy_update',
    required: true,
    fields: ['known_allergies', 'new_allergies', 'allergy_reactions'],
  },
  {
    group: 'relevant_history_update',
    tool: 'record_relevant_history_update',
    required: true,
    fields: ['relevant_conditions', 'relevant_procedures', 'relevant_events'],
  },
  {
    group: 'conditional_admin_update',
    tool: 'record_conditional_admin_update',
    required: true,
    fields: ['insurance_payer_name', 'insurance_member_id', 'insurance_group_number', 'preferred_contact_method', 'preferred_language'],
  },
  {
    group: 'patient_questions',
    tool: 'record_patient_questions',
    required: false, // P1
    fields: ['patient_questions'],
  },
  {
    group: 'emergency_contact_update',
    tool: 'record_emergency_contact_update',
    required: false, // P1 / clinic-configurable, not core P0
    fields: ['emergency_contact_name', 'emergency_contact_relationship', 'emergency_contact_phone'],
  },
  {
    group: 'social_history_update',
    tool: 'record_social_history_update',
    required: false, // P1 / specialty-configurable, not core P0
    fields: ['smoking_alcohol', 'occupation', 'specialty_specific_social_history'],
  },
];

export const CHIEF_COMPLAINT_CATEGORIES = [
  'general_checkup',
  'follow_up',
  'acute_illness',
  'injury',
  'chronic_condition_management',
  'mental_health',
  'preventive_screening',
  'medication_refill',
  'other',
];

export const ALL_FIELD_KEYS = FIELD_GROUPS.flatMap((g) => g.fields);
export const REQUIRED_P0_FIELD_KEYS = FIELD_GROUPS.filter((g) => g.required).flatMap((g) => g.fields);

export const EMERGENCY_KEYWORDS_MESSAGE =
  "It sounds like this may be a medical emergency. Please hang up right now and call 911, or go to your nearest emergency room. This call is not monitored for emergencies.";

export const CONSENT_SCRIPT =
  "Before we begin, please note that you are speaking with an automated AI assistant. " +
  "This call may be recorded and transcribed. " +
  "The information you provide will be collected and used by Hope Clinic to assist with scheduling, intake, and providing services. " +
  "By continuing, you consent to the recording, transcription, and use of this information as described in our privacy notice. " +
  "You may end the call at any time.";
