// Tests for Auto-Bid's fully-automated analyze step.
//
// Behavior (user request): when the best of the (up to 3) compared resumes
// still scores at or below MIN_SCORE_TO_APPLY (75), Auto-Bid automatically
// runs the same "Improve Resume Bullets" -> "Generate Tailored Resume"
// flow a user would trigger manually (skipping the manual review step,
// since this runs unattended), then re-checks the TAILORED resume's own
// re-scored match against the same bar. If tailoring pushed it over,
// Auto-Bid marks the tailored resume as the one in view
// (_tailoredSlotActive) and continues using it for the rest of this
// application (AutoFill's actual attachment reads that flag via
// buildActiveResumeFile — see its own test file). If tailoring still
// doesn't clear the bar, it stops there rather than auto-applying with a
// resume that still doesn't genuinely match.
//
// Regression this file locks in: rewriteBullets() and generateTailoredResume()
// both catch their own errors internally and render them into the panel
// instead of throwing — a try/catch around them here would NEVER fire, so
// a failure inside either one (no bullets generated, DOCX_REQUIRED, an AI
// error, ...) used to be a silent no-op with no way to tell why the
// tailored resume never showed up. Success is now verified by checking
// what each step actually produced.
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom, so this extracts just
// autoAnalyzeAndMaybeAutofill() by source range and evals it with small
// stand-ins for its dependencies.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');
const SRC = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

const START_MARKER = 'async function autoAnalyzeAndMaybeAutofill() {';
const END_MARKER = '\n\n  /**\n   * Checked once, on every fresh top-frame page load';
const START = SRC.indexOf(START_MARKER);
const END = SRC.indexOf(END_MARKER);
if (START === -1 || END === -1 || END <= START) {
  throw new Error('content.js source anchors moved — update this test\'s extraction markers');
}
const FN_SRC = SRC.slice(START, END);

/**
 * Builds a runnable autoAnalyzeAndMaybeAutofill() with stubbed
 * dependencies and a `calls` log for the side-effecting functions.
 * @param {Object} opts
 * @param {number|null} opts.matchScore - currentAnalysis.matchScore after the stubbed analyzeJob() "runs".
 * @param {number} [opts.bulletCount=1] - how many `.jm-bullet-item` elements exist after rewriteBullets() "runs".
 * @param {string} [opts.bulletListText] - jmBulletList's text if rewriteBullets() produced nothing.
 * @param {boolean} [opts.generateSucceeds=true] - whether generateTailoredResume() actually sets _tailoredResumeSlot.
 * @param {number|null} [opts.tailoredScore] - _tailoredResumeSlot.newScore when generation succeeds.
 * @param {string} [opts.tailoredStatusText] - jmTailoredResumeStatus's text if generation failed.
 * @param {boolean} [opts.tailorResumeEnabled=true] - the Auto-Bid tab's "tailor resume" setting.
 */
