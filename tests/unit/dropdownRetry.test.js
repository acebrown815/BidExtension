// Live on Workday ("Phone Device Type"): the first AutoFill run left a
// dropdown empty and a second run filled it — the first attempt's opening
// click was spent on closing the PREVIOUS dropdown's popup. fillFormFromAnswers
// now gives each dropdown that failed one more try (Phase 3b) after the page
// settles, unless it got a value in the meantime.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import '../../lib/fieldFilter.js';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js'), 'utf8').replace(/\r\n/g, '\n');
const START = SRC.indexOf('async function fillFormFromAnswers(answers) {');
const END = SRC.indexOf('/**\n   * Legacy fill path for old-format AI responses');
if (START === -1 || END === -1) throw new Error('content.js source anchors moved — update this test\'s extraction markers');
const FN_SRC = SRC.slice(START, END);

/**
 * @param {Object<string, boolean[]>} outcomes - per qid, the result of each successive fillCustomDropdown call
 * @param {Object<string, () => void>} [between] - per qid, a DOM change made after its first failure
 */
function build(fieldMap, outcomes, between = {}) {
  const calls = [];
  const factory = new Function('fieldMap', 'calls', 'outcomes', 'between', ` // eslint-disable-line no-new-func
    const _fieldMap = fieldMap;
    const _activeResumeId = 'r1';
    function showAutofillBadge() {}
    function fillRadioFromRef() { return true; }
    function fillCheckboxFromRef() {}
    function fillInput() {}
    function fillSelectByText() {}
    async function sendMessage() { return {}; }
    const tries = {};
    async function fillCustomDropdown(el) {
      const n = tries[el.id] = (tries[el.id] || 0) + 1;
      calls.push(el.id + '#' + n);
      const ok = (outcomes[el.id] || [])[n - 1] === true;
      if (!ok && n === 1 && between[el.id]) between[el.id]();
      return ok;
    }
    async function fillFormLegacy() { return { filled: 0, skipped: [] }; }
    async function waitForDomSettled() {}
    function isFieldEligible() { return true; }
    const shouldKeepExistingAnswer = (el) => globalThis.JMFieldFilter.shouldKeepExistingAnswer(el);
    const fieldShowsError = (el) => globalThis.JMFieldFilter.fieldShowsError(el);
    const isWorkdayPromptInput = () => false;
    const workdayPromptHasSelection = () => false;
    function isCustomDropdown() { return false; }
    function getFieldLabel() { return ''; }
    function readCustomOptions() { return []; }
    ${FN_SRC}
    return fillFormFromAnswers;
  `);
  return { fill: factory(fieldMap, calls, outcomes, between), calls };
}

function workdayButton(id) {
  const field = document.createElement('div');
  field.setAttribute('data-automation-id', 'formField-' + id);
  field.innerHTML = `<button aria-haspopup="listbox" type="button" value="" id="${id}">Select One</button>`;
  document.body.appendChild(field);
  return field.querySelector('button');
}

afterEach(() => { document.body.innerHTML = ''; });

describe('fillFormFromAnswers — Phase 3b retry for dropdowns that failed the first time', () => {
  it('fills on the second try a dropdown whose first try failed', async () => {
    const phoneType = workdayButton('phoneNumber--phoneType');
    const { fill, calls } = build(
      { 'phoneNumber--phoneType': { el: phoneType, type: 'custom_dropdown', questionText: 'Phone Device Type' } },
      { 'phoneNumber--phoneType': [false, true] },
    );

    const result = await fill([{ question_id: 'phoneNumber--phoneType', selected_option: '' }]);

    expect(calls).toEqual(['phoneNumber--phoneType#1', 'phoneNumber--phoneType#2']);
    expect(result.filled).toBe(1);
    expect(result.skipped).toEqual([]);
  });

  it('retries only once, then reports it as skipped', async () => {
    const state = workdayButton('address--state');
    const { fill, calls } = build(
      { 'address--state': { el: state, type: 'custom_dropdown', questionText: 'State' } },
      { 'address--state': [false, false] },
    );
    const result = await fill([{ question_id: 'address--state', selected_option: '' }]);
    expect(calls).toEqual(['address--state#1', 'address--state#2']);
    expect(result.skipped).toEqual(['address--state']);
  });

  it('does not retry one that got a value in the meantime (e.g. its click landed late)', async () => {
    const phoneType = workdayButton('phoneNumber--phoneType');
    const { fill, calls } = build(
      { 'phoneNumber--phoneType': { el: phoneType, type: 'custom_dropdown', questionText: 'Phone Device Type' } },
      { 'phoneNumber--phoneType': [false] },
      { 'phoneNumber--phoneType': () => { phoneType.setAttribute('value', 'c705db17b0571036dfffec0b6cd2929d'); phoneType.textContent = 'Mobile'; } },
    );
    const result = await fill([{ question_id: 'phoneNumber--phoneType', selected_option: '' }]);
    expect(calls).toEqual(['phoneNumber--phoneType#1']);
    expect(result.skipped).toEqual([]);
  });

  it('never retries one that succeeded', async () => {
    const a = workdayButton('a');
    const { fill, calls } = build({ a: { el: a, type: 'custom_dropdown', questionText: 'A' } }, { a: [true] });
    await fill([{ question_id: 'a', selected_option: '' }]);
    expect(calls).toEqual(['a#1']);
  });
});
