// Regression test for a real bug: on Workday-hosted job postings, the JD
// is mirrored in JSON-LD (present from the very first byte of HTML, for
// Google-for-Jobs SEO), while the real DOM-rendered description — the
// higher-priority strategy in extractJobDescriptionConfident()'s selector
// list, and generally the more complete/authoritative signal — doesn't
// exist until Workday's JS framework finishes hydrating, which can take
// noticeably longer. waitForJobDescriptionReady() polled for JD text
// immediately, so it could find a "confident" match via the JSON-LD
// fallback and consider the page ready before the DOM had rendered
// anything at all — confirmed live: this fed a materially different JD
// into the automated analysis than what a later manual Re-Analyze (run
// once the page had settled) saw, different enough to change which
// resumes ranked in the local top-3 ATS-keyword match between the two
// runs.
//
// Fix: waitForJobDescriptionReady() now calls waitForDomSettled() first,
// before ever checking for JD text, so the DOM has a chance to render its
// own (higher-priority) description before the JSON-LD fallback is even
// consulted.
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom (see contentRadioGroupLabel.test.js), so this
// extracts waitForJobDescriptionReady() by source range and evals it with
// small stand-ins for its dependencies.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');
const SRC = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

const START_MARKER = 'async function waitForJobDescriptionReady(maxWaitMs = 10000, intervalMs = 400) {';
const END_MARKER = '\n  /**\n   * Polls until the current page appears to have SOME form fields,';
const START = SRC.indexOf(START_MARKER);
const END = SRC.indexOf(END_MARKER);
if (START === -1 || END === -1 || END <= START) {
  throw new Error('content.js source anchors moved — update this test\'s extraction markers');
}
const FN_SRC = SRC.slice(START, END);

/**
 * Builds a runnable waitForJobDescriptionReady() with stubbed
 * dependencies, plus a `calls` log to inspect ordering.
 * @param {Object} opts
 * @param {string[]} opts.confidentSequence - Successive return values for extractJobDescriptionConfident() across polls.
 */
function buildHarness({ confidentSequence = [] } = {}) {
  const calls = [];
  let confidentIdx = 0;
  const factory = new Function( // eslint-disable-line no-new-func
    'calls', 'confidentSequence',
    `
    async function waitForDomSettled() { calls.push('waitForDomSettled'); }
    function extractJobDescriptionConfident() {
      calls.push('extractJobDescriptionConfident');
      const seq = confidentSequence;
      const i = Math.min(calls.filter(c => c === 'extractJobDescriptionConfident').length - 1, seq.length - 1);
      return seq[i] ?? '';
    }
    async function getJDFromIframes() { calls.push('getJDFromIframes'); return ''; }
    ${FN_SRC}
    return waitForJobDescriptionReady;
    `,
  );
  return { waitForJobDescriptionReady: factory(calls, confidentSequence), calls };
}

describe('waitForJobDescriptionReady — waits for the DOM to settle before ever checking JD text', () => {
  it('calls waitForDomSettled before the first extractJobDescriptionConfident() check', async () => {
    const { waitForJobDescriptionReady, calls } = buildHarness({
      confidentSequence: ['Full job description text here.', 'Full job description text here.'],
    });

    await waitForJobDescriptionReady(2000, 10);

    expect(calls[0]).toBe('waitForDomSettled');
    expect(calls).toContain('extractJobDescriptionConfident');
    // waitForDomSettled must not be called again mid-poll — it's a single
    // up-front gate, not part of the per-iteration check.
    expect(calls.filter(c => c === 'waitForDomSettled').length).toBe(1);
  });

  it('still resolves once two consecutive polls see the same non-empty JD', async () => {
    const { waitForJobDescriptionReady, calls } = buildHarness({
      confidentSequence: ['Growing...', 'Growing... more', 'Stable text', 'Stable text'],
    });

    await waitForJobDescriptionReady(2000, 5);

    const confidentCalls = calls.filter(c => c === 'extractJobDescriptionConfident');
    expect(confidentCalls.length).toBe(4);
  });

  it('always resolves (never hangs) even if JD text never appears', async () => {
    const { waitForJobDescriptionReady } = buildHarness({ confidentSequence: [] });
    await expect(waitForJobDescriptionReady(50, 10)).resolves.toBeUndefined();
  });
});
