// Text-to-speech synthesis via the ElevenLabs REST API, with a graceful
// failure mode so callers can fall back to Twilio's built-in <Say> verb.
//
// Scope note: this module only synthesizes audio and hands back a Buffer
// (or, via synthesizeAndStore, a relative URL path). It does not touch
// Twilio TwiML generation, Supabase, or the conversation engine.

import { config } from '../config.js';
import { storeAudio } from './audioStore.js';

const ELEVENLABS_TTS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const DEFAULT_MODEL_ID = 'eleven_turbo_v2_5';
// Keeps a stalled ElevenLabs call from hanging a conversation turn — falls
// back to <Say> instead of blocking the caller mid-demo.
const REQUEST_TIMEOUT_MS = 6000;

// Tuned for a warm, calm clinical-intake phone voice per PRD Section 6
// ("warm, human framing, not robocall energy") — not maximally expressive,
// but stable and natural rather than flat/robotic.
const DEFAULT_VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.0,
  use_speaker_boost: true,
};

/**
 * Synthesizes `text` into speech audio via ElevenLabs.
 *
 * Never throws. On any failure (missing API key/voice id, network error,
 * non-200 response, rate limit, etc.) it logs a console.warn explaining why
 * and returns null so the caller can fall back to Twilio's <Say>.
 *
 * @param {string} text
 * @returns {Promise<{ audioBuffer: Buffer, mimeType: 'audio/mpeg' } | null>}
 */
export async function synthesizeSpeech(text) {
  if (!text || !text.trim()) {
    console.warn('[tts] synthesizeSpeech called with empty text; skipping ElevenLabs call.');
    return null;
  }

  const { apiKey, voiceId } = config.elevenlabs;
  if (!apiKey) {
    console.warn('[tts] Missing ELEVENLABS_API_KEY; falling back to <Say>.');
    return null;
  }
  if (!voiceId) {
    console.warn('[tts] Missing ELEVENLABS_VOICE_ID; falling back to <Say>.');
    return null;
  }

  let response;
  try {
    response = await fetch(`${ELEVENLABS_TTS_URL}/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: DEFAULT_MODEL_ID,
        voice_settings: DEFAULT_VOICE_SETTINGS,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? `timed out after ${REQUEST_TIMEOUT_MS}ms` : err.message;
    console.warn(`[tts] Network error calling ElevenLabs: ${reason}. Falling back to <Say>.`);
    return null;
  }

  if (!response.ok) {
    let bodyText = '';
    try {
      bodyText = await response.text();
    } catch {
      // ignore — best-effort error detail only
    }
    console.warn(
      `[tts] ElevenLabs returned ${response.status} ${response.statusText}: ${bodyText.slice(0, 500)}. Falling back to <Say>.`
    );
    return null;
  }

  try {
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);
    if (audioBuffer.length === 0) {
      console.warn('[tts] ElevenLabs returned an empty audio body. Falling back to <Say>.');
      return null;
    }
    return { audioBuffer, mimeType: 'audio/mpeg' };
  } catch (err) {
    console.warn(`[tts] Failed reading ElevenLabs audio response: ${err.message}. Falling back to <Say>.`);
    return null;
  }
}

/**
 * High-level helper: synthesizes `text`, stores the resulting audio in the
 * in-memory audio store, and returns a relative URL path (e.g. "/audio/{id}")
 * that the Twilio layer can prefix with PUBLIC_BASE_URL for use in <Play>.
 *
 * Returns null if synthesis failed, so the caller can fall back to
 * <Say>text</Say> instead.
 *
 * @param {string} text
 * @returns {Promise<string | null>}
 */
export async function synthesizeAndStore(text) {
  const result = await synthesizeSpeech(text);
  if (!result) return null;

  const { id } = storeAudio(result.audioBuffer, result.mimeType);
  return `/audio/${id}`;
}
