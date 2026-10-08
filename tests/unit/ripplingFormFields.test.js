// Regression test for a live bug on Rippling (ats.rippling.com) application
// forms: seven questions were silently never autofilled.
//
//   - Employer custom Yes/No questions and the Gender / Hispanic-Latino /
//     Veteran EEO selects are a bare <div role="combobox" tabindex="0"> — no
//     <input> or <select> behind them — so detectFormFields() never saw them.
//   - Custom questions keep their text in a <p> inside a sibling
//     `.marginBottom--4` wrapper, with no label/aria-labelledby/placeholder on
//     the control itself, so getFieldLabel() fell through to aria-label
//     "Select" or a humanized random `name` ("yp Z1Cumqi DZ") — the AI got a
//     meaningless question (the compensation text field).
//
// The fix is Rippling-only (gated on the hostname). Markup below is trimmed
// verbatim from the live form.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import '../../lib/fieldFilter.js'; // real shouldKeepExistingAnswer / fieldShowsError for the sliced harness

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');

let makeHelpers;
let makeDetection;

function sliceBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  if (start === -1 || end === -1) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  }
  return src.slice(start, end);
}

beforeAll(() => {
  const src = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');
  const helpers = sliceBetween(
    src,
    '/** @returns {boolean} true on a Rippling-hosted job board',
    '/**\n   * Like getFieldLabel, but for an entire radio GROUP',
  );
  const pass2b = sliceBetween(src, '// ── 2b. Rippling', '// ── 3. Radio button groups ──');

  // `location` is shadowed so each test can pick the hostname.
  makeHelpers = new Function('location', `${helpers} return { isRipplingPage, getRipplingFieldLabel };`); // eslint-disable-line no-new-func
  makeDetection = new Function( // eslint-disable-line no-new-func
    'location',
    `
    ${helpers}
    const getFieldLabel = getRipplingFieldLabel;
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

const RIPPLING = { hostname: 'ats.rippling.com' };

const FORM_HTML = `
  <form>
    <div class="marginY--36"><div class="paddingX--16"><div class="marginBottom--4"><p class="css-i4dt0z edalr1o0">What compensation are you targeting (salary + variable/incentive/bonus/etc.)?<div class="css-18yxg8r"></div></p></div></div>
      <div class="css-fuqajr eun831x1" data-testid="field"><div class="css-1fttcpj eun831x6"><div class="css-1mlcsw efnm4lm1">
        <input id="field-60" aria-required="true" autocomplete="off" value="" name="ypZ1CumqiDZ">
      </div></div></div>
    </div>
    <div class="marginY--36"><div class="paddingX--16"><div class="marginBottom--4"><p class="css-i4dt0z edalr1o0">Will you now or in the future require employer sponsorship (e.g. H-1B, Visa, etc.) to legally work for BizzyCar in the US?<div class="css-18yxg8r"></div></p></div></div>
      <div class="css-2a15f5 eun831x1" data-testid="field"><div class="css-1fttcpj eun831x6"><div data-testid="select-controller">
        <div id="field-64" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-label="Select" aria-required="true" tabindex="0"><p>Select</p></div>
      </div></div></div>
    </div>
    <div class="marginBottom--24 css-fuqajr eun831x1" data-testid="field">
      <div class="css-1w8xq0 eun831x4"><span id="field-88-label">Gender</span></div>
      <div class="css-1fttcpj eun831x6"><div data-testid="select-controller">
        <div id="field-88" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="field-88-label" aria-label="Select..." aria-required="false" tabindex="0"><p>Select...</p></div>
      </div></div>
    </div>
    <div class="css-fuqajr eun831x1" data-testid="field">
      <div class="css-1w8xq0 eun831x4"><span id="field-9-label">Résumé</span></div>
      <label aria-labelledby="file-input-11 field-9-label"><input id="resume" aria-labelledby="file-input-11 field-9-label" type="file"></label>
      <div id="file-input-11">Total 1 file selected</div>
    </div>
  </form>
`;

beforeEach(() => {
  document.body.innerHTML = FORM_HTML;
});

describe('content.js getRipplingFieldLabel', () => {
  it('resolves an employer custom question from its sibling <p>', () => {
    const { getRipplingFieldLabel } = makeHelpers(RIPPLING);
    expect(getRipplingFieldLabel(document.getElementById('field-60')))
      .toBe('What compensation are you targeting (salary + variable/incentive/bonus/etc.)?');
    expect(getRipplingFieldLabel(document.getElementById('field-64')))
      .toMatch(/^Will you now or in the future require employer sponsorship/);
  });

  it('prefers the "*-label" aria-labelledby target over a generic aria-label', () => {
    const { getRipplingFieldLabel } = makeHelpers(RIPPLING);
    expect(getRipplingFieldLabel(document.getElementById('field-88'))).toBe('Gender');
    expect(getRipplingFieldLabel(document.getElementById('resume'))).toBe('Résumé');
  });

  it('isRipplingPage is false everywhere else', () => {
    expect(makeHelpers({ hostname: 'ats.rippling.com' }).isRipplingPage()).toBe(true);
    expect(makeHelpers({ hostname: 'jobs.lever.co' }).isRipplingPage()).toBe(false);
    expect(makeHelpers({ hostname: 'notrippling.com' }).isRipplingPage()).toBe(false);
  });
});

describe('content.js detectFormFields pass 2b — Rippling div comboboxes', () => {
  it('registers each <div role="combobox"> as a custom dropdown with its real question', () => {
    const { questions, _fieldMap } = makeDetection(RIPPLING);
    const byId = Object.fromEntries(questions.map(q => [q.question_id, q]));
    expect(Object.keys(byId).sort()).toEqual(['field-64', 'field-88']);
    expect(byId['field-64'].question_text).toMatch(/employer sponsorship/);
    expect(byId['field-64'].required).toBe(true);
    expect(byId['field-88'].question_text).toBe('Gender');
    expect(_fieldMap['field-64'].type).toBe('custom_dropdown');
    expect(_fieldMap['field-64'].el).toBe(document.getElementById('field-64'));
  });

  it('does nothing off Rippling', () => {
    const { questions } = makeDetection({ hostname: 'jobs.lever.co' });
    expect(questions).toEqual([]);
  });
});
