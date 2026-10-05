// Auto-Bid on a multi-step form stopped on a step it couldn't complete (a
// validation error after clicking Next). The user fills the missing field
// and clicks Next themselves — Auto-Bid should then carry on from the step
// they landed on. On Workday the step changes WITHOUT a URL change, so
// neither the SPA URL-change hook nor a page load ever resumed it.
//
// watchForManualStepAdvance() polls for the step to change (and the errors
// to clear), then resumes through checkPendingAutoBidAutofill().
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');

let SECTION;

beforeAll(() => {
  const src = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('  /**\n   * A cheap fingerprint of which wizard step is on screen');
  const end = src.indexOf('  /**\n   * Initiates the autofill pipeline', start);
  if (start === -1 || end === -1) throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  SECTION = src.slice(start, end);
});

/** Workday-like step: progress bar label + a field that fails validation. */
function renderStep(label, { error = false } = {}) {
  document.body.innerHTML = `
    <ol data-automation-id="progressBar">
      <li data-automation-id="progressBarActiveStep"><label>current step ${label}</label></li>
    </ol>
    <h3>${label}</h3>
    <input id="field-1" type="text" ${error ? 'aria-invalid="true"' : ''}>
  `;
}

function load() {
  const state = { _analyzeGen: 1, _autoBidAutofillRun: false, _autoBidContinuationActive: false };
  const calls = [];
  const factory = new Function('state', 'calls', ` // eslint-disable-line no-new-func
    const currentAnalysis = { matchScore: 88 };
    const _activeResumeId = 'resume-1';
    const _tailoredSlotActive = false;
    const _tailoredResumeSlot = null;
    async function sendMessage(msg) { calls.push(msg.type); return {}; }
    async function waitForDomSettled() {}
    function hasVisibleValidationErrors() { return !!document.querySelector('[aria-invalid="true"]'); }
    async function checkPendingAutoBidAutofill() { calls.push('resume'); }
    async function autoClickApplyThenAutofillIfNeeded() {
      calls.push('autoBidFlow');
      if (state.onAutoBidFlow) await state.onAutoBidFlow();
    }
    function setStatus(text) { calls.push({ status: text }); }
    const resumeButton = document.createElement('button');
    resumeButton.id = 'jmResumeAutoBid';
    const shadowRoot = { getElementById: (id) => (id === 'jmResumeAutoBid' ? resumeButton : null) };
    ${SECTION.replace(/_analyzeGen/g, 'state._analyzeGen').replace(/_autoBidAutofillRun/g, 'state._autoBidAutofillRun').replace(/_autoBidContinuationActive/g, 'state._autoBidContinuationActive')}
    return { watchForManualStepAdvance, stopManualStepWatch, getFormStepSignature, resumeAutoBidFromPanel, updateResumeAutoBidButton, resumeButton };
  `);
  return { ...factory(state, calls), state, calls };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('watchForManualStepAdvance', () => {
  it('re-stashes the Auto-Bid state, then resumes once the user moves to the next step', async () => {
    renderStep('3 of 8 My Experience', { error: true });
    const { watchForManualStepAdvance, calls } = load();
    await watchForManualStepAdvance();
    expect(calls).toEqual(['SET_PENDING_AUTOFILL']);

    // The user fills the field — still the same step: keep waiting.
    document.getElementById('field-1').removeAttribute('aria-invalid');
    await vi.advanceTimersByTimeAsync(4000);
    expect(calls).not.toContain('resume');

    // They click Next themselves — Workday swaps the step, URL unchanged.
    renderStep('4 of 8 Application Questions 1 of 2');
    await vi.advanceTimersByTimeAsync(1600);
    expect(calls.filter(c => c === 'resume')).toHaveLength(1);

    // Resumed once only; the poll is gone.
    await vi.advanceTimersByTimeAsync(10000);
    expect(calls.filter(c => c === 'resume')).toHaveLength(1);
  });

  it('does not resume while the new screen still shows a validation error', async () => {
    renderStep('3 of 8 My Experience', { error: true });
    const { watchForManualStepAdvance, calls } = load();
    await watchForManualStepAdvance();
    renderStep('4 of 8 Application Questions 1 of 2', { error: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).not.toContain('resume');
  });

  it('waits while another automated run is already driving the form', async () => {
    renderStep('3 of 8 My Experience', { error: true });
    const { watchForManualStepAdvance, calls, state } = load();
    await watchForManualStepAdvance();
    state._autoBidContinuationActive = true;
    renderStep('4 of 8 Application Questions 1 of 2');
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).not.toContain('resume');
  });

  it('gives up when the user moves on to a different job', async () => {
    renderStep('3 of 8 My Experience', { error: true });
    const { watchForManualStepAdvance, calls, state } = load();
    await watchForManualStepAdvance();
    state._analyzeGen = 2;
    await vi.advanceTimersByTimeAsync(1600);
    renderStep('4 of 8 Application Questions 1 of 2');
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).not.toContain('resume');
  });

  it('gives up after 30 minutes', async () => {
    renderStep('3 of 8 My Experience', { error: true });
    const { watchForManualStepAdvance, calls } = load();
    await watchForManualStepAdvance();
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    renderStep('4 of 8 Application Questions 1 of 2');
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).not.toContain('resume');
  });
});

