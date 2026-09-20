// Regression/feature test for AutoFill's multi-step wizard navigation:
// after filling a step, if the page has a "Next"-style control
// (findNextStepButton()), AutoFill clicks it, waits for the new step to
// render, and fills that step too — repeating up to MAX_AUTOFILL_STEPS.
// Confirmed needed on Dice's application wizard, whose Resume & Cover
// Letter step is only step 1 of 3.
//
// The safety property under test here is that this loop is driven
// entirely by findNextStepButton() (tested for correctness separately in
// findNextStepButton.test.js) — it stops the moment that returns null, and
// is hard-capped at MAX_AUTOFILL_STEPS regardless, so a page that always
// reports a "next" button can't loop forever.
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom (see contentRadioGroupLabel.test.js), so this
// extracts autofillForm() and fillCurrentAutofillStep() by source range
// and evals them with small stand-ins for their dependencies.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');
const SRC = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

const START_MARKER = 'async function autofillForm() {';
const END_MARKER = '\n  // ─── Form field detection ─────────────────────────────────────';
const START = SRC.indexOf(START_MARKER);
const END = SRC.indexOf(END_MARKER);
if (START === -1 || END === -1 || END <= START) {
  throw new Error('content.js source anchors moved — update this test\'s extraction markers');
}
const AUTOFILL_FORM_SRC = SRC.slice(START, END);

/**
 * Builds a runnable autofillForm() with stubbed dependencies.
 * @param {Object}   opts
 * @param {number}   opts.stepCount - how many times findNextStepButton() should return a button before returning null.
 * @param {number}   [opts.maxSteps=10] - MAX_AUTOFILL_STEPS override, for testing the cap itself.
 * @param {boolean}  [opts.isAutoBid=true] - _autoBidAutofillRun's value — false simulates a manual "AutoFill Application" click.
 * @param {number}   [opts.errorAfterClicks=Infinity] - hasVisibleValidationErrors() starts returning true once
 *   the "Next" button has been clicked this many times — simulates a step whose required field AutoFill
 *   couldn't satisfy, so clicking Next just re-renders the same step with a validation error.
 * @param {Array}    opts.calls - array this call pushes tagged events onto.
 * @param {Array}    [opts.statusMessages] - array setStatus(msg) calls are pushed onto.
 */
function buildAutofillForm({
  stepCount, maxSteps = 10, isAutoBid = true, errorAfterClicks = Infinity, calls, statusMessages = [],
}) {
  document.body.innerHTML = `
    <div id="jmAutofill"></div>
    <div id="jmAutofillWarning" style="display:none"></div>
  `;
  const shadowRoot = document;

  const factory = new Function( // eslint-disable-line no-new-func
    'shadowRoot', 'stepCount', 'maxSteps', 'isAutoBid', 'errorAfterClicks', 'calls', 'statusMessages',
    `
    let _fieldMap = {};
    let _activeResumeId = 'r1';
    let _resumeFileFields = [];
    let _coverLetterFileFields = [];
    let currentAnalysis = null;
    let _autoBidAutofillRun = isAutoBid;
    const MAX_AUTOFILL_STEPS = maxSteps;
    let nextButtonsRemaining = stepCount;
    let nextClickCount = 0;
    function findNextStepButton() {
      calls.push({ type: 'findNextStepButton', remaining: nextButtonsRemaining });
      if (nextButtonsRemaining <= 0) return null;
      nextButtonsRemaining--;
      const btn = document.createElement('button');
      btn.textContent = 'Next';
      btn.addEventListener('click', () => { nextClickCount++; calls.push({ type: 'nextButtonClicked' }); });
      return btn;
    }
    async function waitForDomSettled() { calls.push({ type: 'waitForDomSettled' }); }
    async function waitForFormFieldsReady() { calls.push({ type: 'waitForFormFieldsReady' }); }
    function hasVisibleValidationErrors() { return nextClickCount >= errorAfterClicks; }
    function clearAutofillBadges() {}
    async function ensureBestResumeSelected() {}
    function detectFormFields() { calls.push({ type: 'detectFormFields' }); return []; }
    async function attachResumeFile() { return { attached: 0, fileName: null }; }
    async function attachCoverLetterFile() { return { attached: 0, fileName: null }; }
    function findCoverLetterAttachTrigger() { return null; }
    async function fillFormFromAnswers() { return { filled: 0, skipped: [] }; }
    function setStatus(msg) { statusMessages.push(msg); }
    function clearStatus() {}
    async function sendMessage(msg) {
      if (msg.type === 'AUTOFILL_IN_FRAMES') return { filled: 0 };
      return {};
    }
    ${AUTOFILL_FORM_SRC}
    return autofillForm;
    `,
  );
  return factory(shadowRoot, stepCount, maxSteps, isAutoBid, errorAfterClicks, calls, statusMessages);
}

