// Manual end-to-end test for the TTS module. Run with: node scripts/test_tts.js
//
// 1. Calls synthesizeAndStore() for real against the live ElevenLabs API and
//    confirms a non-null "/audio/{id}" path comes back.
// 2. Verifies the audio is retrievable via getAudio() (same in-memory store
//    the Express route reads from) and writes the bytes to
//    scratch_test_output.mp3 for a manual sanity check.
// 3. Exercises the failure path by pointing synthesizeSpeech-equivalent logic
//    at a deliberately invalid API key (via a direct fetch, mirroring tts.js)
//    and confirming a non-200 response is handled without throwing.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesizeAndStore, synthesizeSpeech } from '../src/lib/tts.js';
import { getAudio } from '../src/lib/audioStore.js';
import { config } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.resolve(__dirname, '..', 'scratch_test_output.mp3');

async function main() {
  console.log('--- Test 1: real ElevenLabs synthesis via synthesizeAndStore() ---');
  console.log(`Using voiceId=${config.elevenlabs.voiceId} apiKeyPresent=${Boolean(config.elevenlabs.apiKey)}`);

  const path_ = await synthesizeAndStore("Hello, this is a test of the intake agent's voice.");

  if (!path_) {
    console.error('FAIL: synthesizeAndStore returned null. Check API key / voice id / network.');
    process.exitCode = 1;
    return;
  }
  console.log(`OK: got path "${path_}"`);

  const id = path_.replace('/audio/', '');
  const audio = getAudio(id);
  if (!audio) {
    console.error('FAIL: getAudio() returned null right after storing — store/lookup bug.');
    process.exitCode = 1;
    return;
  }

  await writeFile(OUTPUT_PATH, audio.buffer);
  console.log(`OK: wrote ${audio.buffer.length} bytes to ${OUTPUT_PATH}`);
  console.log(`mimeType: ${audio.mimeType}`);

  if (audio.buffer.length === 0) {
    console.error('FAIL: audio buffer is empty.');
    process.exitCode = 1;
    return;
  }

  console.log('\n--- Test 2: failure path (invalid API key -> non-200 -> null, no throw) ---');
  const realFetch = globalThis.fetch;
  try {
    // Monkey-patch fetch just for this call so we exercise tts.js's real
    // error-handling branch (non-200 response) without touching .env or
    // config.js, and without making a second real ElevenLabs charge.
    globalThis.fetch = async (url, opts) => {
      console.log(`(intercepted fetch to ${url}, simulating ElevenLabs 401)`);
      return new Response('{"detail":"invalid_api_key (simulated)"}', {
        status: 401,
        statusText: 'Unauthorized',
      });
    };

    const result = await synthesizeSpeech('This call should fail gracefully.');
    if (result !== null) {
      console.error('FAIL: expected null on simulated 401 response, got a result instead.');
      process.exitCode = 1;
      return;
    }
    console.log('OK: synthesizeSpeech returned null on simulated 401 (did not throw).');
  } catch (err) {
    console.error(`FAIL: synthesizeSpeech threw instead of returning null: ${err.stack}`);
    process.exitCode = 1;
    return;
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log('\nAll tests passed.');
}

main().then(() => {
  // Force exit so the audioStore's unref'd sweeper interval doesn't linger
  // (it's unref'd, so this isn't strictly necessary, but keeps CI-style runs tidy).
  process.exit(process.exitCode || 0);
});
