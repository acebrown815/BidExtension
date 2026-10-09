// Live on Paylocity (recruiting.paylocity.com/Recruiting/Jobs/Apply/4572609):
//   - "Available to Start" should be one week from today;
//   - "Maximum Desired Salary" got the same 140000 as the minimum — it
//     should be 1.2 × the saved desired salary;
//   - "Address Line 1" (a street-address search box) was treated as a
//     dropdown and left empty — it should be the saved Street Address.
// And AI answers must only go into fields that are still empty when they
// arrive, never over a value the no-AI passes or the user put there.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
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

const QA = [
  { question: 'Desired annual salary (USD)', answer: '140k' },
  { question: 'Desired hourly rate (if applicable)', answer: '70' },
  { question: 'Street Address', answer: '533 N Main St' },
  { question: 'Street Address Line 2 (Apt, Suite, Unit)', answer: 'Apt 4' },
  { question: 'City', answer: 'Winslow' },
];

let derived;
beforeAll(() => {
  const code = slice('  const AVAILABLE_TO_START_RE', '  async function fillFormFromAnswers(');
  derived = (env) => new Function('env', ` // eslint-disable-line no-new-func
    const FIELD_FILL_PACE_MS = 0;
    const sleep = () => Promise.resolve();
    const console = { info: () => {}, warn: () => {} };
    async function sendMessage(msg) { return msg.type === 'GET_QA_LIST' ? env.qa : null; }
    function getFieldLabel(el) { const l = el.id && document.querySelector('label[for="' + el.id + '"]'); return l ? l.querySelector('span') ? l.querySelector('span').textContent.trim() : l.textContent.trim() : ''; }
    const isFieldEligible = () => true;
    const shouldKeepExistingAnswer = (el) => globalThis.JMFieldFilter.shouldKeepExistingAnswer(el);
    const fieldShowsError = (el) => globalThis.JMFieldFilter.fieldShowsError(el);
    function fillInput(el, value) { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); return true; }
    function typeIntoAutocomplete(el, text) { el.value = text; env.typed.push(text); setTimeout(() => env.onTyped && env.onTyped(text), 0); }
    async function waitForNewSuggestionOptions(before) {
      await new Promise(r => setTimeout(r, 5));
      return Array.from(document.querySelectorAll('[role="option"]')).filter(o => !before.has(o)).map(el => ({ el, text: el.textContent.trim() }));
    }
    function clickElement(el) { env.clicked.push(el.textContent.trim()); }
    function dispatchFocusEvents() {}
    function showAutofillBadge() {}
    ${code}
    return { fillDerivedAnswers, formatDateForField, fillDateField };
  `)(env);
});

let env;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9)); // 9 Oct 2026
  env = { qa: QA, typed: [], clicked: [] };
});
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

const PAYLOCITY = `
  <div class="form-group form-required"><label for="info.availableStartDate">Available to Start<span><em> (required)</em></span></label>
    <input data-for="Available to Start" id="info.availableStartDate" placeholder="" type="text" value=""></div>
  <div class="form-group"><label for="info.minimumDesiredSalary">Minimum Desired Salary</label><input data-for="minimumDesiredSalary" id="info.minimumDesiredSalary" type="text" value=""></div>
  <div class="form-group form-required form-error"><input data-automation-id="infoMaximumDesiredSalary" data-for="maximumDesiredSalary" id="info.maximumDesiredSalary" placeholder="" type="text" value=""></div>
  <label for="public-site-address-address-1"><span>Address Line 1</span><div>
    <input data-automation-id="public-site-address-address-1" aria-autocomplete="list" aria-controls="public-site-address-address-1-autocomplete-list" role="combobox" id="public-site-address-address-1" maxlength="50" required="" type="text" value=""></div></label>
  <label for="public-site-address-address-2"><span>Address Line 2</span><input id="public-site-address-address-2" type="text" value=""></label>
  <div><label for="wh.startDate">Start Date</label><input id="wh.startDate" type="text" value=""></div>`;

describe('derived answers', () => {
  it('fills start date (+1 week), maximum salary (1.2 × desired) and the street address', async () => {
    document.body.innerHTML = PAYLOCITY;
    const api = derived(env);
    expect(await api.fillDerivedAnswers()).toBe(3);
    expect(document.getElementById('info.availableStartDate').value).toBe('10/16/2026');
    expect(document.getElementById('info.maximumDesiredSalary').value).toBe('168000');
    expect(document.getElementById('public-site-address-address-1').value).toBe('533 N Main St');
    // not touched: the minimum (left to Q&A/AI), Line 2, a work-history start date
    expect(document.getElementById('info.minimumDesiredSalary').value).toBe('');
    expect(document.getElementById('public-site-address-address-2').value).toBe('');
    expect(document.getElementById('wh.startDate').value).toBe('');
  });

  it('picks the address suggestion only when it is that street in that city', async () => {
    document.body.innerHTML = PAYLOCITY;
    env.onTyped = () => document.body.insertAdjacentHTML('beforeend',
      '<ul><li role="option">533 N Main St, Springfield, IL</li><li role="option">533 N Main St, Winslow, IN 47598</li></ul>');
    await derived(env).fillDerivedAnswers();
    expect(env.clicked).toEqual(['533 N Main St, Winslow, IN 47598']);
  });

  it('never overwrites a value that is already there', async () => {
    document.body.innerHTML = PAYLOCITY;
    document.getElementById('info.maximumDesiredSalary').value = '150000';
    document.getElementById('info.availableStartDate').value = '11/01/2026';
    await derived(env).fillDerivedAnswers();
    expect(document.getElementById('info.maximumDesiredSalary').value).toBe('150000');
    expect(document.getElementById('info.availableStartDate').value).toBe('11/01/2026');
  });

  it('writes the date the way the field expects', () => {
    const api = derived(env);
    const d = new Date(2026, 9, 16);
    const field = (attrs) => { document.body.innerHTML = `<input ${attrs}>`; return document.querySelector('input'); };
    expect(api.formatDateForField(field('type="date"'), d)).toBe('2026-10-16');
    expect(api.formatDateForField(field('placeholder="YYYY-MM-DD"'), d)).toBe('2026-10-16');
    expect(api.formatDateForField(field('placeholder="DD/MM/YYYY"'), d)).toBe('16/10/2026');
    expect(api.formatDateForField(field('placeholder="MM/DD/YYYY"'), d)).toBe('10/16/2026');
  });

  it('leaves maximum salary alone without a saved desired salary', async () => {
    document.body.innerHTML = PAYLOCITY;
    env.qa = [];
    await derived(env).fillDerivedAnswers();
    expect(document.getElementById('info.maximumDesiredSalary').value).toBe('');
    expect(document.getElementById('public-site-address-address-1').value).toBe('');
  });
});

