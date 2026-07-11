import { config } from '../src/config.js';
import { twilioClient } from '../src/twilioClient.js';

async function main() {
  if (!config.twilio.phoneNumber) {
    console.error('TWILIO_PHONE_NUMBER is not set yet — run npm run buy-number first.');
    process.exit(1);
  }
  if (!config.publicBaseUrl) {
    console.error('PUBLIC_BASE_URL is not set in .env yet — set it to your ngrok URL first.');
    process.exit(1);
  }
  const to = process.argv[2] || config.testPatientPhoneNumber;
  if (!to) {
    console.error('No destination number: pass one as an arg or set TEST_PATIENT_PHONE_NUMBER.');
    process.exit(1);
  }

  const call = await twilioClient.calls.create({
    to,
    from: config.twilio.phoneNumber,
    url: `${config.publicBaseUrl}/voice/incoming`,
    method: 'POST',
    statusCallback: `${config.publicBaseUrl}/voice/status`,
    statusCallbackMethod: 'POST',
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    machineDetection: 'DetectMessageEnd',
    machineDetectionTimeout: 8,
  });

  console.log(`Placed call ${call.sid} to ${to}`);
}

main().catch((err) => {
  console.error('Failed to place test call:', err.message);
  process.exit(1);
});
