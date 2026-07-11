// In-memory store for ephemeral, call-scoped synthesized audio clips.
// No persistence is needed for this hackathon demo — clips just need to live
// long enough for Twilio's <Play> to fetch them once, shortly after synthesis.
// A periodic sweep evicts anything older than TTL so memory doesn't grow
// unbounded across a long demo session.

import { randomUUID } from 'node:crypto';

const TTL_MS = 10 * 60 * 1000; // 10 minutes

/** @type {Map<string, { buffer: Buffer, mimeType: string, createdAt: number }>} */
const store = new Map();

/**
 * Stores an audio buffer in memory and returns a short id that can be used
 * to build a public URL path (e.g. `/audio/{id}`).
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @returns {{ id: string, mimeType: string }}
 */
export function storeAudio(buffer, mimeType) {
  const id = randomUUID();
  store.set(id, { buffer, mimeType, createdAt: Date.now() });
  return { id, mimeType };
}

/**
 * Retrieves a previously stored audio clip by id.
 * @param {string} id
 * @returns {{ buffer: Buffer, mimeType: string } | null}
 */
export function getAudio(id) {
  const entry = store.get(id);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TTL_MS) {
    store.delete(id);
    return null;
  }
  return { buffer: entry.buffer, mimeType: entry.mimeType };
}

function sweep() {
  const now = Date.now();
  for (const [id, entry] of store.entries()) {
    if (now - entry.createdAt > TTL_MS) {
      store.delete(id);
    }
  }
}

const sweeper = setInterval(sweep, 60 * 1000); // sweep every minute
// Don't let the sweeper keep the process alive on its own (e.g. in test scripts).
if (typeof sweeper.unref === 'function') sweeper.unref();
