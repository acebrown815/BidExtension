// Regression test for a shadcn/ui (Radix) application form found live on
// xyzai.io/careers/... — Auto-Bid's AutoFill left most of it empty:
//
//   - Every label is `<label><span>Name</span><span>Required</span></label>`,
//     whose textContent is "NameRequired" — which never matches a saved Q&A
//     question ("Name"), so the no-AI Q&A pass (directFill.js) skipped it.
//   - Every select is a Radix `<button role="combobox">` whose hidden native
//     <select> has no options until the popup is first opened, so neither
//     the <select> pass nor the <input> pass ever registered it.
//
// Markup trimmed verbatim from the live page.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import '../../lib/fieldFilter.js'; // real shouldKeepExistingAnswer / fieldShowsError for the sliced harness

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function sliceBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  if (start === -1 || end === -1) {
    throw new Error('source anchors moved — update this test\'s extraction markers');
  }
  return src.slice(start, end);
}

let contentLabel;
let directFillLabel;
let runDetection;

beforeAll(() => {
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8').replace(/\r\n/g, '\n');
  const direct = fs.readFileSync(path.join(ROOT, 'directFill.js'), 'utf8').replace(/\r\n/g, '\n');

  const contentHelper = sliceBetween(content, '  function labelTextWithoutBadges(label) {', '\n  /** @returns {boolean} true on a Rippling');
  const ripplingHelpers = sliceBetween(content, '/** @returns {boolean} true on a Rippling-hosted job board', '/**\n   * Like getFieldLabel, but for an entire radio GROUP');
  const pass2b = sliceBetween(content, '// ── 2b. Rippling', '// ── 3. Radio button groups ──');
  const directHelper = sliceBetween(direct, '  function labelTextWithoutBadges(label) {', '\n  /**');

  contentLabel = new Function(`${contentHelper} return labelTextWithoutBadges;`)(); // eslint-disable-line no-new-func
  directFillLabel = new Function(`${directHelper} return labelTextWithoutBadges;`)(); // eslint-disable-line no-new-func
  runDetection = new Function( // eslint-disable-line no-new-func
    'location',
    `
    ${contentHelper}
    ${ripplingHelpers}
    function getFieldLabel(el) {
      const label = el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      return label ? labelTextWithoutBadges(label) : '';
    }
    const isFieldEligible = () => true; const shouldKeepExistingAnswer = (el) => globalThis.JMFieldFilter.shouldKeepExistingAnswer(el); const fieldShowsError = (el) => globalThis.JMFieldFilter.fieldShowsError(el); const WORKDAY_SELECT_TRIGGER_SELECTOR = '[data-automation-id^="formField-"] button[aria-haspopup="listbox"]'; const isWorkdaySelectTrigger = () => false; const getWorkdayFieldLabel = () => '';
    const seen = new Set();
    const questions = [];
    const _fieldMap = {};
    let qIndex = 0;
    ${pass2b}
    return { questions, _fieldMap };
    `,
  );
});

const FORM_HTML = `
  <form class="space-y-6" noValidate="">
    <div data-slot="form-item">
      <label data-slot="form-label" for="_R_12jav5ubtb_-form-item"><span>Name</span><span class="text-xs">Required</span></label>
      <input data-slot="form-control" placeholder="Jane Smith" id="_R_12jav5ubtb_-form-item" name="name" value="">
    </div>
    <div data-slot="form-item">
      <label data-slot="form-label" for="_R_23jav5ubtb_-form-item"><span>Software Development Experience</span><span>Required</span></label>
      <button type="button" role="combobox" aria-controls="radix-_R_m3jav5ubtb_" aria-expanded="false" aria-required="true" aria-autocomplete="none" data-state="closed" data-placeholder="" id="_R_23jav5ubtb_-form-item"><span data-slot="select-value">Select experience</span></button>
      <select aria-hidden="true" tabindex="-1"><option value=""></option></select>
    </div>
    <div data-slot="form-item">
      <label data-slot="form-label" for="_R_8jav5ubtb_-form-item"><span>LinkedIn URL</span><span>Optional</span></label>
      <input id="_R_8jav5ubtb_-form-item" name="linkedinUrl" value="">
    </div>
  </form>
  <header><button type="button" role="combobox" id="site-search">Search</button></header>
`;

