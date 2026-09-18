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
function buildCheckPendingAutoBidAutofill({ pendingResponse, calls }) {
  const factory = new Function( // eslint-disable-line no-new-func
    'pendingResponse', 'calls',
    `
    let panelOpen = false;
    let currentAnalysis = null;
    let _activeResumeId = 'original-resume';
    async function sendMessage(msg) {
      calls.push({ type: 'sendMessage', msg });
      if (msg.type === 'GET_AND_CLEAR_PENDING_AUTOFILL') return pendingResponse;
      return {};
    }
    function togglePanel() { panelOpen = true; calls.push({ type: 'togglePanel' }); }
    async function waitForDomSettled() { calls.push({ type: 'waitForDomSettled' }); }
    async function waitForFormFieldsReady() { calls.push({ type: 'waitForFormFieldsReady' }); }
    async function autofillForm() { calls.push({ type: 'autofillForm' }); }
    ${FN_SRC}
    return {
      checkPendingAutoBidAutofill,
      getState: () => ({ currentAnalysis, _activeResumeId, panelOpen }),
    };
    `,
  );
  return factory(pendingResponse, calls);
}

describe('checkPendingAutoBidAutofill — restores analysis/resume across the Apply-click navigation', () => {
  let calls;

  beforeEach(() => {
    calls = [];
  });

  it('restores currentAnalysis and _activeResumeId from the pending payload before autofilling', async () => {
    const analysis = { matchScore: 88, matchingSkills: ['Python', 'TypeScript'], company: 'Donato Technologies Inc', title: 'Senior SWE' };
    const { checkPendingAutoBidAutofill, getState } = buildCheckPendingAutoBidAutofill({
      pendingResponse: { pending: true, analysis, activeResumeId: 'resume-42' },
      calls,
    });

    await checkPendingAutoBidAutofill();

    const state = getState();
    expect(state.currentAnalysis).toEqual(analysis);
    expect(state._activeResumeId).toBe('resume-42');
    expect(state.panelOpen).toBe(true);
    expect(calls.map(c => c.type)).toEqual(['sendMessage', 'togglePanel', 'waitForDomSettled', 'waitForFormFieldsReady', 'autofillForm']);
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
});