function buildHarness({
  matchScore, bulletCount = 1, bulletListText = '', generateSucceeds = true, tailoredScore = null, tailoredStatusText = '',
  tailorResumeEnabled = true,
}) {
  const calls = [];
  const factory = new Function( // eslint-disable-line no-new-func
    'calls', 'matchScore', 'bulletCount', 'bulletListText', 'generateSucceeds', 'tailoredScore', 'tailoredStatusText', 'tailorResumeEnabled',
    `
    const MIN_SCORE_TO_APPLY = 75;
    let currentAnalysis = null;
    let _tailoredResumeSlot = null;
    let _tailoredSlotActive = false;
    const fakeBulletItems = new Array(bulletCount).fill({});
    const shadowRoot = {
      querySelectorAll: (sel) => sel === '.jm-bullet-item' ? fakeBulletItems : [],
      getElementById: (id) => {
        if (id === 'jmBulletList') return { textContent: bulletListText };
        if (id === 'jmTailoredResumeStatus') return { textContent: tailoredStatusText };
        return null;
      },
    };
    async function waitForJobDescriptionReady() { calls.push('waitForJobDescriptionReady'); }
    async function analyzeJob() {
      calls.push('analyzeJob');
      currentAnalysis = matchScore === null ? null : { matchScore };
    }
    // Not logged to \`calls\` — every existing test below asserts an exact
    // call sequence that predates this setting, and this read is an
    // implementation detail of the gate itself, not a user-visible step.
    async function sendMessage(msg) {
      if (msg.type === 'GET_AUTOBID_SETTINGS') return { tailorResumeEnabled };
      return {};
    }
    async function autoClickApplyThenAutofillIfNeeded() { calls.push('autoClickApplyThenAutofillIfNeeded'); }
    async function rewriteBullets() { calls.push('rewriteBullets'); }
    async function generateTailoredResume() {
      calls.push('generateTailoredResume');
      if (generateSucceeds) _tailoredResumeSlot = { newScore: tailoredScore };
    }
    function renderSlotSwitcher() { calls.push('renderSlotSwitcher'); }
    ${FN_SRC}
    return { autoAnalyzeAndMaybeAutofill, getState: () => ({ _tailoredSlotActive }) };
    `,
  );
  return { ...factory(calls, matchScore, bulletCount, bulletListText, generateSucceeds, tailoredScore, tailoredStatusText, tailorResumeEnabled), calls };
}

