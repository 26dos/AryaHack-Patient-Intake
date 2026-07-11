import twilio from 'twilio';
import { config } from './config.js';

export const twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);

export async function sendSms(to, body) {
  return twilioClient.messages.create({
    to,
    from: config.twilio.phoneNumber,
    body,
  });
}

export async function purchaseFirstAvailableNumber({ type = 'local', areaCode } = {}) {
  const searchOpts = { voiceEnabled: true, smsEnabled: true, limit: 5 };
  if (areaCode) searchOpts.areaCode = areaCode;

  const list = await twilioClient.availablePhoneNumbers('US')[type].list(searchOpts);
  if (!list.length) throw new Error(`No available ${type} numbers found`);

  const chosen = list[0].phoneNumber;
  const purchased = await twilioClient.incomingPhoneNumbers.create({
    phoneNumber: chosen,
    friendlyName: 'Arya Intake Agent',
  });
  return purchased;
}

export async function configureNumberWebhooks(phoneNumberSid, baseUrl) {
  return twilioClient.incomingPhoneNumbers(phoneNumberSid).update({
    voiceUrl: `${baseUrl}/voice/incoming`,
    voiceMethod: 'POST',
    statusCallback: `${baseUrl}/voice/status`,
    statusCallbackMethod: 'POST',
  });
}
