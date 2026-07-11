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

/**
 * Places an outbound intake call to `to` (must be a Twilio-verified number on trial accounts).
 * Shared by scripts/place_test_call.js and the dashboard's "Call test patient" button so both
 * paths stay in sync.
 */
export async function placeIntakeCall(to) {
  if (!config.twilio.phoneNumber) throw new Error('TWILIO_PHONE_NUMBER is not set.');
  if (!config.publicBaseUrl) throw new Error('PUBLIC_BASE_URL is not set.');
  if (!to) throw new Error('No destination number provided.');

  return twilioClient.calls.create({
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
