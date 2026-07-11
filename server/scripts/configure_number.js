// Usage: node scripts/configure_number.js https://abc123.ngrok-free.app
import { config } from '../src/config.js';
import { twilioClient, configureNumberWebhooks } from '../src/twilioClient.js';

async function main() {
  const baseUrl = process.argv[2];
  if (!baseUrl) {
    console.error('Usage: node scripts/configure_number.js <public-base-url>');
    process.exit(1);
  }

  const numbers = await twilioClient.incomingPhoneNumbers.list({
    phoneNumber: config.twilio.phoneNumber,
    limit: 1,
  });
  if (!numbers.length) {
    console.error(`Could not find phone number ${config.twilio.phoneNumber} on this account.`);
    process.exit(1);
  }

  await configureNumberWebhooks(numbers[0].sid, baseUrl);
  console.log(`Configured ${config.twilio.phoneNumber} -> voiceUrl: ${baseUrl}/voice/incoming, statusCallback: ${baseUrl}/voice/status`);
}

main().catch((err) => {
  console.error('Failed to configure number:', err.message);
  process.exit(1);
});
