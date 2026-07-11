// Guardrail checks that run OUTSIDE (before/alongside) the LLM conversation turn.
//
// Per PRD Section 10:
//   "Emergency language handling ... this is a hard-coded interrupt, not left to the LLM's
//   discretion alone. Build this as a keyword/classifier pre-check on transcribed text before
//   it reaches the conversational LLM turn."
//
// checkEmergency() is that hard-coded, deterministic pre-check. It MUST run on every raw
// patient transcript before the transcript is handed to Gemini. If it returns true, the caller
// (conversation.js / the Twilio layer) should short-circuit and play EMERGENCY_KEYWORDS_MESSAGE
// verbatim instead of doing anything LLM-driven for that turn.
//
// looksLikeClinicalAdviceRequest() is a lightweight backstop for the OTHER PRD Section 10
// guardrail (no diagnosis / no clinical advice). The primary defense there is the system prompt
// instructing Gemini to refuse with the exact line ("I can't advise on that, your doctor will
// review this with you at your visit") — this function is just a cheap signal the conversation
// engine can use to double-check / force that refusal even if the LLM tries to answer.

// Keep phrases lowercase; matching is case-insensitive and substring/regex based, not an
// exhaustive clinical NLP classifier. When in doubt, prefer a false positive (over-triggering
// the emergency message) over a false negative on a genuine emergency.
export const EMERGENCY_KEYWORDS = [
  'chest pain',
  "can't breathe",
  'cant breathe',
  'cannot breathe',
  "can't catch my breath",
  'not breathing',
  "he's not breathing",
  "she's not breathing",
  'heart attack',
  'having a stroke',
  'stroke',
  'severe bleeding',
  'bleeding a lot',
  "won't stop bleeding",
  'wont stop bleeding',
  'unconscious',
  'unresponsive',
  'passed out and',
  'overdose',
  'overdosed',
  'suicide',
  'suicidal',
  'kill myself',
  'want to die',
  'end my life',
  'choking',
  "can't swallow",
  'severe allergic reaction',
  'anaphylaxis',
  'anaphylactic',
  'throat closing',
  'seizure',
  'having a seizure',
  'convulsing',
  'call 911',
  'need an ambulance',
];

/**
 * Deterministic, hard-coded emergency keyword/phrase check. Case-insensitive.
 * Must run on every raw transcript BEFORE it reaches Gemini.
 * @param {string} text - raw patient transcript for this turn
 * @returns {boolean} true if the text appears to describe an active emergency
 */
export function checkEmergency(text) {
  if (!text || typeof text !== 'string') return false;
  const normalized = text.toLowerCase();
  return EMERGENCY_KEYWORDS.some((phrase) => normalized.includes(phrase));
}

// Lightweight phrase list for detecting the patient asking the agent for a diagnosis / medical
// advice / treatment recommendation. This is a backstop only — the system prompt fed to Gemini
// in conversation.js is the primary defense and must independently instruct the model to refuse
// with the PRD's exact refusal line.
export const CLINICAL_ADVICE_PATTERNS = [
  /what do you think (this|it) is/i,
  /do you think (i|this) (is|might|could)/i,
  /should i be worried/i,
  /is (this|it) serious/i,
  /what('s| is| do you think) wrong with me/i,
  /what medication should i take/i,
  /what should i take for/i,
  /can you (diagnose|prescribe)/i,
  /what('s| is) my diagnosis/i,
  /do i have (a |an )?[a-z\s]+\?/i,
  /is (this|it) (cancer|covid|a heart attack|a stroke)/i,
  /what treatment/i,
  /how (do i|should i) treat/i,
  /am i going to be (ok|okay|fine)/i,
  /should i go to the (er|emergency room|hospital)/i,
];

/**
 * Lightweight backstop check for whether the patient is asking the agent for a diagnosis,
 * medical advice, or a treatment recommendation. NOT the primary defense — see file header.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeClinicalAdviceRequest(text) {
  if (!text || typeof text !== 'string') return false;
  return CLINICAL_ADVICE_PATTERNS.some((re) => re.test(text));
}
