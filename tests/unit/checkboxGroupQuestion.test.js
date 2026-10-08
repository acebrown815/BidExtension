// Live on Greenhouse (job-boards.greenhouse.io/robotsandpencils/jobs/5447044008):
// a "Select all that apply" question is ONE field — <fieldset><legend>question</legend>
// and eight <input type="checkbox" name="question_18916137008[]" required> with
// their own option labels. Auto-Bid refused to submit with
//   not submitting: required fields look empty — ["AWS Bedrock Agents / AgentCore", "Strands Agents", …]
// because each box (each marked `required`) was checked on its own — while
// "LangGraph" WAS ticked, which is all the question needs.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../../lib/fieldFilter.js';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js'), 'utf8').replace(/\r\n/g, '\n');
const slice = (a, b) => {
  const start = SRC.indexOf(a);
  const end = SRC.indexOf(b, start);
  if (start === -1 || end === -1) throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  return SRC.slice(start, end);
};

const OPTIONS = [
  ['45651498008', 'LangGraph'],
  ['45651499008', 'AWS Bedrock Agents / AgentCore'],
  ['45651500008', 'Strands Agents'],
  ['45651501008', 'CrewAI / AutoGen'],
  ['45651502008', 'Temporal or Step Functions orchestrating agent workflows'],
  ['45651503008', 'Custom orchestration (no framework)'],
  ['45651504008', 'Built agents, but not yet in production'],
  ['45651505008', "Haven't built agentic systems yet"],
];
const QUESTION = 'Which have you used to build a multi-agent or agentic system that reached production? (Select all that apply)';

// Verbatim (SVGs dropped) from the live page.
const GROUP_HTML = `
  <div class="field-wrapper"><fieldset class="checkbox" id="question_18916137008[]" aria-required="true">
    <legend class="label checkbox__description">${QUESTION} <span class="required">*</span></legend>
    ${OPTIONS.map(([v, t]) => `<div class="checkbox__wrapper"><div class="checkbox__input">
      <input description="${QUESTION}" required="" type="checkbox" id="question_18916137008[]_${v}" name="question_18916137008[]" aria-invalid="false" value="${v}"></div>
      <label for="question_18916137008[]_${v}">${t}</label></div>`).join('')}
  </fieldset></div>`;

const box = (v) => document.getElementById(`question_18916137008[]_${v}`);

let HELPERS;
beforeAll(() => {
  HELPERS = `
    ${slice('  function getCheckboxGroups() {', '  /**\n   * Detects all fillable form fields')}
    ${slice('  function fillCheckboxGroupFromRef(ref, ans) {', '  function fillCheckboxFromRef(cb, value) {')}
  `;
});

function load() {
  return new Function(` // eslint-disable-line no-new-func
    function getFieldLabel(el) { const l = el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); return l ? l.textContent.trim() : ''; }
    ${HELPERS}
    return { getCheckboxGroups, fillCheckboxGroupFromRef };
  `)();
}

beforeEach(() => { document.body.innerHTML = GROUP_HTML; });

describe('getCheckboxGroups', () => {
  it('reads the eight boxes as ONE required question with the legend as its text', () => {
    const groups = load().getCheckboxGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('question_18916137008[]');
    expect(groups[0].question).toBe(QUESTION);
    expect(groups[0].required).toBe(true);
    expect(groups[0].boxes).toHaveLength(8);
  });

  it('ignores lone checkboxes (a single consent box is not a group)', () => {
    document.body.innerHTML = '<input type="checkbox" name="consent" id="c"><label for="c">I agree</label>';
    expect(load().getCheckboxGroups()).toEqual([]);
  });
});

