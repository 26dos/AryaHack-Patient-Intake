import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { purchaseFirstAvailableNumber } from '../src/twilioClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env');

async function main() {
  let purchased;
  try {
    purchased = await purchaseFirstAvailableNumber({ type: 'local' });
  } catch (err) {
    console.warn(`Local number purchase failed (${err.message}), trying toll-free...`);
    purchased = await purchaseFirstAvailableNumber({ type: 'tollFree' });
  }

  console.log(`Purchased number: ${purchased.phoneNumber} (sid: ${purchased.sid})`);

  let env = fs.readFileSync(envPath, 'utf8');
  if (env.includes('TWILIO_PHONE_NUMBER=')) {
    env = env.replace(/TWILIO_PHONE_NUMBER=.*/, `TWILIO_PHONE_NUMBER=${purchased.phoneNumber}`);
  } else {
    env += `\nTWILIO_PHONE_NUMBER=${purchased.phoneNumber}\n`;
  }
  fs.writeFileSync(envPath, env);
  console.log('.env updated with TWILIO_PHONE_NUMBER');
  console.log(`Phone number SID (save for webhook config): ${purchased.sid}`);
}

main().catch((err) => {
  console.error('Failed to purchase a number:', err.message);
  process.exit(1);
});
