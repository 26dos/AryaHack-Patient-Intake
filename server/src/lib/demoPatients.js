// Generated demo patient store.
//
// This is deliberately a local fixture database for the hackathon/demo path. The
// phone numbers can be overridden from .env so the demo roster can call real
// verified Twilio test numbers without changing source.

const GENERATED_PATIENTS = [
  {
    id: 'pat-maya-rivera',
    fullName: 'Maya Rivera',
    dateOfBirth: '1984-09-14',
    preferredLanguage: 'English',
    preferredContactMethod: 'SMS',
    emailAddress: 'maya.rivera@example.com',
    okToLeaveVoicemail: true,
    phoneEnv: 'DEMO_PATIENT_MAYA_PHONE',
    fallbackPhoneEnv: 'TEST_PATIENT_PHONE_NUMBER',
    insurancePayerName: 'Aetna',
    insuranceMemberId: 'AET4829156',
    insuranceGroupNumber: 'GRP-1048',
    insuranceLastVerifiedAt: '2026-04-03',
    appointmentDatetime: 'Thursday, July 23, 2026 at 2:30 PM',
    clinicName: 'Riverside Cardiology',
    specialistName: 'Dr. Priya Shah, MD',
    appointmentType: 'New patient cardiology consult',
    bookingReason: 'Palpitations and intermittent chest tightness during workouts',
    referralNote:
      'PCP requested cardiology evaluation after two weeks of exertional palpitations. Office EKG showed sinus rhythm.',
    referringProviderName: 'Dr. Jonah Feld, One Medical Upper West Side',
    knownMedications: [
      'Lisinopril 10 mg by mouth daily',
      'Atorvastatin 20 mg by mouth nightly',
      'Multivitamin daily',
    ],
    knownAllergies: [
      'Penicillin - rash as a child',
    ],
    relevantConditions: [
      'Hypertension',
      'Hyperlipidemia',
      'Family history of early coronary artery disease',
    ],
    lastConfirmedAt: {
      insurance_payer_name: '2026-04-03',
      insurance_member_id: '2026-04-03',
      insurance_group_number: '2026-04-03',
      current_medications: '2026-03-19',
      known_allergies: '2026-03-19',
    },
    needsConfirmation: {
      insurance_payer_name: 'Insurance was last verified before the cardiology referral.',
      insurance_member_id: 'Insurance was last verified before the cardiology referral.',
      insurance_group_number: 'Insurance was last verified before the cardiology referral.',
      current_medications: 'Medication list was last confirmed at the referring PCP visit.',
      known_allergies: 'Allergy list was last confirmed at the referring PCP visit.',
    },
  },
  {
    id: 'pat-daniel-kim',
    fullName: 'Daniel Kim',
    dateOfBirth: '1978-02-03',
    preferredLanguage: 'English',
    preferredContactMethod: 'Phone call',
    emailAddress: 'daniel.kim@example.com',
    okToLeaveVoicemail: false,
    phoneEnv: 'DEMO_PATIENT_DANIEL_PHONE',
    insurancePayerName: 'Blue Cross Blue Shield',
    insuranceMemberId: 'BCBS7732041',
    insuranceGroupNumber: 'BX-2209',
    insuranceLastVerifiedAt: '2026-07-08',
    appointmentDatetime: 'Friday, July 24, 2026 at 9:15 AM',
    clinicName: 'Riverside Cardiology',
    specialistName: 'Dr. Marcus Lee, MD',
    appointmentType: 'Electrophysiology follow-up',
    bookingReason: 'Follow-up for intermittent atrial fibrillation symptoms and medication review',
    referralNote:
      'Existing patient scheduled after remote monitor alert showed short atrial fibrillation episodes.',
    referringProviderName: 'Riverside Cardiology Device Clinic',
    knownMedications: [
      'Metoprolol succinate 50 mg by mouth daily',
      'Apixaban 5 mg by mouth twice daily',
      'Omeprazole 20 mg by mouth daily as needed',
    ],
    knownAllergies: [
      'No known drug allergies on file',
    ],
    relevantConditions: [
      'Paroxysmal atrial fibrillation',
      'Obstructive sleep apnea on CPAP',
      'Gastroesophageal reflux disease',
    ],
    lastConfirmedAt: {
      preferred_contact_method: '2025-12-12',
      current_medications: '2026-06-01',
      known_allergies: '2025-12-12',
      relevant_conditions: '2026-06-01',
    },
    needsConfirmation: {
      preferred_contact_method: 'Patient asked for fewer voicemail messages at the last visit.',
      current_medications: 'Medication list needs confirmation before anticoagulation review.',
      known_allergies: 'Allergy list is older than the most recent cardiology follow-up.',
    },
  },
  {
    id: 'pat-elena-patel',
    fullName: 'Elena Patel',
    dateOfBirth: '1991-12-22',
    preferredLanguage: 'English',
    preferredContactMethod: 'Email',
    emailAddress: 'elena.patel@example.com',
    okToLeaveVoicemail: true,
    phoneEnv: 'DEMO_PATIENT_ELENA_PHONE',
    insurancePayerName: 'UnitedHealthcare',
    insuranceMemberId: 'UHC3901847',
    insuranceGroupNumber: 'NYC-7712',
    insuranceLastVerifiedAt: '2026-07-15',
    appointmentDatetime: 'Monday, July 27, 2026 at 11:00 AM',
    clinicName: 'Riverside Cardiology',
    specialistName: 'Dr. Nisha Raman, MD',
    appointmentType: 'Post-ED cardiology follow-up',
    bookingReason: 'Emergency department follow-up after fainting episode',
    referralNote:
      'ED discharge summary recommends outpatient cardiology follow-up for syncope; troponins negative, outpatient echo suggested.',
    referringProviderName: 'Mount Sinai West Emergency Department',
    knownMedications: [
      'Sertraline 50 mg by mouth daily',
      'Albuterol inhaler, two puffs as needed',
    ],
    knownAllergies: [
      'Sulfa antibiotics - hives',
      'Latex - itching',
    ],
    relevantConditions: [
      'Syncope episode on 2026-07-12',
      'Mild intermittent asthma',
      'Anxiety',
    ],
    lastConfirmedAt: {
      insurance_payer_name: '2026-07-15',
      insurance_member_id: '2026-07-15',
      insurance_group_number: '2026-07-15',
      current_medications: '2025-11-04',
      relevant_conditions: '2026-07-12',
    },
    needsConfirmation: {
      current_medications: 'Medication list predates the emergency department visit.',
      relevant_conditions: "ED discharge details should be confirmed in the patient's own words.",
    },
  },
];

