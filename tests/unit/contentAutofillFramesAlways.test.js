// Regression test for AutoFill silently skipping a job posting's real
// application form when it's embedded in a cross-origin <iframe> (e.g.
// Greenhouse's job-boards.greenhouse.io/embed/job_app widget) on a page
// that ALSO has some unrelated field of its own — e.g. the "Search For:"
// site-search box in Precisely's own nav
// (https://www.precisely.com/careers-and-culture/us-jobs/job/?gh_jid=...).
//
// Root cause: autofillForm() only broadcast AUTOFILL_IN_FRAMES to iframes
// when detectFormFields() found ZERO fields in the top frame ("if
// (questions.length === 0)"). On this page, detectFormFields() finds ONE
// field — the unrelated nav search box — so that branch never ran, and the
// real Greenhouse application form sitting inside the iframe was never
// touched: no resume attached, no fields filled, with no error surfaced
// anywhere (AutoFill just reports "success" for having filled the
// irrelevant search box).
//
// Fix: after filling whatever fields the top frame itself found, ALSO
// broadcast AUTOFILL_IN_FRAMES (same message already used for the
// zero-top-frame-fields case) and add its result into the total — cheap
// when there are no iframes, or none with fillable fields.
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom (see contentRadioGroupLabel.test.js). This
// extracts autofillForm() AND fillCurrentAutofillStep() (autofillForm is
// now a thin per-step-loop wrapper around the latter — see the multi-step
// wizard navigation feature) by source range and evals them with small
// stand-ins for their dependencies (detectFormFields, attachResumeFile,
// fillFormFromAnswers, sendMessage, findNextStepButton) so the test
// exercises the real control flow without needing a real DOM form or a
// real AI call. findNextStepButton stubbed to always return null here —
// this suite is about the single-step iframe-broadcast behavior, not
// wizard-step navigation (see findNextStepButton.test.js for that).
import {
  describe, it, expect, beforeEach,
} from 'vitest';
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
 * @param {Object} opts
 * @param {Array}  opts.topFrameQuestions - what detectFormFields() should "find" in the top frame.
 * @param {number} opts.aiFilled - how many fields fillFormFromAnswers() should report filled.
 * @param {number} opts.iframeFilled - what AUTOFILL_IN_FRAMES should report.
 * @param {Array}  opts.sentMessages - array this call pushes every sendMessage(msg) call onto.
 * @param {Array}  opts.statusMessages - array this call pushes every setStatus(msg) call onto.
 */
function buildAutofillForm({
  topFrameQuestions, aiFilled, iframeFilled, sentMessages, statusMessages,
}) {
  document.body.innerHTML = `
    <div id="jmAutofill"></div>
    <div id="jmAutofillWarning" style="display:none"></div>
  `;
  const shadowRoot = document; // getElementById behaves the same for this test's purposes

  const factory = new Function( // eslint-disable-line no-new-func
    'shadowRoot', 'topFrameQuestions', 'aiFilled', 'iframeFilled', 'sentMessages', 'statusMessages',
    `
    let _fieldMap = {};
    let _activeResumeId = 'r1';
    let _resumeFileFields = [];
    let _coverLetterFileFields = [];
    let currentAnalysis = null;
    let _autoBidAutofillRun = true;
    const MAX_AUTOFILL_STEPS = 10;
    function findNextStepButton() { return null; }
    async function waitForDomSettled() {}
    async function waitForFormFieldsReady() {}
    function hasVisibleValidationErrors() { return false; }
    function clearAutofillBadges() {}
    async function ensureBestResumeSelected() {}
    function detectFormFields() { return topFrameQuestions; }
    async function attachResumeFile() { return { attached: 0, fileName: null }; }
    async function attachCoverLetterFile() { return { attached: 0, fileName: null }; }
    function findCoverLetterAttachTrigger() { return null; }
    async function fillFormFromAnswers(answers) { return { filled: aiFilled, skipped: [] }; }
    function setStatus(msg) { statusMessages.push(msg); }
    function clearStatus() {}
    async function sendMessage(msg) {
      sentMessages.push(msg);
      switch (msg.type) {
        case 'GET_QA_LIST': return [];
        case 'GET_PROFILE': return {};
        case 'GENERATE_AUTOFILL': return { answers: [] };
        case 'AUTOFILL_IN_FRAMES': return { filled: iframeFilled };
        default: return {};
      }
    }
    ${AUTOFILL_FORM_SRC}
    return autofillForm;
    `,
  );
  return factory(shadowRoot, topFrameQuestions, aiFilled, iframeFilled, sentMessages, statusMessages);
}

describe('content.js autofillForm — broadcasts to iframes even when the top frame already has fields', () => {
  let sentMessages;
  let statusMessages;

  beforeEach(() => {
    sentMessages = [];
    statusMessages = [];
    delete window.__jobMatchDirectFill;
    delete window.__jobMatchFilledLabels;
  });

  it('still tries AUTOFILL_IN_FRAMES when the top frame found a field of its own (Precisely nav search box case)', async () => {
    const topFrameQuestions = [
      { question_id: 'search', question_text: 'Search For', field_type: 'text', required: false },
    ];
    const autofillForm = buildAutofillForm({
      topFrameQuestions, aiFilled: 1, iframeFilled: 3, sentMessages, statusMessages,
    });

    await autofillForm();

    const broadcasts = sentMessages.filter((m) => m.type === 'AUTOFILL_IN_FRAMES');
    expect(broadcasts.length).toBe(1); // the old code never sent this when topFrameQuestions.length > 0

    const finalStatus = statusMessages[statusMessages.length - 1];
    // 1 (AI-filled search box) + 3 (filled inside the Greenhouse iframe) = 4
    expect(finalStatus).toContain('Filled 4 field');
    expect(finalStatus).toContain('embedded form');
  });

  it('does not regress the existing zero-top-frame-fields path', async () => {
    const autofillForm = buildAutofillForm({
      topFrameQuestions: [], aiFilled: 0, iframeFilled: 5, sentMessages, statusMessages,
    });

    await autofillForm();

    const broadcasts = sentMessages.filter((m) => m.type === 'AUTOFILL_IN_FRAMES');
    expect(broadcasts.length).toBe(1);
    const finalStatus = statusMessages[statusMessages.length - 1];
    expect(finalStatus).toContain('Filled 5 field');
  });

  it('reports the top frame\'s own count correctly when there are no iframes at all', async () => {
    const topFrameQuestions = [
      { question_id: 'q1', question_text: 'Full Name', field_type: 'text', required: true },
    ];
    const autofillForm = buildAutofillForm({
      topFrameQuestions, aiFilled: 1, iframeFilled: 0, sentMessages, statusMessages,
    });

    await autofillForm();

    const finalStatus = statusMessages[statusMessages.length - 1];
    expect(finalStatus).toContain('Filled 1 field');
    expect(finalStatus).not.toContain('embedded form');
  });
});