describe('autofillForm — multi-step wizard navigation', () => {
  let calls;

  beforeEach(() => {
    calls = [];
    delete window.__jobMatchDirectFill;
    delete window.__jobMatchFilledLabels;
  });

  it('fills a single-step form once and stops (no Next button ever found)', async () => {
    const autofillForm = buildAutofillForm({ stepCount: 0, calls });
    await autofillForm();

    expect(calls.filter(c => c.type === 'detectFormFields').length).toBe(1);
    expect(calls.filter(c => c.type === 'nextButtonClicked').length).toBe(0);
  });

  it('clicks through a 3-step wizard, filling each step, then stops (the Dice case)', async () => {
    const autofillForm = buildAutofillForm({ stepCount: 2, calls }); // 2 "Next" clicks -> 3 steps filled total
    await autofillForm();

    expect(calls.filter(c => c.type === 'detectFormFields').length).toBe(3);
    expect(calls.filter(c => c.type === 'nextButtonClicked').length).toBe(2);
    expect(calls.filter(c => c.type === 'waitForDomSettled').length).toBe(2);
    expect(calls.filter(c => c.type === 'waitForFormFieldsReady').length).toBe(2);
  });

  it('never exceeds MAX_AUTOFILL_STEPS even if a "Next" button is always found', async () => {
    const autofillForm = buildAutofillForm({ stepCount: 999, maxSteps: 4, calls });
    await autofillForm();

    expect(calls.filter(c => c.type === 'detectFormFields').length).toBe(4);
    expect(calls.filter(c => c.type === 'nextButtonClicked').length).toBe(4);
  });
});

describe('autofillForm — never advances steps outside Auto-Bid (manual "AutoFill Application" click)', () => {
  let calls;

  beforeEach(() => {
    calls = [];
  });

  it('fills only the current step and never clicks Next when _autoBidAutofillRun is false', async () => {
    // A "Next" button IS present (stepCount: 2 says findNextStepButton
    // would return one twice), but this is a manual click (isAutoBid:
    // false) — the loop must never even ask for one.
    const autofillForm = buildAutofillForm({ stepCount: 2, isAutoBid: false, calls });
    await autofillForm();

    expect(calls.filter(c => c.type === 'detectFormFields').length).toBe(1);
    expect(calls.filter(c => c.type === 'findNextStepButton').length).toBe(0);
    expect(calls.filter(c => c.type === 'nextButtonClicked').length).toBe(0);
  });
});

describe('autofillForm — stops instead of looping when a step won\'t actually advance (the real bug)', () => {
  let calls;
  let statusMessages;

  beforeEach(() => {
    calls = [];
    statusMessages = [];
  });

  it('stops after Next re-renders the same step with a validation error, instead of clicking Next repeatedly', async () => {
    // Simulates Dice's real failure: a required field (Google-Places-backed
    // location autocomplete) AutoFill couldn't satisfy — clicking "Next"
    // re-renders the SAME step with aria-invalid/role="alert" markup rather
    // than advancing. errorAfterClicks: 1 means the FIRST Next click already
    // fails validation.
    const autofillForm = buildAutofillForm({
      stepCount: 999, errorAfterClicks: 1, calls, statusMessages,
    });
    await autofillForm();

    // One step filled, one Next click attempted, then STOP — not the 10-step cap.
    expect(calls.filter(c => c.type === 'detectFormFields').length).toBe(1);
    expect(calls.filter(c => c.type === 'nextButtonClicked').length).toBe(1);
    expect(statusMessages.some(m => /could not be filled automatically/i.test(m))).toBe(true);
  });

  it('keeps advancing through steps that succeed, and only stops once one actually fails', async () => {
    const autofillForm = buildAutofillForm({
      stepCount: 999, errorAfterClicks: 2, calls, statusMessages,
    });
    await autofillForm();

    // Step 1's Next click succeeds (nextClickCount 1 < errorAfterClicks 2),
    // so the loop continues; step 2 is filled, its OWN Next click is the
    // one that trips the validation error (nextClickCount reaches 2), and
    // the loop stops there rather than attempting a step 3.
    expect(calls.filter(c => c.type === 'detectFormFields').length).toBe(2);
    expect(calls.filter(c => c.type === 'nextButtonClicked').length).toBe(2);
    expect(statusMessages.some(m => /could not be filled automatically/i.test(m))).toBe(true);
  });
});