function normalizePhone(phone) {
  return String(phone || '').replace(/[^\d+]/g, '');
}

function phoneFor(patient) {
  return process.env[patient.phoneEnv] || (patient.fallbackPhoneEnv ? process.env[patient.fallbackPhoneEnv] : '') || '';
}

function joinList(items) {
  return (items || []).join('; ');
}

function preloadedField(value, patient, fieldKey, options = {}) {
  const needsConfirmationReason = patient.needsConfirmation?.[fieldKey];
  const lastConfirmedAt = patient.lastConfirmedAt?.[fieldKey];
  return {
    value,
    state: 'preloaded',
    source: options.source || 'demo_fixture',
    ...(lastConfirmedAt ? { lastConfirmedAt } : {}),
    ...(needsConfirmationReason
      ? { needsConfirmation: true, needsConfirmationReason }
      : { needsConfirmation: false }),
    ...(options.patientFacing === false ? { patientFacing: false } : {}),
    ...(options.preloadOnly ? { preloadOnly: true } : {}),
  };
}

function buildPreloadedIntakeFields(patient) {
  return {
    full_name: preloadedField(patient.fullName, patient, 'full_name', { source: 'scheduling' }),
    date_of_birth: preloadedField(patient.dateOfBirth, patient, 'date_of_birth', { source: 'scheduling' }),
    phone_number: preloadedField(patient.phoneNumber, patient, 'phone_number', { source: 'scheduling' }),
    appointment_datetime: preloadedField(patient.appointmentDatetime, patient, 'appointment_datetime', { source: 'scheduling' }),
    clinic_name: preloadedField(patient.clinicName, patient, 'clinic_name', { source: 'scheduling' }),
    specialist_name: preloadedField(patient.specialistName, patient, 'specialist_name', { source: 'scheduling' }),
    appointment_type: preloadedField(patient.appointmentType, patient, 'appointment_type', { source: 'scheduling' }),
    booking_reason: preloadedField(patient.bookingReason, patient, 'booking_reason', { source: 'online_booking' }),
    referral_note: preloadedField(patient.referralNote, patient, 'referral_note', {
      source: 'referral',
      patientFacing: false,
      preloadOnly: true,
    }),
    referring_provider_name: preloadedField(patient.referringProviderName, patient, 'referring_provider_name', {
      source: 'referral',
      patientFacing: false,
      preloadOnly: true,
    }),
    insurance_payer_name: preloadedField(patient.insurancePayerName, patient, 'insurance_payer_name', {
      source: 'mock_ehr',
    }),
    insurance_member_id: preloadedField(patient.insuranceMemberId, patient, 'insurance_member_id', {
      source: 'mock_ehr',
    }),
    insurance_group_number: preloadedField(patient.insuranceGroupNumber, patient, 'insurance_group_number', {
      source: 'mock_ehr',
    }),
    preferred_contact_method: preloadedField(patient.preferredContactMethod, patient, 'preferred_contact_method', {
      source: 'mock_ehr',
    }),
    preferred_language: preloadedField(patient.preferredLanguage, patient, 'preferred_language', { source: 'mock_ehr' }),
    current_medications: preloadedField(joinList(patient.knownMedications), patient, 'current_medications', {
      source: 'mock_ehr',
    }),
    known_allergies: preloadedField(joinList(patient.knownAllergies), patient, 'known_allergies', { source: 'mock_ehr' }),
    relevant_conditions: preloadedField(joinList(patient.relevantConditions), patient, 'relevant_conditions', {
      source: 'mock_ehr',
    }),
  };
}

