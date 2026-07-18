// Single source of truth for the intake data contract (PRD Section 4).
// Every field lives flat in the `fields` JSONB column as:
//   { [key]: { value: any, state: 'captured'|'patient_declined'|'unable_to_capture', updated_at: iso } }

export const FIELD_STATES = ['captured', 'patient_declined', 'unable_to_capture'];

export const FIELD_GROUPS = [
  {
    group: 'identity',
    tool: 'record_identity',
    required: true,
    fields: ['full_name', 'date_of_birth', 'preferred_language'],
  },
  {
    group: 'emergency_contact',
    tool: 'record_emergency_contact',
    required: true,
    fields: ['emergency_contact_name', 'emergency_contact_relationship', 'emergency_contact_phone'],
  },
  {
    group: 'insurance',
    tool: 'record_insurance',
    required: true,
    fields: ['insurance_payer_name', 'insurance_member_id', 'insurance_group_number'],
  },
  {
    group: 'chief_complaint',
    tool: 'record_chief_complaint',
    required: true,
    fields: ['chief_complaint_text', 'chief_complaint_category'],
  },
  {
    group: 'medical_history',
    tool: 'record_medical_history',
    required: true,
    fields: ['medications', 'allergies', 'prior_conditions'],
  },
  {
    group: 'social_history',
    tool: 'record_social_history',
    required: false, // P1
    fields: ['smoking_alcohol', 'occupation'],
  },
  {
    group: 'pcp_referral',
    tool: 'record_referral',
    required: false, // P1
    fields: ['referring_provider_name'],
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
