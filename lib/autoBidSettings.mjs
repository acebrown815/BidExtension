/**
 * Auto-Bid settings defaults and validation, shared by background.js (which
 * stores them and runs the batch) and its tests.
 */

// How many pending postings one "Analyze Pending Jobs" click opens at once.
export const DEFAULT_AUTO_BID_BATCH_SIZE = 10;
export const MAX_AUTO_BID_BATCH_SIZE = 50;

/**
 * A whole number between 1 and MAX_AUTO_BID_BATCH_SIZE; anything missing or
 * unreadable falls back to the default.
 * @param {*} value
 * @returns {number}
 */
export function normalizeAutoBidBatchSize(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_AUTO_BID_BATCH_SIZE;
  return Math.min(n, MAX_AUTO_BID_BATCH_SIZE);
}

/**
 * Stored settings merged over the defaults, with the batch size validated.
 * @param {Object|undefined} stored
 * @returns {{tailorResumeEnabled: boolean, batchSize: number}}
 */
export function withAutoBidDefaults(stored) {
  const s = { tailorResumeEnabled: true, batchSize: DEFAULT_AUTO_BID_BATCH_SIZE, ...(stored || {}) };
  s.batchSize = normalizeAutoBidBatchSize(s.batchSize);
  return s;
}
