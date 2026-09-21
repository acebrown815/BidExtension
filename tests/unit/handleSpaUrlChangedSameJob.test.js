// Regression test for a real gap: after a user manually clicks a
// multi-step wizard's REAL "Submit"/"Send Application" button (never
// something Auto-Bid clicks on its own — see findNextStepButton's
// final-action exclusion), the resulting success/confirmation page has a
// different URL than the original job posting. Confirmed on Dice:
//   https://www.dice.com/job-detail/ef34f6e2-38d0-4ecb-aac9-838fed17b01f
//   https://www.dice.com/job-applications/ef34f6e2-38d0-4ecb-aac9-838fed17b01f/wizard/success
// share the exact same uuid despite otherwise-unrelated path structure.
//
// handleSpaUrlChanged() treated any URL change as "the user navigated to
// a different job posting" and wiped currentAnalysis (hiding Mark as
// Applied, resetting the panel to "Analyze Job") — correct for a
// genuinely different posting, but wrong here: it's still the same
// application, now on its own success page, and the user should still be
// able to click Mark as Applied there.
//
// Fix: extractJobIdFromUrl() pulls a long, near-unique id (UUID or
// comparable hex run) out of a URL's path; handleSpaUrlChanged() now
// treats a URL change as a genuinely different job only when the two
// sides' ids are both present and differ (or neither side has one at
// all, same as before for ATS platforms with no such id in the URL).
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom (see contentRadioGroupLabel.test.js), so this
// extracts extractJobIdFromUrl()/handleSpaUrlChanged() by source range and
// evals them with small stand-ins for their dependencies.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');

let FN_SRC;

beforeAll(() => {
  const src = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('function extractJobIdFromUrl(url) {');
  const end = src.indexOf('\n\n  checkIfApplied();\n\n})();');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  }
  FN_SRC = src.slice(start, end);
});

/**
 * Builds a fresh, runnable extractJobIdFromUrl()/handleSpaUrlChanged()
 * pair with every dependency stubbed, plus a `state` object exposing the
 * module-level variables the real code mutates and a `calls` log for the
 * side-effecting functions.
 * @param {Object} opts
 * @param {string} opts.lastUrl - Initial _lastUrl (already-normalized, matching what a real prior run would have stored).
 * @param {Object|null} [opts.currentAnalysis] - Initial currentAnalysis.
 */
function buildHarness({ lastUrl, currentAnalysis = { title: 'Existing analysis' } }) {
  const calls = [];
  const els = {}; // shadowRoot.getElementById stand-in storage
  const fakeEl = () => ({ style: {}, textContent: '', innerHTML: '', get onclick() { return this._onclick; }, set onclick(v) { this._onclick = v; } });
  ['jmAnalyze', 'jmAutofill', 'jmScoreSection', 'jmMatchingSection', 'jmMissingSection', 'jmRecsSection',
    'jmInsightsSection', 'jmKeywordsSection', 'jmTruncNotice', 'jmAutofillWarning', 'jmCoverLetterSection',
    'jmBulletSection', 'jmJobInfo', 'jmSaveJob', 'jmMarkApplied', 'jmCoverLetterBtn', 'jmRewriteBulletsBtn',
  ].forEach(id => { els[id] = fakeEl(); });
  els.jmMarkApplied.style.display = 'flex'; // as if a completed analysis already revealed it

  const state = { currentAnalysis, _fieldMap: { some: 'field' }, _manualResumeSelection: true, _autoBidOriginalLink: 'https://example.com/original' };

  const factory = new Function( // eslint-disable-line no-new-func
    'calls', 'els', 'state', 'initialLastUrl',
    `
    function normalizeUrl(u) { return u; }
    let _lastUrl = initialLastUrl;
    let _analyzeGen = 0;
    let _autoBidContinuationActive = false;
    let _autoBidAutofillRun = false;
    let currentAnalysis = state.currentAnalysis;
    let _fieldMap = state._fieldMap;
    let _manualResumeSelection = state._manualResumeSelection;
    let _autoBidOriginalLink = state._autoBidOriginalLink;
    const shadowRoot = { getElementById: (id) => els[id] || null };
    const panelOpen = true;
    function clearAutofillBadges() { calls.push('clearAutofillBadges'); }
    function loadJobNotes() { calls.push('loadJobNotes'); }
    function loadResumeState() { calls.push('loadResumeState'); }
    function previewJobMeta() { calls.push('previewJobMeta'); }
    function scanResumeMatch() { calls.push('scanResumeMatch'); }
    function checkIfApplied() { calls.push('checkIfApplied'); }
    function checkIfSaved() { calls.push('checkIfSaved'); }
    function setStatus(msg) { calls.push('setStatus:' + msg); }
    function clearStatus() { calls.push('clearStatus'); }
    function checkPendingAutoBidAutofill() { calls.push('checkPendingAutoBidAutofill'); }
    ${FN_SRC}
    return {
      extractJobIdFromUrl,
      handleSpaUrlChanged,
      getState: () => ({ currentAnalysis, _fieldMap, _manualResumeSelection, _autoBidOriginalLink, _lastUrl, _analyzeGen }),
    };
    `,
  );
  const harness = factory(calls, els, state, lastUrl);
  return { ...harness, calls, els };
}