beforeEach(() => {
  document.body.innerHTML = FORM_HTML;
});

describe('labelTextWithoutBadges (content.js and directFill.js)', () => {
  it('drops a separate "Required"/"Optional" badge element', () => {
    for (const fn of [contentLabel, directFillLabel]) {
      expect(fn(document.querySelector('label[for="_R_12jav5ubtb_-form-item"]')).trim()).toBe('Name');
      expect(fn(document.querySelector('label[for="_R_8jav5ubtb_-form-item"]')).trim()).toBe('LinkedIn URL');
    }
  });

  it('leaves a label with no badge — or with "required" inside real text — unchanged', () => {
    document.body.innerHTML = `
      <label id="a">Email</label>
      <label id="b"><span>Is a cover letter required for this role?</span></label>`;
    for (const fn of [contentLabel, directFillLabel]) {
      expect(fn(document.getElementById('a'))).toBe('Email');
      expect(fn(document.getElementById('b'))).toBe('Is a cover letter required for this role?');
    }
  });

  it('does not modify the live label', () => {
    const label = document.querySelector('label[for="_R_12jav5ubtb_-form-item"]');
    contentLabel(label);
    expect(label.textContent).toBe('NameRequired');
  });
});

describe('detectFormFields pass 2b — Radix <button role="combobox"> on any site', () => {
  it('registers the form\'s select trigger as a custom dropdown with its clean label', () => {
    const { questions, _fieldMap } = runDetection({ hostname: 'www.xyzai.io' });
    expect(questions).toEqual([{
      question_id: '_R_23jav5ubtb_-form-item',
      question_text: 'Software Development Experience',
      field_type: 'dropdown',
      required: true,
      available_options: [],
    }]);
    expect(_fieldMap['_R_23jav5ubtb_-form-item'].type).toBe('custom_dropdown');
  });

  it('ignores a combobox button outside any <form> (site search, nav)', () => {
    const { questions } = runDetection({ hostname: 'www.xyzai.io' });
    expect(questions.some(q => q.question_id === 'site-search')).toBe(false);
  });
});

describe('detectFormFields pass 2b — no duplicate when the native <select> was already registered', () => {
  it('skips a trigger whose hidden <select> pass 1 already claimed', () => {
    document.body.innerHTML = `
      <form><div>
        <label for="trig"><span>Hours</span></label>
        <button type="button" role="combobox" id="trig">Select hours</button>
        <select name="hours" aria-hidden="true"><option value="Full-time">Full-time</option></select>
      </div></form>`;
    // Run the extracted pass with "hours" pre-seeded, as pass 1 would.
    const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8').replace(/\r\n/g, '\n');
    const start = src.indexOf('// ── 2b. Rippling');
    const pass2b = src.slice(start, src.indexOf('// ── 3. Radio button groups ──', start));
    const run = new Function('location', `
      function isRipplingPage() { return false; }
      function getFieldLabel() { return 'Hours'; }
      const isFieldEligible = () => true; const shouldKeepExistingAnswer = (el) => globalThis.JMFieldFilter.shouldKeepExistingAnswer(el); const fieldShowsError = (el) => globalThis.JMFieldFilter.fieldShowsError(el); const WORKDAY_SELECT_TRIGGER_SELECTOR = '[data-automation-id^="formField-"] button[aria-haspopup="listbox"]'; const isWorkdaySelectTrigger = () => false; const getWorkdayFieldLabel = () => '';
      const seen = new Set(['hours']);
      const questions = [];
      const _fieldMap = {};
      let qIndex = 0;
      ${pass2b}
      return questions;`); // eslint-disable-line no-new-func
    expect(run({ hostname: 'example.com' })).toEqual([]);
  });
});
