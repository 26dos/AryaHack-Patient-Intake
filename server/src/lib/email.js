import { config } from '../config.js';

// Confirmation channel per PRD Section 2 goal #5 ("SMS or email"). SMS delivery on this Twilio
// account is blocked by carrier-level A2P 10DLC / toll-free compliance (error 30034/30032) —
// that registration takes hours-to-days and isn't fixable before the demo, so email is the
// primary confirmation channel. Uses Resend's REST API directly (no SDK needed).
export async function sendConfirmationEmail({ subject, text, html }) {
  if (!config.resend.apiKey || !config.resend.to) {
    console.warn('[email] Skipping send: RESEND_API_KEY or CONFIRMATION_EMAIL_TO not set.');
    return null;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resend.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: config.resend.from,
      to: [config.resend.to],
      subject,
      text,
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend send failed: ${res.status} ${body}`);
  }

  return res.json();
}