describe('extractJobIdFromUrl', () => {
  it('extracts the shared uuid from both the Dice posting page and its success page', () => {
    const { extractJobIdFromUrl } = buildHarness({ lastUrl: 'https://www.dice.com/job-detail/ef34f6e2-38d0-4ecb-aac9-838fed17b01f' });
    const postingId = extractJobIdFromUrl('https://www.dice.com/job-detail/ef34f6e2-38d0-4ecb-aac9-838fed17b01f');
    const successId = extractJobIdFromUrl('https://www.dice.com/job-applications/ef34f6e2-38d0-4ecb-aac9-838fed17b01f/wizard/success');
    expect(postingId).toBe('ef34f6e2-38d0-4ecb-aac9-838fed17b01f');
    expect(successId).toBe(postingId);
  });

  it('returns null for a URL with no long id in its path', () => {
    const { extractJobIdFromUrl } = buildHarness({ lastUrl: 'https://example.com/jobs/senior-engineer' });
    expect(extractJobIdFromUrl('https://example.com/jobs/senior-engineer')).toBeNull();
  });

  it('is case-insensitive', () => {
    const { extractJobIdFromUrl } = buildHarness({ lastUrl: '' });
    expect(extractJobIdFromUrl('https://x.com/a/EF34F6E2-38D0-4ECB-AAC9-838FED17B01F/b'))
      .toBe('ef34f6e2-38d0-4ecb-aac9-838fed17b01f');
  });
});

describe('handleSpaUrlChanged — same underlying job survives a real Submit-to-success navigation', () => {
  it('does NOT wipe currentAnalysis/Mark as Applied when the success page shares the posting\'s uuid', () => {
    window.happyDOM.setURL('https://www.dice.com/job-applications/ef34f6e2-38d0-4ecb-aac9-838fed17b01f/wizard/success');
    const { handleSpaUrlChanged, getState, calls, els } = buildHarness({
      lastUrl: 'https://www.dice.com/job-detail/ef34f6e2-38d0-4ecb-aac9-838fed17b01f',
      currentAnalysis: { title: 'Senior Engineer', matchScore: 88 },
    });

    handleSpaUrlChanged();

    const state = getState();
    expect(state.currentAnalysis).toEqual({ title: 'Senior Engineer', matchScore: 88 });
    expect(els.jmMarkApplied.style.display).toBe('flex'); // never touched — still whatever it was
    expect(calls).not.toContain('scanResumeMatch');
    expect(calls).not.toContain('checkIfApplied');
    // _lastUrl/_analyzeGen still advance for a later, genuinely new nav.
    expect(state._lastUrl).toBe('https://www.dice.com/job-applications/ef34f6e2-38d0-4ecb-aac9-838fed17b01f/wizard/success');
    expect(state._analyzeGen).toBe(1);
  });

  it('still resets everything for a genuinely different job posting (no regression)', () => {
    window.happyDOM.setURL('https://www.dice.com/job-detail/00000000-0000-0000-0000-000000000000');
    const { handleSpaUrlChanged, getState, calls, els } = buildHarness({
      lastUrl: 'https://www.dice.com/job-detail/ef34f6e2-38d0-4ecb-aac9-838fed17b01f',
      currentAnalysis: { title: 'Senior Engineer', matchScore: 88 },
    });

    handleSpaUrlChanged();

    const state = getState();
    expect(state.currentAnalysis).toBeNull();
    expect(els.jmMarkApplied.style.display).toBe('none');
    expect(calls).toContain('scanResumeMatch');
    expect(calls).toContain('checkIfApplied');
  });

  it('still resets when neither URL has an extractable id at all (ordinary ATS behavior, unaffected)', () => {
    window.happyDOM.setURL('https://boards.greenhouse.io/acme/jobs/654321');
    const { handleSpaUrlChanged, getState } = buildHarness({
      lastUrl: 'https://boards.greenhouse.io/acme/jobs/123456',
      currentAnalysis: { title: 'Senior Engineer', matchScore: 88 },
    });

    handleSpaUrlChanged();

    expect(getState().currentAnalysis).toBeNull();
  });
});
