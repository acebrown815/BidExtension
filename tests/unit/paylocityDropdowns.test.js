// Live on Paylocity (recruiting.paylocity.com/Recruiting/Jobs/Apply/4572609):
// "Have you applied for a job with us before?" and the SMS-permission
// question were never filled. Both are react-widgets DropdownLists — a bare
// <div role="combobox" class="rw-dropdownlist"> showing "--", the question in
// its data-for attribute (the <label> isn't linked to it) — and bare div
// comboboxes were only ever collected on Rippling pages.
//
// Markup trimmed verbatim from the live page.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import '../../lib/fieldFilter.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function sliceBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  if (start === -1 || end === -1) throw new Error('source anchors moved — update this test\'s extraction markers');
  return src.slice(start, end);
}

let runDetection;
beforeAll(() => {
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8').replace(/\r\n/g, '\n');
  const ripplingHelpers = sliceBetween(content, '/** @returns {boolean} true on a Rippling-hosted job board', '/**\n   * Like getFieldLabel, but for an entire radio GROUP');
  const pass2b = sliceBetween(content, '// ── 2b. Rippling', '// ── 3. Radio button groups ──');
  runDetection = new Function('location', ` // eslint-disable-line no-new-func
    ${ripplingHelpers}
    const getFieldLabel = () => '';
    const isFieldEligible = () => true;
    const shouldKeepExistingAnswer = (el) => globalThis.JMFieldFilter.shouldKeepExistingAnswer(el);
    const WORKDAY_SELECT_TRIGGER_SELECTOR = '[data-automation-id^="formField-"] button[aria-haspopup="listbox"]';
    const isWorkdaySelectTrigger = () => false;
    const getWorkdayFieldLabel = () => '';
    const seen = new Set();
    const questions = [];
    const _fieldMap = {};
    let qIndex = 0;
    ${pass2b}
    return { questions, _fieldMap };
  `);
});

const dropdown = (id, question, shown = '--') => `
  <div class="form-group form-required form-error"><label>${question}<span><em> (required)</em></span></label>
    <div class="form-error" style="max-width: 100px;">
      <div data-for="${question}" id="${id}" role="combobox" aria-owns="${id}__listbox" aria-expanded="false" aria-haspopup="true" tabindex="0" class="form-error rw-dropdownlist rw-widget">
        <span class="rw-dropdownlist-picker rw-select rw-btn"><span aria-hidden="true" class="rw-i rw-i-caret-down"></span></span><div class="rw-input">${shown}</div>
      </div>
    </div>
    <div class="type-footnote show">Please select Yes or No</div>
  </div>`;

const PAYLOCITY_LOCATION = { hostname: 'recruiting.paylocity.com', href: 'https://recruiting.paylocity.com/Recruiting/Jobs/Apply/4572609' };

describe('Paylocity react-widgets dropdowns', () => {
  it('collects both required Yes/No questions, with their question text', () => {
    document.body.innerHTML = '<div class="col-xs-12">'
      + '<div class="form-group form-required"><label>First Name<span><em> (required)</em></span></label><input id="info.firstName" type="text" value="Devin"></div>'
      + dropdown('info.haveYouAppliedWithUsBefore', 'Have you applied for a job with us before?')
      + dropdown('info.smsOptedIn', 'We may use SMS during the hiring process. Do you give us permission to text you?')
      + '</div>';
    const { questions, _fieldMap } = runDetection(PAYLOCITY_LOCATION);
    expect(questions.map(q => [q.question_id, q.question_text, q.field_type, q.required])).toEqual([
      ['info.haveYouAppliedWithUsBefore', 'Have you applied for a job with us before?', 'dropdown', true],
      ['info.smsOptedIn', 'We may use SMS during the hiring process. Do you give us permission to text you?', 'dropdown', true],
    ]);
    expect(_fieldMap['info.smsOptedIn'].type).toBe('custom_dropdown');
  });

  it('leaves an already-answered dropdown alone', () => {
    document.body.innerHTML = dropdown('info.haveYouAppliedWithUsBefore', 'Have you applied for a job with us before?', 'No').replace(/ form-error/g, '');
    expect(runDetection(PAYLOCITY_LOCATION).questions).toEqual([]);
  });

  it('still ignores other bare div comboboxes off Rippling (site search, nav)', () => {
    document.body.innerHTML = '<header><div role="combobox" id="site-search" tabindex="0">Search jobs</div></header>';
    expect(runDetection(PAYLOCITY_LOCATION).questions).toEqual([]);
  });
});