describe('fillFormFromAnswers — AI answers only into fields still empty', () => {
  const FN_SRC = slice('async function fillFormFromAnswers(answers) {', '/**\n   * Legacy fill path for old-format AI responses');
  const build = (fieldMap) => {
    const writes = [];
    const fill = new Function('fieldMap', 'writes', ` // eslint-disable-line no-new-func
      const _fieldMap = fieldMap;
      const _activeResumeId = 'r1';
      const FIELD_FILL_PACE_MS = 0, CHOICE_CLICK_PACE_MS = 0;
      const sleep = () => Promise.resolve();
      function showAutofillBadge() {}
      function fillRadioFromRef() { return true; }
      function fillCheckboxFromRef() {}
      function fillInput(el, value) { writes.push([el.id, value]); el.value = value; return true; }
      function fillSelectByText() {}
      async function sendMessage() { return {}; }
      async function fillCustomDropdown() { return false; }
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
    `)(fieldMap, writes);
    return { fill, writes };
  };

  it('skips a field filled after detection, fills the ones still empty, and re-fills a flagged one', async () => {
    document.body.innerHTML = `
      <input id="max" type="text" value="">
      <input id="ref" type="text" value="">
      <input id="zip" type="text" value="00000" aria-invalid="true">`;
    const el = (id) => document.getElementById(id);
    const { fill, writes } = build({ max: { el: el('max'), type: 'text' }, ref: { el: el('ref'), type: 'text' }, zip: { el: el('zip'), type: 'text' } });
    el('max').value = '168000'; // filled by a derived answer / the user meanwhile
    const result = await fill([
      { question_id: 'max', generated_text: '140000' },
      { question_id: 'ref', generated_text: 'N/A' },
      { question_id: 'zip', generated_text: '47598' },
    ]);
    expect(writes).toEqual([['ref', 'N/A'], ['zip', '47598']]);
    expect(el('max').value).toBe('168000');
    expect(result.skipped).toContain('max');
  });
});

// Paylocity's "Available to Start": a masked MM/DD/YYYY box with its own
// calendar button, which kept a date written in one go out of the form.
describe('fillDateField — a date box that only takes typed characters', () => {
  const PAYLOCITY_DATE = `<div class="form-group form-required form-error"><label>Available to Start<span><em> (required)</em></span></label>
    <div format="MM/dd/yyyy"><div aria-describedby="info.dateAvailableToStart-error-message" aria-invalid="true"><div>
      <input id="info.dateAvailableToStart" max="" min="1920-01-01" placeholder="MM/DD/YYYY" type="text" value=""></div>
      <div><button type="button"><i aria-label="Delete"></i></button><button type="button" id="info.dateAvailableToStart-button" aria-haspopup="dialog" aria-expanded="false"><i aria-label="Calendar"></i></button></div></div></div>
    <div class="type-footnote show">Available to Start (date) is required</div></div>`;

  it('types the date when a one-go write is thrown away', async () => {
    document.body.innerHTML = PAYLOCITY_DATE;
    const input = document.getElementById('info.dateAvailableToStart');
    // Keep only what arrives as typed characters, like a masked date input.
    input.addEventListener('input', (e) => { if (e.inputType !== 'insertText' && e.inputType !== 'deleteContentBackward') input.value = ''; });
    vi.useRealTimers();
    expect(await derived(env).fillDateField(input, '10/16/2026')).toBe(true);
    expect(input.value).toBe('10/16/2026');
  });

  it('does not double a separator a mask inserts itself', async () => {
    document.body.innerHTML = PAYLOCITY_DATE;
    const input = document.getElementById('info.dateAvailableToStart');
    // A mask: after typed digits, re-shape the value as MM/DD/YYYY (adds "/" itself).
    input.addEventListener('input', (e) => {
      if (e.inputType !== 'insertText') return;
      const d = input.value.replace(/\D/g, '').slice(0, 8);
      input.value = d.length > 4 ? d.slice(0, 2) + '/' + d.slice(2, 4) + '/' + d.slice(4)
        : d.length >= 2 ? d.slice(0, 2) + '/' + d.slice(2) : d;
    });
    vi.useRealTimers();
    expect(await derived(env).fillDateField(input, '10/16/2026')).toBe(true);
    expect(input.value).toBe('10/16/2026');
  });

  it('is filled by the start-date rule on the live markup', async () => {
    document.body.innerHTML = PAYLOCITY_DATE;
    await derived(env).fillDerivedAnswers();
    expect(document.getElementById('info.dateAvailableToStart').value).toBe('10/16/2026');
  });
});
