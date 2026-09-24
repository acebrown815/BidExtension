// Regression test for a real bug: after Auto-Bid clicks an "Apply Now" /
// "Easy Apply" link that navigates to a SEPARATE page (confirmed on Dice's
// application wizard, https://www.dice.com/job-applications/<id>/wizard),
// content.js's execution context — and every module-level variable in it,
// including currentAnalysis and _activeResumeId — is destroyed. The fresh
// content-script instance that loads on the new page had currentAnalysis
// == null, so a cover-letter-upload field there could never be generated
// (buildCoverLetterFile()/generateCoverLetterText() both require
// currentAnalysis to be set) — even though the job was already analyzed
// and a resume already picked, one page earlier.
//
// Fix: SET_PENDING_AUTOFILL (sent right before the Apply click) now also
// carries the current analysis result and active resume id; the new
// page's checkPendingAutoBidAutofill() restores both from
// GET_AND_CLEAR_PENDING_AUTOFILL's response before running autofillForm().
//
// Follow-up fix (same restore, one more gap): restoring currentAnalysis
// brought the DATA back, but nobody told the shadow-DOM panel to actually
// show it — the fresh page's panel still sat in its default
// "nothing analyzed yet" state, so Mark as Applied/Cover Letter/etc. stayed
// hidden even though the job had genuinely already been analyzed one page
// earlier. checkPendingAutoBidAutofill() now also re-runs the same
// showJobMeta()/renderAnalysis() reveal sequence Analyze Job uses on a
// cache hit (see renderCachedAnalysis).
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom (see contentRadioGroupLabel.test.js), so this
// extracts just checkPendingAutoBidAutofill() by source range and evals it
// with small stand-ins for its dependencies.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');
const SRC = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

const START_MARKER = 'async function checkPendingAutoBidAutofill() {';
const END_MARKER = "\n  chrome.runtime.onMessage.addListener";
const START = SRC.indexOf(START_MARKER);
const END = SRC.indexOf(END_MARKER);
if (START === -1 || END === -1 || END <= START) {
  throw new Error('content.js source anchors moved — update this test\'s extraction markers');
}
const FN_SRC = SRC.slice(START, END);

/**
 * Builds a runnable checkPendingAutoBidAutofill() with stubbed
 * dependencies, plus a getState() escape hatch to inspect the module-level
 * variables it's supposed to restore.
 * @param {Object} opts
 * @param {Object} opts.pendingResponse - what sendMessage(GET_AND_CLEAR_PENDING_AUTOFILL) resolves to.
 * @param {Array}  opts.calls - array this call pushes tagged events onto (togglePanel/autofillForm/waitForFormFieldsReady).
 */
function buildCheckPendingAutoBidAutofill({ pendingResponse, calls, workdayDialogPresent = false }) {
  const factory = new Function( // eslint-disable-line no-new-func
    'pendingResponse', 'calls', 'workdayDialogPresent',
    `
    let panelOpen = false;
    let currentAnalysis = null;
    let _activeResumeId = 'original-resume';
    let _tailoredResumeSlot = null;
    let _tailoredSlotActive = false;
    async function sendMessage(msg) {
      calls.push({ type: 'sendMessage', msg });
      if (msg.type === 'GET_AND_CLEAR_PENDING_AUTOFILL') return pendingResponse;
      return {};
    }
    function togglePanel() { panelOpen = true; calls.push({ type: 'togglePanel' }); }
    async function waitForDomSettled() { calls.push({ type: 'waitForDomSettled' }); }
    async function waitForFormFieldsReady() { calls.push({ type: 'waitForFormFieldsReady' }); }
    async function autofillForm() { calls.push({ type: 'autofillForm' }); }
    async function clickWorkdayAutofillWithResumeIfPresent() {
      calls.push({ type: 'clickWorkdayAutofillWithResumeIfPresent' });
      return workdayDialogPresent;
    }
    function showJobMeta(title, company, location, salary, jobId, language) { calls.push({ type: 'showJobMeta', title, company, location, salary, jobId, language }); }
    function renderAnalysis(data) { calls.push({ type: 'renderAnalysis', data }); }
    function updateMarkAppliedGating(score) { calls.push({ type: 'updateMarkAppliedGating', score }); }
    function renderSlotSwitcher() { calls.push({ type: 'renderSlotSwitcher' }); }
    const _fakeEl = { style: {} };
    const shadowRoot = { getElementById: () => _fakeEl };
    ${FN_SRC}
    return {
      checkPendingAutoBidAutofill,
      getState: () => ({ currentAnalysis, _activeResumeId, panelOpen, _tailoredResumeSlot, _tailoredSlotActive }),
    };
    `,
  );
  return factory(pendingResponse, calls, workdayDialogPresent);
}