describe('autoAnalyzeAndMaybeAutofill', () => {
  let calls;
  let warnSpy;
  beforeEach(() => {
    calls = [];
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { warnSpy.mockRestore(); });

  it('autofills automatically when the best resume already clears the threshold (no regression)', async () => {
    const { autoAnalyzeAndMaybeAutofill, calls: log, getState } = buildHarness({ matchScore: 88 });
    await autoAnalyzeAndMaybeAutofill();
    expect(log).toEqual(['waitForJobDescriptionReady', 'analyzeJob', 'autoClickApplyThenAutofillIfNeeded']);
    expect(getState()._tailoredSlotActive).toBe(false);
  });

  it('auto-tailors when the best resume is at or below the threshold, then autofills using it once tailoring clears the bar', async () => {
    const { autoAnalyzeAndMaybeAutofill, calls: log, getState } = buildHarness({ matchScore: 62, bulletCount: 5, tailoredScore: 82 });
    await autoAnalyzeAndMaybeAutofill();
    expect(log).toEqual([
      'waitForJobDescriptionReady', 'analyzeJob',
      'rewriteBullets', 'generateTailoredResume',
      'renderSlotSwitcher', 'autoClickApplyThenAutofillIfNeeded',
    ]);
    expect(getState()._tailoredSlotActive).toBe(true); // "continues using" the tailored resume
  });

  it('does NOT autofill when tailoring still does not clear the bar', async () => {
    const { autoAnalyzeAndMaybeAutofill, calls: log, getState } = buildHarness({ matchScore: 62, bulletCount: 5, tailoredScore: 68 });
    await autoAnalyzeAndMaybeAutofill();
    expect(log).toEqual(['waitForJobDescriptionReady', 'analyzeJob', 'rewriteBullets', 'generateTailoredResume']);
    expect(log).not.toContain('autoClickApplyThenAutofillIfNeeded');
    expect(getState()._tailoredSlotActive).toBe(false);
  });

  it('does NOT autofill when the re-score after tailoring succeeded but came back null', async () => {
    const { autoAnalyzeAndMaybeAutofill, calls: log } = buildHarness({ matchScore: 62, bulletCount: 5, tailoredScore: null });
    await autoAnalyzeAndMaybeAutofill();
    expect(log).not.toContain('autoClickApplyThenAutofillIfNeeded');
  });

  // The actual bug: both of these used to be silent, unexplained no-ops.
  it('stops and logs a reason when Improve Resume Bullets produces no bullets', async () => {
    const { autoAnalyzeAndMaybeAutofill, calls: log } = buildHarness({
      matchScore: 62, bulletCount: 0, bulletListText: 'No bullet improvements generated.',
    });
    await autoAnalyzeAndMaybeAutofill();
    expect(log).toEqual(['waitForJobDescriptionReady', 'analyzeJob', 'rewriteBullets']);
    expect(log).not.toContain('generateTailoredResume');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Improve Resume Bullets produced nothing'),
      'No bullet improvements generated.',
    );
  });

  it('stops and logs a reason when Generate Tailored Resume fails (the slot never actually changes)', async () => {
    const { autoAnalyzeAndMaybeAutofill, calls: log } = buildHarness({
      matchScore: 62, bulletCount: 5, generateSucceeds: false, tailoredStatusText: 'DOCX required — please upload your resume as .docx.',
    });
    await autoAnalyzeAndMaybeAutofill();
    expect(log).toEqual(['waitForJobDescriptionReady', 'analyzeJob', 'rewriteBullets', 'generateTailoredResume']);
    expect(log).not.toContain('autoClickApplyThenAutofillIfNeeded');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Generate Tailored Resume failed'),
      'DOCX required — please upload your resume as .docx.',
    );
  });

  it('treats a score exactly at the threshold as not-strong-enough (tailors, does not autofill directly)', async () => {
    const { calls: log, autoAnalyzeAndMaybeAutofill } = buildHarness({ matchScore: 75, bulletCount: 5, tailoredScore: 90 });
    await autoAnalyzeAndMaybeAutofill();
    expect(log).toContain('rewriteBullets');
  });

  // The Auto-Bid tab's "Automatically generate a tailored resume" checkbox
  // (profile.html/profile.js, GET_AUTOBID_SETTINGS/SAVE_AUTOBID_SETTINGS in
  // background.js) — an explicit false must skip tailoring entirely.
  it('skips tailoring entirely when the user has disabled it in Auto-Bid settings', async () => {
    const { autoAnalyzeAndMaybeAutofill, calls: log } = buildHarness({
      matchScore: 62, bulletCount: 5, tailoredScore: 90, tailorResumeEnabled: false,
    });
    await autoAnalyzeAndMaybeAutofill();
    expect(log).toEqual(['waitForJobDescriptionReady', 'analyzeJob']);
    expect(log).not.toContain('rewriteBullets');
    expect(log).not.toContain('generateTailoredResume');
  });

  it('still tailors when the setting is left at its default (enabled) — no regression', async () => {
    const { autoAnalyzeAndMaybeAutofill, calls: log } = buildHarness({
      matchScore: 62, bulletCount: 5, tailoredScore: 90,
    });
    await autoAnalyzeAndMaybeAutofill();
    expect(log).toContain('rewriteBullets');
  });

  it('does nothing further when analysis produced no usable score (e.g. analyzeJob failed)', async () => {
    const { autoAnalyzeAndMaybeAutofill, calls: log } = buildHarness({ matchScore: null });
    await autoAnalyzeAndMaybeAutofill();
    expect(log).toEqual(['waitForJobDescriptionReady', 'analyzeJob']);
  });

  it('does not let a thrown error from the strong-match autofill path escape (no regression)', async () => {
    const calls2 = [];
    const factory = new Function( // eslint-disable-line no-new-func
      'calls',
      `
      const MIN_SCORE_TO_APPLY = 75;
      let currentAnalysis = null;
      let _tailoredResumeSlot = null;
      let _tailoredSlotActive = false;
      const shadowRoot = { querySelectorAll: () => [], getElementById: () => null };
      async function waitForJobDescriptionReady() {}
      async function analyzeJob() { currentAnalysis = { matchScore: 90 }; }
      async function autoClickApplyThenAutofillIfNeeded() { calls.push('autoClickApplyThenAutofillIfNeeded'); throw new Error('boom'); }
      async function rewriteBullets() {}
      async function generateTailoredResume() {}
      function renderSlotSwitcher() {}
      ${FN_SRC}
      return { autoAnalyzeAndMaybeAutofill };
      `,
    );
    const { autoAnalyzeAndMaybeAutofill } = factory(calls2);
    await expect(autoAnalyzeAndMaybeAutofill()).resolves.toBeUndefined();
    expect(calls2).toEqual(['autoClickApplyThenAutofillIfNeeded']);
  });
});