function buildPreloadedContext(patient) {
  return {
    patient_identity: {
      full_name: patient.fullName,
      date_of_birth: patient.dateOfBirth,
      phone_number: patient.phoneNumber,
    },
    appointment_context: {
      appointment_datetime: patient.appointmentDatetime,
      clinic_name: patient.clinicName,
      specialist_name: patient.specialistName,
      appointment_type: patient.appointmentType,
    },
    known_reason_referral_context: {
      patientFacing: false,
      booking_reason: patient.bookingReason,
      referral_note: patient.referralNote,
      referring_provider_name: patient.referringProviderName,
    },
    existing_admin_info: {
      insurance_payer_name: patient.insurancePayerName,
      insurance_member_id: patient.insuranceMemberId,
      insurance_group_number: patient.insuranceGroupNumber,
      preferred_contact_method: patient.preferredContactMethod,
      preferred_language: patient.preferredLanguage,
      email_address: patient.emailAddress,
      ok_to_leave_voicemail: patient.okToLeaveVoicemail,
    },
    existing_clinical_info: {
      current_medications: joinList(patient.knownMedications),
      known_allergies: joinList(patient.knownAllergies),
      relevant_conditions: joinList(patient.relevantConditions),
    },
  };
}

function cloneList(items) {
  return (items || []).slice();
}

function cloneMap(map) {
  return { ...(map || {}) };
}

function resolvePatient(patient) {
  const resolved = {
    ...patient,
    knownMedications: cloneList(patient.knownMedications),
    knownAllergies: cloneList(patient.knownAllergies),
    relevantConditions: cloneList(patient.relevantConditions),
    lastConfirmedAt: cloneMap(patient.lastConfirmedAt),
    needsConfirmation: cloneMap(patient.needsConfirmation),
    phoneNumber: phoneFor(patient),
  };
  return {
    ...resolved,
    preloadedContext: buildPreloadedContext(resolved),
    preloadedIntakeFields: buildPreloadedIntakeFields(resolved),
  };
}

export function listDemoPatients() {
  return GENERATED_PATIENTS.map(resolvePatient);
}

export function getDemoPatient(patientId) {
  return listDemoPatients().find((patient) => patient.id === patientId) || null;
}

export function getDefaultDemoPatient() {
  const configuredId = process.env.DEMO_PATIENT_ID;
  return getDemoPatient(configuredId) || listDemoPatients()[0];
}

export function getDemoPatientByPhone(phoneNumber) {
  const normalized = normalizePhone(phoneNumber);
  if (!normalized) return null;
  return listDemoPatients().find((patient) => normalizePhone(patient.phoneNumber) === normalized) || null;
}

export function dobToDigits(dateOfBirth) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth || '');
  if (!match) return '';
  const [, year, month, day] = match;
  return `${month}${day}${year}`;
}

export function publicDemoPatient(patient) {
  if (!patient) return null;
  return {
    id: patient.id,
    fullName: patient.fullName,
    dateOfBirth: patient.dateOfBirth,
    preferredLanguage: patient.preferredLanguage,
    preferredContactMethod: patient.preferredContactMethod,
    emailAddress: patient.emailAddress,
    okToLeaveVoicemail: patient.okToLeaveVoicemail,
    phoneNumber: patient.phoneNumber,
    insurancePayerName: patient.insurancePayerName,
    insuranceMemberId: patient.insuranceMemberId,
    insuranceGroupNumber: patient.insuranceGroupNumber,
    insuranceLastVerifiedAt: patient.insuranceLastVerifiedAt,
    appointmentDatetime: patient.appointmentDatetime,
    clinicName: patient.clinicName,
    specialistName: patient.specialistName,
    appointmentType: patient.appointmentType,
    bookingReason: patient.bookingReason,
    referralNote: patient.referralNote,
    referringProviderName: patient.referringProviderName,
    knownMedications: cloneList(patient.knownMedications),
    knownAllergies: cloneList(patient.knownAllergies),
    relevantConditions: cloneList(patient.relevantConditions),
    lastConfirmedAt: cloneMap(patient.lastConfirmedAt),
    needsConfirmation: cloneMap(patient.needsConfirmation),
    preloadedContext: patient.preloadedContext,
    preloadedIntakeFields: patient.preloadedIntakeFields,
  };
}