describe('detectFormFields pass 4a — one multi-select question for the group', () => {
  it('registers the group once, with all options, and not each box as a yes/no question', () => {
    const passes = slice('    // ── 4a. Checkbox GROUPS', '    // ── 5. Resume- and cover-letter-upload file inputs');
    const run = new Function(` // eslint-disable-line no-new-func
      function getFieldLabel(el) { const l = el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); return l ? l.textContent.trim() : ''; }
      function getRadioLabel() { return ''; }
      const isFieldEligible = () => true;
      const shouldKeepExistingAnswer = (el) => globalThis.JMFieldFilter.shouldKeepExistingAnswer(el);
      ${HELPERS}
      const seen = new Set();
      const questions = [];
      const _fieldMap = {};
      let qIndex = 0;
      ${passes}
      return { questions, _fieldMap };
    `);
    const { questions, _fieldMap } = run();
    expect(questions).toEqual([{
      question_id: 'question_18916137008[]',
      question_text: QUESTION,
      field_type: 'checkbox_group',
      required: true,
      available_options: OPTIONS.map(([, t]) => t),
    }]);
    expect(_fieldMap['question_18916137008[]'].options).toHaveLength(8);
  });
});

describe('fillCheckboxGroupFromRef', () => {
  const ref = () => ({ options: OPTIONS.map(([v, t]) => ({ el: box(v), text: t })) });

  it('picks the boxes named in selected_options', () => {
    const picked = load().fillCheckboxGroupFromRef(ref(), { selected_options: ['LangGraph', 'Custom orchestration (no framework)'] });
    expect(picked.map(b => b.value)).toEqual(['45651498008', '45651503008']);
  });

  it('accepts a single selected_option, and several joined with ";"', () => {
    const { fillCheckboxGroupFromRef } = load();
    expect(fillCheckboxGroupFromRef(ref(), { selected_option: "Haven't built agentic systems yet" }).map(b => b.value)).toEqual(['45651505008']);
    expect(fillCheckboxGroupFromRef(ref(), { selected_option: 'LangGraph; CrewAI / AutoGen' }).map(b => b.value)).toEqual(['45651498008', '45651501008']);
  });

  it('picks nothing for NEEDS_USER_INPUT', () => {
    expect(load().fillCheckboxGroupFromRef(ref(), { selected_option: 'NEEDS_USER_INPUT' })).toEqual([]);
  });
});

describe('auto-submit — a required group counts as answered once ANY box is ticked', () => {
  let check;
  beforeAll(() => {
    const required = slice('  function findUnfilledRequiredFields() {', '  /**\n   * The score the application is judged by');
    check = () => new Function(` // eslint-disable-line no-new-func
      function getFieldLabel(el) { const l = el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); return l ? l.textContent.trim() : ''; }
      const getWorkdayFieldLabel = () => '';
      const isFieldEligible = () => true;
      const hasAnswer = (el) => globalThis.JMFieldFilter.hasAnswer(el);
      const workdayPromptHasSelection = () => false;
      const WORKDAY_SELECT_TRIGGER_SELECTOR = '[data-automation-id^="formField-"] button[aria-haspopup="listbox"]';
      ${HELPERS}
      ${required}
      return findUnfilledRequiredFields();
    `)();
  });

  it('nothing missing when only "LangGraph" is ticked (the live case)', () => {
    box('45651498008').checked = true;
    expect(check()).toEqual([]);
  });

  it('reports the QUESTION once (not each option) when no box is ticked', () => {
    expect(check()).toEqual([QUESTION]);
  });
});

