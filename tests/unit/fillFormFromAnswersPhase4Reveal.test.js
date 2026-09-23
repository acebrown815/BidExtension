// Regression test for a real bug found live on a Greenhouse application
// form: "Please identify your race" was never filled, even though its
// structurally identical sibling "Are you Hispanic/Latino?" filled
// correctly every time. Root cause: the "race" dropdown doesn't exist in
// the DOM at all until AFTER "Are you Hispanic/Latino?" is answered — the
// page renders it in at runtime. detectFormFields() necessarily takes its
// one snapshot of the page BEFORE any field is filled, so it can never see
// a field that only appears as a result of answering an earlier one, and
// nothing previously re-checked the page after Phase 3 finished.
//
// Fix: fillFormFromAnswers() now runs a Phase 4 sweep after Phase 3 —
// re-scanning the live DOM for custom-dropdown-shaped inputs whose
// id/name was never part of the original detection pass, filling any it
// finds, and repeating (bounded) since one revealed field can itself
// reveal another.
//
// content.js is too large to load wholesale under happy-dom, so this
// extracts fillFormFromAnswers() by source range (same extraction used by
// fillFormFromAnswersZipShortcut.test.js) and evals it with small
// hand-written stand-ins for its dependencies — including real,
// document-attached elements so Phase 4's own document.querySelectorAll
// scan has something real to find.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');
const SRC = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

const START_MARKER = 'async function fillFormFromAnswers(answers) {';
const END_MARKER = '/**\n   * Legacy fill path for old-format AI responses';
const START = SRC.indexOf(START_MARKER);
const END = SRC.indexOf(END_MARKER);
if (START === -1 || END === -1 || END <= START) {
  throw new Error('content.js source anchors moved — update this test\'s extraction markers');
}
const FN_SRC = SRC.slice(START, END);

function buildFillFormFromAnswers({ fieldMap, revealedElsByQid = {}, calls = [] }) {
  const factory = new Function( // eslint-disable-line no-new-func
    'fieldMap', 'calls', 'revealedElsByQid',
    `
    const _fieldMap = fieldMap;
    const _activeResumeId = 'r1';
    function showAutofillBadge() {}
    function fillRadioFromRef() { return true; }
    function fillCheckboxFromRef() {}
    function fillInput() {}
    function fillSelectByText() {}
    async function sendMessage() { return {}; }
    async function fillCustomDropdown(el, questionText) {
      calls.push({ type: 'fillCustomDropdown', questionText, qid: el && el.id });
      return true;
    }
    async function fillFormLegacy() { return { filled: 0, skipped: [] }; }
    async function waitForDomSettled() {} // resolves immediately — nothing to actually wait on in this test
    function isFieldEligible() { return true; }
    function isCustomDropdown(el) { return !!revealedElsByQid[el.id]; }
    function getFieldLabel(el) { return (revealedElsByQid[el.id] || {}).label || ''; }
    function readCustomOptions() { return []; }
    ${FN_SRC}
    return fillFormFromAnswers;
    `,
  );
  return factory(fieldMap, calls, revealedElsByQid);
}

describe('fillFormFromAnswers — Phase 4 sweep for dynamically-revealed dropdowns (the actual bug)', () => {
  let calls;

  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('finds and fills a custom dropdown that only appears in the DOM after Phase 3 runs', async () => {
    // hispanic_ethnicity exists from the start and is detected normally.
    const hispanicInput = document.createElement('input');
    hispanicInput.id = 'hispanic_ethnicity';
    document.body.appendChild(hispanicInput);

    // race does NOT exist yet — it's added to the DOM only once
    // fillCustomDropdown() is called for hispanic_ethnicity, mirroring the
    // real page's runtime behavior.
    const fieldMap = {
      hispanic_ethnicity: { el: hispanicInput, type: 'custom_dropdown', questionText: 'Are you Hispanic/Latino?' },
    };

    const revealedElsByQid = { race: { label: 'Please identify your race' } };
    const calls2 = [];
    const factory = new Function( // eslint-disable-line no-new-func
      'fieldMap', 'calls', 'revealedElsByQid',
      `
      const _fieldMap = fieldMap;
      const _activeResumeId = 'r1';
      function showAutofillBadge() {}
      function fillRadioFromRef() { return true; }
      function fillCheckboxFromRef() {}
      function fillInput() {}
      function fillSelectByText() {}
      async function sendMessage() { return {}; }
      async function fillCustomDropdown(el, questionText) {
        calls.push({ type: 'fillCustomDropdown', questionText, qid: el && el.id });
        if (el.id === 'hispanic_ethnicity') {
          const race = document.createElement('input');
          race.id = 'race';
          document.body.appendChild(race);
        }
        return true;
      }
      async function fillFormLegacy() { return { filled: 0, skipped: [] }; }
      async function waitForDomSettled() {}
      function isFieldEligible() { return true; }
      function isCustomDropdown(el) { return !!revealedElsByQid[el.id]; }
      function getFieldLabel(el) { return (revealedElsByQid[el.id] || {}).label || ''; }
      function readCustomOptions() { return []; }
      ${FN_SRC}
      return fillFormFromAnswers;
      `,
    );
    const fillFormFromAnswers = factory(fieldMap, calls2, revealedElsByQid);

    const { filled, skipped } = await fillFormFromAnswers([
      { question_id: 'hispanic_ethnicity', generated_text: 'No' },
    ]);

    expect(calls2.map(c => c.qid)).toEqual(['hispanic_ethnicity', 'race']);
    expect(calls2[1].questionText).toBe('Please identify your race');
    expect(filled).toBe(2);
    expect(skipped).toEqual([]);
  });

  it('does nothing extra when no new dropdown appears (no regression on the common case)', async () => {
    const input = document.createElement('input');
    input.id = 'gender';
    document.body.appendChild(input);
    const fieldMap = { gender: { el: input, type: 'custom_dropdown', questionText: 'Gender' } };
    const fillFormFromAnswers = buildFillFormFromAnswers({ fieldMap, calls });

    const { filled, skipped } = await fillFormFromAnswers([
      { question_id: 'gender', generated_text: 'Male' },
    ]);

    expect(calls).toEqual([{ type: 'fillCustomDropdown', questionText: 'Gender', qid: 'gender' }]);
    expect(filled).toBe(1);
    expect(skipped).toEqual([]);
  });

  it('does not re-fill a field it already knows about, even if still present in the DOM', async () => {
    const input = document.createElement('input');
    input.id = 'gender';
    document.body.appendChild(input);
    const fieldMap = { gender: { el: input, type: 'custom_dropdown', questionText: 'Gender' } };
    // isCustomDropdown would say "yes" for this element too, but it's
    // already handled via customDropdowns[] — the sweep must not double-fill it.
    const fillFormFromAnswers = buildFillFormFromAnswers({
      fieldMap, calls, revealedElsByQid: { gender: { label: 'Gender' } },
    });

    await fillFormFromAnswers([{ question_id: 'gender', generated_text: 'Male' }]);

    expect(calls.length).toBe(1);
  });
});