describe('"Resume Auto Mode" panel button (always visible)', () => {
  it('runs the Auto-Bid flow from the current page and claims any stashed state first', async () => {
    renderStep('3 of 8 My Experience');
    const { resumeAutoBidFromPanel, calls } = load();

    await resumeAutoBidFromPanel();

    expect(calls.indexOf('GET_AND_CLEAR_PENDING_AUTOFILL')).toBeGreaterThan(-1);
    expect(calls.indexOf('GET_AND_CLEAR_PENDING_AUTOFILL')).toBeLessThan(calls.indexOf('autoBidFlow'));
  });

  it('stops a waiting watcher so it cannot start a second run', async () => {
    renderStep('3 of 8 My Experience', { error: true });
    const { watchForManualStepAdvance, resumeAutoBidFromPanel, calls } = load();
    await watchForManualStepAdvance();

    await resumeAutoBidFromPanel();
    renderStep('4 of 8 Application Questions 1 of 2');
    await vi.advanceTimersByTimeAsync(5000);

    expect(calls.filter(c => c === 'autoBidFlow')).toHaveLength(1);
    expect(calls).not.toContain('resume');
  });

  it('ignores a second click while a run is still going', async () => {
    renderStep('3 of 8 My Experience');
    const { resumeAutoBidFromPanel, calls, state, resumeButton } = load();
    let finish;
    state.onAutoBidFlow = () => new Promise(r => { finish = r; });

    const first = resumeAutoBidFromPanel();
    await vi.advanceTimersByTimeAsync(0);
    // Greyed out with a spinner for the whole run.
    expect(resumeButton.disabled).toBe(true);
    expect(resumeButton.textContent).toContain('Auto Mode running');
    await resumeAutoBidFromPanel();
    expect(calls.filter(c => c === 'autoBidFlow')).toHaveLength(1);
    expect(calls).toContainEqual({ status: 'Auto Mode is already running on this page.' });

    finish();
    await first;
    state.onAutoBidFlow = null;
    expect(resumeButton.disabled).toBe(false);
    await resumeAutoBidFromPanel(); // free again once the first run ends
    expect(calls.filter(c => c === 'autoBidFlow')).toHaveLength(2);
  });
});

describe('updateResumeAutoBidButton', () => {
  it('stays disabled while a run driven by another path is going (e.g. the URL-change hop after Apply)', () => {
    const { updateResumeAutoBidButton, resumeButton, state } = load();
    updateResumeAutoBidButton();
    expect(resumeButton.disabled).toBe(false);
    expect(resumeButton.textContent).toContain('Resume Auto Mode');

    state._autoBidContinuationActive = true; // checkPendingAutoBidAutofill() running
    updateResumeAutoBidButton();
    expect(resumeButton.disabled).toBe(true);

    state._autoBidContinuationActive = false;
    state._autoBidAutofillRun = true; // the step-by-step AutoFill loop
    updateResumeAutoBidButton();
    expect(resumeButton.disabled).toBe(true);

    state._autoBidAutofillRun = false;
    updateResumeAutoBidButton();
    expect(resumeButton.disabled).toBe(false);
    expect(resumeButton.textContent).toContain('Resume Auto Mode');
  });
});

describe('getFormStepSignature', () => {
  it('ignores typing but changes with the step (Workday progress bar)', () => {
    renderStep('3 of 8 My Experience');
    const { getFormStepSignature } = load();
    const before = getFormStepSignature();
    document.getElementById('field-1').value = 'typed';
    expect(getFormStepSignature()).toBe(before);
    renderStep('4 of 8 Application Questions 1 of 2');
    expect(getFormStepSignature()).not.toBe(before);
  });

  it('uses headings and field ids when there is no progress bar', () => {
    document.body.innerHTML = '<h2>Step 1: Contact</h2><input id="email">';
    const { getFormStepSignature } = load();
    const before = getFormStepSignature();
    document.body.innerHTML = '<h2>Step 2: Questions</h2><input id="q1">';
    expect(getFormStepSignature()).not.toBe(before);
  });
});
