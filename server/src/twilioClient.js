import twilio from 'twilio';
import { config } from './config.js';
import { getDefaultDemoPatient, getDemoPatient } from './lib/demoPatients.js';

export const twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);

export async function sendSms(to, body) {
  return twilioClient.messages.create({
    to,
    from: config.twilio.phoneNumber,
    body,
  });
}

function buildWebhookUrl(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, value);
  }
  const qs = query.toString();
  return `${config.publicBaseUrl}${path}${qs ? `?${qs}` : ''}`;
}

/**
 * Places an outbound intake call to a demo patient.
 *
 * Accepts the original `placeIntakeCall("+1555...")` form, or
 * `placeIntakeCall({ patientId })`. Phone numbers still must be Twilio-verified
 * on trial accounts.
 */
export async function placeIntakeCall(toOrOptions) {
  if (!config.twilio.phoneNumber) throw new Error('TWILIO_PHONE_NUMBER is not set.');
  if (!config.publicBaseUrl) throw new Error('PUBLIC_BASE_URL is not set.');

  const options = typeof toOrOptions === 'object' && toOrOptions !== null
    ? toOrOptions
    : { to: toOrOptions };
  const patient = options.patientId ? getDemoPatient(options.patientId) : getDefaultDemoPatient();
  const to = options.to || patient?.phoneNumber;
  if (!to) throw new Error('No destination number provided.');
  const webhookContext = patient ? { patientId: patient.id } : {};

  return twilioClient.calls.create({
    to,
    from: config.twilio.phoneNumber,
    url: buildWebhookUrl('/voice/incoming', webhookContext),
    method: 'POST',
    statusCallback: buildWebhookUrl('/voice/status', webhookContext),
    statusCallbackMethod: 'POST',
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    machineDetection: 'DetectMessageEnd',
    asyncAmd: 'true',
    asyncAmdStatusCallback: buildWebhookUrl('/voice/amd', webhookContext),
    asyncAmdStatusCallbackMethod: 'POST',
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
