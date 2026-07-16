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
    phoneEnv: 'DEMO_PATIENT_MAYA_PHONE',
    fallbackPhoneEnv: 'TEST_PATIENT_PHONE_NUMBER',
    insurancePayerName: 'Aetna',
    insuranceMemberId: 'AET4829156',
    insuranceGroupNumber: 'GRP-1048',
    appointmentDatetime: 'today at 2:30 PM',
  },
  {
    id: 'pat-daniel-kim',
    fullName: 'Daniel Kim',
    dateOfBirth: '1978-02-03',
    preferredLanguage: 'English',
    phoneEnv: 'DEMO_PATIENT_DANIEL_PHONE',
    insurancePayerName: 'Blue Cross Blue Shield',
    insuranceMemberId: 'BCBS7732041',
    insuranceGroupNumber: 'BX-2209',
    appointmentDatetime: 'tomorrow at 9:15 AM',
  },
  {
    id: 'pat-elena-patel',
    fullName: 'Elena Patel',
    dateOfBirth: '1991-12-22',
    preferredLanguage: 'English',
    phoneEnv: 'DEMO_PATIENT_ELENA_PHONE',
    insurancePayerName: 'UnitedHealthcare',
    insuranceMemberId: 'UHC3901847',
    insuranceGroupNumber: 'NYC-7712',
    appointmentDatetime: 'Friday at 11:00 AM',
  },
];

function normalizePhone(phone) {
  return String(phone || '').replace(/[^\d+]/g, '');
}

function phoneFor(patient) {
  return process.env[patient.phoneEnv] || (patient.fallbackPhoneEnv ? process.env[patient.fallbackPhoneEnv] : '') || '';
}

export function listDemoPatients() {
  return GENERATED_PATIENTS.map((patient) => ({
    ...patient,
    phoneNumber: phoneFor(patient),
  }));
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
    phoneNumber: patient.phoneNumber,
    insurancePayerName: patient.insurancePayerName,
    insuranceMemberId: patient.insuranceMemberId,
    insuranceGroupNumber: patient.insuranceGroupNumber,
    appointmentDatetime: patient.appointmentDatetime,
  };
}
