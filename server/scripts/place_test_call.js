import { config } from '../src/config.js';
import { placeIntakeCall } from '../src/twilioClient.js';
import { getDefaultDemoPatient, getDemoPatient } from '../src/lib/demoPatients.js';

async function main() {
  const arg = process.argv[2];
  const explicitPhone = arg && arg.startsWith('+') ? arg : '';
  const patient = arg && !explicitPhone ? getDemoPatient(arg) : getDefaultDemoPatient();
  const to = explicitPhone || patient?.phoneNumber || config.testPatientPhoneNumber;
  if (!to) {
    console.error('No destination number: pass one as an arg or set TEST_PATIENT_PHONE_NUMBER / DEMO_PATIENT_*_PHONE.');
    process.exit(1);
  }

  const call = await placeIntakeCall(explicitPhone ? { to, patientId: patient?.id } : { patientId: patient?.id });
  console.log(`Placed call ${call.sid} to ${to}${patient ? ` for ${patient.fullName}` : ''}`);
}

main().catch((err) => {
  console.error('Failed to place test call:', err.message);
  process.exit(1);
});
