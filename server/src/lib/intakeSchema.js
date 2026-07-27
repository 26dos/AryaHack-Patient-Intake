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

// Specialty question packs layer on top of the shared base contract above.
// A pack can turn otherwise-optional FIELD_GROUPS on for a specialty, suggest
// extra chief-complaint categories, and carry short guidance strings that are
// injected into the system prompt at call time. Packs only shape what data is
// collected and how it is described in the patient's own words - they never add
// diagnostic, assessment, or advice behavior.
//
// Each pack: {
//   id,                          // stable pack identifier
//   label,                       // human-readable name
//   activateGroups: string[],    // FIELD_GROUPS `group` names to mark required
//   chiefComplaintCategories,    // extra chief-complaint categories for this pack
//   guidance: string[],          // short prompt lines (data collection only)
//   fieldGuidance: {[fieldKey]: string}, // per-field prompt hints
// }
export const QUESTION_PACKS = {
  base: {
    id: 'base',
    label: 'General intake',
    activateGroups: [],
    chiefComplaintCategories: [],
    guidance: [],
    fieldGuidance: {},
  },
  cardiology: {
    id: 'cardiology',
    label: 'Cardiology',
    // Intentionally empty so cardiology's required set equals the base set
    // (backward-compatibility anchor).
    activateGroups: [],
    chiefComplaintCategories: [],
    guidance: [],
    fieldGuidance: {},
  },
  dermatology: {
    id: 'dermatology',
    label: 'Dermatology',
    activateGroups: ['social_history_update'],
    chiefComplaintCategories: ['skin_lesion_or_rash', 'skin_cancer_screening', 'cosmetic_concern'],
    guidance: [
      "Have the patient describe the skin concern in their own words - location, how long it has been there, and any change in size, color, or bleeding - without assessing it.",
    ],
    fieldGuidance: {
      specialty_specific_social_history:
        "Capture sun-exposure and tanning history and any personal or family history of skin cancer.",
      occupation:
        "Note whether the occupation involves outdoor/sun exposure or chemical exposure relevant to the skin.",
    },
  },
  dialysis: {
    id: 'dialysis',
    label: 'Dialysis',
    activateGroups: ['social_history_update', 'patient_questions'],
    chiefComplaintCategories: ['dialysis_treatment_review', 'access_site_concern', 'fluid_or_diet_management'],
    guidance: [
      "Confirm the patient's dialysis schedule and how they get to sessions, have them describe their access site in their own words, note recent changes, and capture questions for the care team - data collection only, never advise.",
    ],
    fieldGuidance: {
      specialty_specific_social_history:
        "Capture transportation to dialysis, home support, and any diet or fluid context in the patient's own words.",
    },
  },
};

export const DEFAULT_PACK_ID = 'base';

// Maps a lowercase specialty string to a pack id. Renal-specialty aliases point
// at the dialysis pack.
export const SPECIALTY_TO_PACK = {
  cardiology: 'cardiology',
  dermatology: 'dermatology',
  dialysis: 'dialysis',
  nephrology: 'dialysis',
  renal: 'dialysis',
};

// Resolve a pack id from either a specialty string or a context object carrying
// a `.specialty`. Null/undefined/unknown specialties fall back to the default.
export function resolvePackId(ctxOrSpecialty) {
  const specialty =
    typeof ctxOrSpecialty === 'string' ? ctxOrSpecialty : ctxOrSpecialty?.specialty;
  if (typeof specialty !== 'string') return DEFAULT_PACK_ID;
  return SPECIALTY_TO_PACK[specialty.trim().toLowerCase()] || DEFAULT_PACK_ID;
}

export function getPack(id) {
  return QUESTION_PACKS[id] || QUESTION_PACKS[DEFAULT_PACK_ID];
}

// A group is required for a pack when it is required in the base contract OR the
// pack explicitly activates it.
export function isGroupRequiredForPack(group, packId) {
  return group.required || getPack(packId).activateGroups.includes(group.group);
}

export function requiredFieldKeysForPack(packId) {
  return FIELD_GROUPS.filter((g) => isGroupRequiredForPack(g, packId)).flatMap((g) => g.fields);
}

// Deduped union of the base chief-complaint categories followed by every pack's
// extra categories, computed once at module load.
export const CHIEF_COMPLAINT_CATEGORIES_ALL = [
  ...new Set([
    ...CHIEF_COMPLAINT_CATEGORIES,
    ...Object.values(QUESTION_PACKS).flatMap((p) => p.chiefComplaintCategories),
  ]),
];
