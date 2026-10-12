// Live on Lever (jobs.lever.co/cyderes/.../apply):
//   - "What is your location?" — a <select class="candidate-location"> of
//     countries with no id or name — was never filled: selects without an
//     id/name were skipped, and a "City, ST" answer matches no country.
//   - The disability form's "Date" (name="eeo[disabilitySignatureDate]",
//     placeholder MM/DD/YYYY) stayed empty and flagged.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../../lib/fieldFilter.js';
import '../../lib/phoneFormat.js';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js'), 'utf8').replace(/\r\n/g, '\n');
const slice = (a, b) => {
  const start = SRC.indexOf(a);
  const end = SRC.indexOf(b, start);
  if (start === -1 || end === -1) throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  return SRC.slice(start, end);
};

const COUNTRY_SELECT = `<div class="application-question"><label><div class="application-label">What is your location?</div>
  <div class="application-field"><div class="application-dropdown"><select class="candidate-location" data-qa="candidate-location-select">
    <option value="">Select...</option><option value="CA">Canada</option><option value="IN">India</option>
    <option value="NC">New Caledonia</option><option value="GB">United Kingdom</option><option value="US">United States</option>
    <option value="UM">United States Minor Outlying Islands</option></select></div></div></label></div>`;
const STATES = ['Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Indiana', 'North Carolina'];
const STATE_SELECT = (byCode) => `<label>State<select name="state"><option value="">Select...</option>${
  STATES.map(n => `<option value="${byCode ? n.slice(0, 2).toUpperCase() : n}">${n}</option>`).join('')}</select></label>`;

let env;
let api;
beforeAll(() => {
  const locationHelpers = slice('  function titleCase(text) {', '  /**\n   * Types into a search-as-you-type field (place autocomplete)');
  const pick = slice('  const LOCATION_QUESTION_RE', '  async function fillFormFromAnswers(');
  api = (e) => new Function('env', ` // eslint-disable-line no-new-func
    const _activeResumeId = 'r1';
    async function sendMessage(msg) {
      if (msg.type === 'GET_QA_LIST') return env.qa;
      if (msg.type === 'GET_PROFILE') return env.profile;
      return null;
    }
    ${locationHelpers}
    ${pick}
    return { pickLocationOption, LOCATION_QUESTION_RE };
  `)(e);
});

beforeEach(() => { env = { qa: [], profile: { location: 'Summerfield, NC' } }; });
afterEach(() => { document.body.innerHTML = ''; });

describe('location <select>: the list decides country / state / city', () => {
  it('Lever "What is your location?" with a country list → United States (never New Caledonia for NC)', async () => {
    document.body.innerHTML = COUNTRY_SELECT;
    const a = api(env);
    expect(a.LOCATION_QUESTION_RE.test('What is your location?')).toBe(true);
    expect(await a.pickLocationOption(document.querySelector('select'))).toEqual({ text: 'United States', value: 'US' });
  });

  it('a state list → the state, by name or by its code', async () => {
    document.body.innerHTML = STATE_SELECT(false);
    expect((await api(env).pickLocationOption(document.querySelector('select'))).text).toBe('North Carolina');
    env.profile = { location: 'Winslow, Indiana' };
    expect((await api(env).pickLocationOption(document.querySelector('select'))).text).toBe('Indiana');
  });

  it('a saved Q&A location wins over the profile', async () => {
    document.body.innerHTML = COUNTRY_SELECT;
    env.qa = [{ question: 'Current location (City, State)', answer: 'Bangalore, India' }];
    env.profile = { location: '' };
    const hit = await api(env).pickLocationOption(document.querySelector('select'));
    expect(hit && hit.text).toBe('India');
  });

  it('nothing when the list offers none of the location\'s parts', async () => {
    document.body.innerHTML = '<label>Location<select><option value="">Select...</option><option value="r">Remote</option><option value="o">Office</option></select></label>';
    expect(await api(env).pickLocationOption(document.querySelector('select'))).toBeNull();
  });
});

describe('detection: a <select> with no id or name is still a question', () => {
  it('registers Lever\'s location select', () => {
    document.body.innerHTML = COUNTRY_SELECT;
    const pass = slice('    // ── 1. ALL <select> elements (visible AND hidden) ──', '    // ── 2. Text inputs, textareas');
    const { questions } = new Function(` // eslint-disable-line no-new-func
      const seen = new Set(); const questions = []; const _fieldMap = {}; let qIndex = 0;
      const isFieldEligible = () => true;
      const shouldKeepExistingAnswer = (el) => globalThis.JMFieldFilter.shouldKeepExistingAnswer(el);
      function getFieldLabel(el) { const l = el.closest('label'); return l ? l.querySelector('.application-label').textContent.trim() : ''; }
      function buildSelectOptions(sel) {
        const optMap = {}; const optTexts = [];
        for (const o of sel.options) { if (!o.value) continue; optMap[o.textContent.toLowerCase()] = o.value; optTexts.push(o.textContent); }
        return { optMap, optTexts };
      }
      ${pass}
      return { questions };
    `)();
    expect(questions.map(q => [q.question_id, q.question_text, q.field_type])).toEqual([['q_0', 'What is your location?', 'dropdown']]);
  });
});

describe('Lever disability "Date": today', () => {
  it('is matched as a signature date and filled with today', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 11));
    try {
      document.body.innerHTML = `<div id="disabilitySignatureSection">
        <div class="application-question"><label><div class="application-label">Name</div><div class="application-field"><input type="text" name="eeo[disabilitySignature]" placeholder="Enter your full name" required=""></div></label></div>
        <div class="application-question"><label><div class="application-label">Date</div><div class="application-field"><input type="text" name="eeo[disabilitySignatureDate]" placeholder="MM/DD/YYYY" required=""></div></label></div></div>`;
      const code = slice('  const AVAILABLE_TO_START_RE', '  const LOCATION_QUESTION_RE');
      const fill = new Function(` // eslint-disable-line no-new-func
        const FIELD_FILL_PACE_MS = 0; const sleep = () => Promise.resolve();
        const console = { info: () => {}, warn: () => {} };
        async function sendMessage() { return []; }
        function getFieldLabel(el) { const l = el.closest('label'); return l ? l.querySelector('.application-label').textContent.trim() : ''; }
        const isFieldEligible = () => true;
        const shouldKeepExistingAnswer = (el) => globalThis.JMFieldFilter.shouldKeepExistingAnswer(el);
        const fieldShowsError = () => false;
        function fillInput(el, v) { el.value = v; return true; }
        function dispatchFocusEvents() {}
        function showAutofillBadge() {}
        async function fillWorkdayDateField() {}
        ${code}
        return fillDerivedAnswers;
      `)();
      await fill();
      expect(document.querySelector('[name="eeo[disabilitySignatureDate]"]').value).toBe('10/11/2026');
      expect(document.querySelector('[name="eeo[disabilitySignature]"]').value).toBe('');
    } finally { vi.useRealTimers(); }
  });
});