// Follow-up live bug: with the group sent to the AI as one question, its
// answer came back as `selected_options` (an array) — and fillFormFromAnswers
// dropped it as "empty" (no selected_option / generated_text) before reaching
// the group's own fill, so no box was ticked at all.
describe('fillFormFromAnswers — ticks the boxes a selected_options answer picks', () => {
  it('ticks LangGraph and Custom orchestration from a selected_options-only answer', async () => {
    const fill = slice('  // Pause after each click-based answer', '/**\n   * Legacy fill path for old-format AI responses');
    const { fillFormFromAnswers, _fieldMap } = new Function(` // eslint-disable-line no-new-func
      const sleep = () => Promise.resolve();
      const _fieldMap = {};
      const _activeResumeId = 'r1';
      function showAutofillBadge() {}
      const clickNatively = (el) => el.click();
      function fillRadioFromRef() { return true; }
      function fillCheckboxFromRef() {}
      function fillYesNoToggle() { return null; }
      function fillInput() { return true; }
      function fillSelectByText() {}
      async function sendMessage() { return {}; }
      async function fillCustomDropdown() { return true; }
      async function fillFormLegacy() { return { filled: 0, skipped: [] }; }
      async function waitForDomSettled() {}
      function isFieldEligible() { return true; }
      const shouldKeepExistingAnswer = () => false;
      const fieldShowsError = () => false;
      const isWorkdayPromptInput = () => false;
      const workdayPromptHasSelection = () => false;
      function isCustomDropdown() { return false; }
      function getFieldLabel() { return ''; }
      function readCustomOptions() { return []; }
      ${HELPERS}
      ${fill}
      return { fillFormFromAnswers, _fieldMap };
    `)();
    _fieldMap['question_18916137008[]'] = { type: 'checkbox_group', options: OPTIONS.map(([v, t]) => ({ el: box(v), text: t })) };

    const result = await fillFormFromAnswers([
      { question_id: 'question_18916137008[]', selected_options: ['LangGraph', 'Custom orchestration (no framework)'] },
    ]);

    expect(result.filled).toBe(1);
    expect(OPTIONS.filter(([v]) => box(v).checked).map(([, t]) => t)).toEqual(['LangGraph', 'Custom orchestration (no framework)']);
  });
});

describe('fillFormFromAnswers — a required group the bulk answer left empty', () => {
  it('asks the dropdown matcher for one option and ticks it', async () => {
    const fill = slice('  // Pause after each click-based answer', '/**\n   * Legacy fill path for old-format AI responses');
    const findOption = slice('  function findOptionByText(options, choice) {', '  /**\n   * Strict version of findOptionByText');
    const requests = [];
    const { fillFormFromAnswers, _fieldMap } = new Function('requests', ` // eslint-disable-line no-new-func
      const sleep = () => Promise.resolve();
      const _fieldMap = {};
      const _activeResumeId = 'r1';
      function showAutofillBadge() {}
      const clickNatively = (el) => el.click();
      function fillRadioFromRef() { return true; }
      function fillCheckboxFromRef() {}
      function fillYesNoToggle() { return null; }
      function fillInput() { return true; }
      function fillSelectByText() {}
      async function sendMessage(msg) {
        requests.push(msg);
        return msg.type === 'MATCH_DROPDOWN' ? "Haven't built agentic systems yet" : {};
      }
      async function fillCustomDropdown() { return true; }
      async function fillFormLegacy() { return { filled: 0, skipped: [] }; }
      async function waitForDomSettled() {}
      function isFieldEligible() { return true; }
      const shouldKeepExistingAnswer = () => false;
      const fieldShowsError = () => false;
      const isWorkdayPromptInput = () => false;
      const workdayPromptHasSelection = () => false;
      function isCustomDropdown() { return false; }
      function getFieldLabel() { return ''; }
      function readCustomOptions() { return []; }
      ${findOption}
      ${HELPERS}
      ${fill}
      return { fillFormFromAnswers, _fieldMap };
    `)(requests);
    _fieldMap['question_18916137008[]'] = {
      type: 'checkbox_group', required: true, questionText: QUESTION,
      options: OPTIONS.map(([v, t]) => ({ el: box(v), text: t })),
    };

    const result = await fillFormFromAnswers([]); // the AI left the group out

    const match = requests.find(r => r.type === 'MATCH_DROPDOWN');
    expect(match.questionText).toBe(QUESTION);
    expect(match.options).toEqual(OPTIONS.map(([, t]) => t));
    expect(OPTIONS.filter(([v]) => box(v).checked).map(([, t]) => t)).toEqual(["Haven't built agentic systems yet"]);
    expect(result.filled).toBe(1);
  });
});
