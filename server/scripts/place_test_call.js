import { config } from '../src/config.js';
import { placeIntakeCall } from '../src/twilioClient.js';

async function main() {
  const to = process.argv[2] || config.testPatientPhoneNumber;
  if (!to) {
    console.error('No destination number: pass one as an arg or set TEST_PATIENT_PHONE_NUMBER.');
    process.exit(1);
  }

  const call = await placeIntakeCall(to);
  console.log(`Placed call ${call.sid} to ${to}`);
}

main().catch((err) => {
  console.error('Failed to place test call:', err.message);
  process.exit(1);
});
