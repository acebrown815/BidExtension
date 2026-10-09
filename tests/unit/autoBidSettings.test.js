// Auto-Bid's "Jobs to run at once" (how many pending rows one "Analyze
// Pending Jobs" click opens) — selectable, default 10.
import { describe, it, expect } from 'vitest';
import { normalizeAutoBidBatchSize, withAutoBidDefaults, DEFAULT_AUTO_BID_BATCH_SIZE, MAX_AUTO_BID_BATCH_SIZE } from '../../lib/autoBidSettings.mjs';

describe('normalizeAutoBidBatchSize', () => {
  it('keeps a valid choice', () => {
    expect(normalizeAutoBidBatchSize(3)).toBe(3);
    expect(normalizeAutoBidBatchSize('20')).toBe(20);
  });
  it('falls back to 10 for missing or unreadable values', () => {
    for (const v of [undefined, null, '', 'abc', 0, -5, NaN]) expect(normalizeAutoBidBatchSize(v)).toBe(DEFAULT_AUTO_BID_BATCH_SIZE);
  });
  it('caps at the maximum and rounds', () => {
    expect(normalizeAutoBidBatchSize(500)).toBe(MAX_AUTO_BID_BATCH_SIZE);
    expect(normalizeAutoBidBatchSize(4.6)).toBe(5);
  });
});

describe('withAutoBidDefaults', () => {
  it('defaults for a fresh install', () => {
    expect(withAutoBidDefaults(undefined)).toEqual({ tailorResumeEnabled: true, batchSize: 10 });
  });
  it('keeps settings saved before the batch size existed', () => {
    expect(withAutoBidDefaults({ tailorResumeEnabled: false })).toEqual({ tailorResumeEnabled: false, batchSize: 10 });
  });
  it('a saved batch size wins over the default', () => {
    expect(withAutoBidDefaults({ tailorResumeEnabled: true, batchSize: 5 }).batchSize).toBe(5);
  });
});