describe('checkPendingAutoBidAutofill — restores analysis/resume across the Apply-click navigation', () => {
  let calls;

  beforeEach(() => {
    calls = [];
  });

  it('restores currentAnalysis and _activeResumeId from the pending payload before autofilling, and re-renders the panel so Mark as Applied reappears', async () => {
    const analysis = { matchScore: 88, matchingSkills: ['Python', 'TypeScript'], company: 'Donato Technologies Inc', title: 'Senior SWE' };
    const { checkPendingAutoBidAutofill, getState } = buildCheckPendingAutoBidAutofill({
      pendingResponse: { pending: true, analysis, activeResumeId: 'resume-42' },
      calls,
    });

    await checkPendingAutoBidAutofill();

    const state = getState();
    expect(state.currentAnalysis).toEqual(analysis);
    // The reveal calls actually ran against the restored analysis, not some
    // stale/empty object — this is what was missing before: currentAnalysis
    // came back correctly, but nothing told the panel to show it, so Mark as
    // Applied stayed hidden on the new page even though the job was already
    // analyzed one page earlier.
    const renderCall = calls.find(c => c.type === 'renderAnalysis');
    expect(renderCall.data).toEqual(analysis);
    const gatingCall = calls.find(c => c.type === 'updateMarkAppliedGating');
    expect(gatingCall.score).toBe(88);
    expect(state._activeResumeId).toBe('resume-42');
    expect(state.panelOpen).toBe(true);
    expect(calls.map(c => c.type)).toEqual([
      'sendMessage', 'togglePanel',
      'showJobMeta', 'renderAnalysis', 'updateMarkAppliedGating',
      'waitForDomSettled', 'clickWorkdayAutofillWithResumeIfPresent',
      'waitForFormFieldsReady', 'autofillForm',
    ]);
  });

  it('is a no-op when nothing is pending (the overwhelming majority of page loads)', async () => {
    const { checkPendingAutoBidAutofill, getState } = buildCheckPendingAutoBidAutofill({
      pendingResponse: { pending: false, analysis: null, activeResumeId: null },
      calls,
    });

    await checkPendingAutoBidAutofill();

    const state = getState();
    expect(state.currentAnalysis).toBeNull();
    expect(state._activeResumeId).toBe('original-resume');
    expect(state.panelOpen).toBe(false);
    expect(calls.map(c => c.type)).toEqual(['sendMessage']);
  });

  it('leaves currentAnalysis/_activeResumeId untouched if pending is true but no analysis was carried (defensive)', async () => {
    const { checkPendingAutoBidAutofill, getState } = buildCheckPendingAutoBidAutofill({
      pendingResponse: { pending: true, analysis: null, activeResumeId: null },
      calls,
    });

    await checkPendingAutoBidAutofill();

    const state = getState();
    expect(state.currentAnalysis).toBeNull();
    expect(state._activeResumeId).toBe('original-resume');
    expect(calls.map(c => c.type)).toContain('autofillForm');
  });

  // Regression for the real, follow-up bug: Workday's "Start Your
  // Application" dialog (a plain 3-choice navigation, not a form) can be
  // what this navigation actually landed on, at ANY hop in the chain —
  // not just the very first one. Without recognizing and clicking through
  // it here too, this function fell straight into
  // waitForFormFieldsReady()'s up-to-10s wait for an input field that
  // would never appear, then called autofillForm() on a page with
  // nothing to fill — and, critically, whatever navigation the user (or
  // nothing) triggered afterward was never preceded by its own
  // SET_PENDING_AUTOFILL, so the tailored resume slot could still be lost
  // at this specific, previously-unhandled hop even after the other two
  // call sites were already fixed.
  it('clicks through the Workday dialog and returns early, without ever calling waitForFormFieldsReady/autofillForm', async () => {
    const { checkPendingAutoBidAutofill } = buildCheckPendingAutoBidAutofill({
      pendingResponse: { pending: true, analysis: { matchScore: 88 }, activeResumeId: 'resume-42', tailoredResumeSlot: { name: 'Tailored' } },
      calls,
      workdayDialogPresent: true,
    });

    await checkPendingAutoBidAutofill();

    expect(calls.map(c => c.type)).toContain('clickWorkdayAutofillWithResumeIfPresent');
    expect(calls.map(c => c.type)).not.toContain('waitForFormFieldsReady');
    expect(calls.map(c => c.type)).not.toContain('autofillForm');
  });

  // Regression for the real, follow-up bug: on any ATS where "Apply"
  // navigates to a genuinely new URL (confirmed on Workday), the tailored
  // resume's bytes were silently lost across that navigation — the file
  // that got attached on the new page was the ORIGINAL, untailored resume,
  // completely undoing the auto-tailor step that ran one page earlier.
  it('restores and re-activates the tailored resume slot when one was carried, and re-renders the switcher', async () => {
    const analysis = { matchScore: 88, company: 'Availity', title: 'Cloud Engineer III' };
    const tailoredResumeSlot = { name: 'Resume — Tailored', base64: 'ZmFrZQ==', downloadName: 'Resume_Tailored.docx', newScore: 92, newAnalysis: {}, jobMeta: {} };
    const { checkPendingAutoBidAutofill, getState } = buildCheckPendingAutoBidAutofill({
      pendingResponse: { pending: true, analysis, activeResumeId: 'resume-42', tailoredResumeSlot },
      calls,
    });

    await checkPendingAutoBidAutofill();

    const state = getState();
    expect(state._tailoredResumeSlot).toEqual(tailoredResumeSlot);
    expect(state._tailoredSlotActive).toBe(true);
    expect(calls.map(c => c.type)).toContain('renderSlotSwitcher');
    // renderSlotSwitcher must run AFTER the slot is restored, or it would
    // render against the still-null/inactive state.
    const switcherIdx = calls.findIndex(c => c.type === 'renderSlotSwitcher');
    const autofillIdx = calls.findIndex(c => c.type === 'autofillForm');
    expect(switcherIdx).toBeGreaterThan(-1);
    expect(switcherIdx).toBeLessThan(autofillIdx);
  });

  it('does not touch the tailored slot or call renderSlotSwitcher when none was carried (no regression)', async () => {
    const analysis = { matchScore: 88, company: 'Acme', title: 'Engineer' };
    const { checkPendingAutoBidAutofill, getState } = buildCheckPendingAutoBidAutofill({
      pendingResponse: { pending: true, analysis, activeResumeId: 'resume-42', tailoredResumeSlot: null },
      calls,
    });

    await checkPendingAutoBidAutofill();

    const state = getState();
    expect(state._tailoredResumeSlot).toBeNull();
    expect(state._tailoredSlotActive).toBe(false);
    expect(calls.map(c => c.type)).not.toContain('renderSlotSwitcher');
  });
});
