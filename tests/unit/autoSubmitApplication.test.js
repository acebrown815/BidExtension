// Auto-Bid's last step: after filling every step of a multi-step form, it used
// to stop at the final "Submit" (findNextStepButton never matches a final
// action). It now submits — only for a match score above 75, only when the
// form is complete, and only after marking the job as Applied (which appends
// the user's Google Sheet row, keyed by the sheet's original job link).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../../lib/fieldFilter.js'; // real hasAnswer for the sliced harness

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');

let SECTION;

beforeAll(() => {
  const src = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('  /**\n   * The application\'s FINAL submit control');
  const end = src.indexOf('  /**\n   * True while AutoFill is running', start);
  if (start === -1 || end === -1) throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  SECTION = src.slice(start, end);
});

const ORIGINAL_LINK = 'https://bcbsla.wd1.myworkdayjobs.com/external/job/Remote-LA/Senior-Software-Engineer--Remote---Louisiana-_R11452';

// Workday's Review step (step 8 of 8): no fields, footer button "Submit".
const REVIEW_STEP = `
  <div data-automation-id="applyFlowReviewPage"><h3>Review</h3></div>
  <div data-automation-id="pageFooter">
    <button data-automation-id="pageFooterBackButton">Back</button>
    <button data-automation-id="pageFooterNextButton">Submit</button>
  </div>
`;

function load({ analysis = { matchScore: 88, url: ORIGINAL_LINK, title: 'Senior Software Engineer' }, tailored = null, markResult = { sheetsSynced: true, sheetsSyncConfigured: true }, validationError = false } = {}) {
  const events = [];
  const factory = new Function('events', 'analysis', 'tailored', 'markResult', 'validationError', ` // eslint-disable-line no-new-func
    const MIN_SCORE_TO_APPLY = 75;
    const currentAnalysis = analysis;
    const _tailoredSlotActive = !!tailored;
    const _tailoredResumeSlot = tailored;
    const WORKDAY_SELECT_TRIGGER_SELECTOR = '[data-automation-id^="formField-"] button[aria-haspopup="listbox"]';
    const normalizeUrl = (u) => u;
    const getFieldLabel = (el) => el.getAttribute('aria-label') || el.id || '';
    const getWorkdayFieldLabel = () => '';
    const isFieldEligible = () => true;
    const hasAnswer = (el) => globalThis.JMFieldFilter.hasAnswer(el);
    const workdayPromptHasSelection = (el) => !!el.closest('[data-automation-id="multiSelectContainer"]').querySelector('[data-automation-id="selectedItem"]');
    function hasVisibleValidationErrors() { return validationError || !!document.querySelector('[role="alert"]'); }
    function setStatus(text, level) { events.push({ status: text, level }); }
    function stopManualStepWatch() { events.push('stopWatch'); }
    async function sendMessage(msg) { events.push(msg.type); return {}; }
    async function waitForDomSettled() {}
    async function markApplied(opts) { events.push({ markApplied: opts }); return markResult; }
    const sleep = (ms) => new Promise(r => setTimeout(r, Math.min(ms, 20))); const FIELD_FILL_PACE_MS = 0; const CHOICE_CLICK_PACE_MS = 0;
    const clickElement = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    function dispatchFocusEvents(el, direction) {
      const [own, bubbling] = direction === 'in' ? ['focus', 'focusin'] : ['blur', 'focusout'];
      el.dispatchEvent(new FocusEvent(own, { bubbles: false }));
      el.dispatchEvent(new FocusEvent(bubbling, { bubbles: true }));
    }
    ${SECTION}
    return { findFinalSubmitButton, findUnfilledRequiredFields, autoSubmitApplicationIfReady };
  `);
  return { ...factory(events, analysis, tailored, markResult, validationError), events };
}

function wireSubmit(events) {
  const btn = document.querySelector('[data-automation-id="pageFooterNextButton"]');
  btn.addEventListener('click', () => events.push('SUBMIT_CLICKED'));
  return btn;
}

beforeEach(() => {
  document.body.innerHTML = REVIEW_STEP;
});

describe('findFinalSubmitButton', () => {
  it('finds Workday\'s Review-step "Submit" footer button', () => {
    expect(load().findFinalSubmitButton().getAttribute('data-automation-id')).toBe('pageFooterNextButton');
  });

  it.each(['Submit Application', 'Submit my application', 'Send Application', 'Finish', 'Complete Application', 'SUBMIT →'])('matches "%s"', (label) => {
    document.body.innerHTML = `<button id="b">${label}</button>`;
    expect(load().findFinalSubmitButton()?.id).toBe('b');
  });

  it.each(['Save and Continue', 'Next', 'Apply', 'Apply Now', 'Submit and Continue', 'Submit feedback about this site'])('never matches "%s"', (label) => {
    document.body.innerHTML = `<button id="b">${label}</button>`;
    expect(load().findFinalSubmitButton()).toBeNull();
  });

  it('skips a disabled Submit', () => {
    document.body.innerHTML = '<button id="b" disabled>Submit</button>';
    expect(load().findFinalSubmitButton()).toBeNull();
  });
});

describe('autoSubmitApplicationIfReady', () => {
  it('marks the job as Applied (sheet row) BEFORE clicking Submit, and clears the Auto-Bid state', async () => {
    const { autoSubmitApplicationIfReady, findFinalSubmitButton, events } = load();
    wireSubmit(events);

    expect(await autoSubmitApplicationIfReady(findFinalSubmitButton())).toBe(true);

    const mark = events.findIndex(e => e && e.markApplied);
    const cleared = events.indexOf('GET_AND_CLEAR_PENDING_AUTOFILL');
    const submit = events.indexOf('SUBMIT_CLICKED');
    expect(mark).toBeGreaterThan(-1);
    expect(mark).toBeLessThan(cleared);
    expect(cleared).toBeLessThan(submit);
    expect(events[mark].markApplied.score).toBe(88);
    expect(events.at(-1)).toEqual({ status: 'Marked as applied and submitted (match 88%).', level: 'success' });
  });

  it('does not submit (or mark applied) at a score of 75 or below', async () => {
    const { autoSubmitApplicationIfReady, findFinalSubmitButton, events } = load({ analysis: { matchScore: 75, url: ORIGINAL_LINK } });
    wireSubmit(events);
    expect(await autoSubmitApplicationIfReady(findFinalSubmitButton())).toBe(false);
    expect(events).not.toContain('SUBMIT_CLICKED');
    expect(events.some(e => e && e.markApplied)).toBe(false);
  });

  it('uses the tailored resume\'s own score when that is the resume attached', async () => {
    const { autoSubmitApplicationIfReady, findFinalSubmitButton, events } = load({
      analysis: { matchScore: 70, url: ORIGINAL_LINK },
      tailored: { newScore: 82, name: '18. Senior Developer — Tailored' },
    });
    wireSubmit(events);
    expect(await autoSubmitApplicationIfReady(findFinalSubmitButton())).toBe(true);
    expect(events.find(e => e && e.markApplied).markApplied).toEqual({ score: 82, resumeName: '18. Senior Developer — Tailored' });
  });

  it('does not submit without an analysis score', async () => {
    const { autoSubmitApplicationIfReady, findFinalSubmitButton, events } = load({ analysis: null });
    wireSubmit(events);
    expect(await autoSubmitApplicationIfReady(findFinalSubmitButton())).toBe(false);
    expect(events).not.toContain('SUBMIT_CLICKED');
  });

  it('does not submit while a validation error is showing', async () => {
    const { autoSubmitApplicationIfReady, findFinalSubmitButton, events } = load({ validationError: true });
    wireSubmit(events);
    expect(await autoSubmitApplicationIfReady(findFinalSubmitButton())).toBe(false);
    expect(events).not.toContain('SUBMIT_CLICKED');
  });

  it('does not submit when a required field is still empty, and names it', async () => {
    document.body.insertAdjacentHTML('afterbegin', `
      <input id="firstName" aria-label="First Name" aria-required="true" value="">
      <div data-automation-id="formField-q1"><button aria-haspopup="listbox" aria-label="Are you a U.S. Citizen? Select One Required" value="">Select One</button></div>
    `);
    const { autoSubmitApplicationIfReady, findFinalSubmitButton, events } = load();
    wireSubmit(events);
    expect(await autoSubmitApplicationIfReady(findFinalSubmitButton())).toBe(false);
    expect(events).not.toContain('SUBMIT_CLICKED');
    expect(events.some(e => e && e.markApplied)).toBe(false);
    const status = events.find(e => e && e.status && e.level === 'error').status;
    expect(status).toContain('2 required fields are still empty');
    expect(status).toContain('First Name');
  });

  it('does not submit when Sheets sync is set up but the sheet update failed', async () => {
    const { autoSubmitApplicationIfReady, findFinalSubmitButton, events } = load({
      markResult: { sheetsSynced: false, sheetsSyncConfigured: true, sheetsSyncError: 'Apps Script returned HTTP 500' },
    });
    wireSubmit(events);
    expect(await autoSubmitApplicationIfReady(findFinalSubmitButton())).toBe(false);
    expect(events).not.toContain('SUBMIT_CLICKED');
    expect(events.at(-1).status).toContain('Apps Script returned HTTP 500');
  });

  it('still submits when Sheets sync is simply not turned on (recorded locally)', async () => {
    const { autoSubmitApplicationIfReady, findFinalSubmitButton, events } = load({
      markResult: { sheetsSynced: false, sheetsSyncConfigured: false, sheetsSyncError: 'Google Sheets sync is not enabled.' },
    });
    wireSubmit(events);
    expect(await autoSubmitApplicationIfReady(findFinalSubmitButton())).toBe(true);
    expect(events).toContain('SUBMIT_CLICKED');
  });

  it('on "Missing entry for required field", re-commits those fields and submits once more (Ashby)', async () => {
    document.body.insertAdjacentHTML('afterbegin', `
      <label for="linkedin">LinkedIn Profile</label><input id="linkedin" value="https://linkedin.com/in/randolph">`);
    const committed = {};
    document.addEventListener('focusout', (e) => { if (e.target.id) committed[e.target.id] = e.target.value; });
    // The site's real validation: renders the error summary while LinkedIn
    // isn't committed to its state, clears it once it is.
    const btn = document.querySelector('[data-automation-id="pageFooterNextButton"]');
    const { autoSubmitApplicationIfReady, findFinalSubmitButton, events } = load({ validationError: false });
    btn.addEventListener('click', () => {
      events.push('SUBMIT_CLICKED');
      document.querySelector('[role="alert"]')?.remove();
      if (!committed.linkedin) {
        document.body.insertAdjacentHTML('afterbegin', '<div role="alert"><h2>Your form needs corrections</h2><p>Missing entry for required field: <button>LinkedIn Profile</button></p></div>');
      }
    });

    expect(await autoSubmitApplicationIfReady(findFinalSubmitButton())).toBe(true);
    expect(events.filter(e => e === 'SUBMIT_CLICKED')).toHaveLength(2);
    expect(committed.linkedin).toBe('https://linkedin.com/in/randolph');
  });

  it('never submits the same application twice', async () => {
    const { autoSubmitApplicationIfReady, findFinalSubmitButton, events } = load();
    wireSubmit(events);
    await autoSubmitApplicationIfReady(findFinalSubmitButton());
    expect(await autoSubmitApplicationIfReady(findFinalSubmitButton())).toBe(false);
    expect(events.filter(e => e === 'SUBMIT_CLICKED')).toHaveLength(1);
  });
});

describe('Greenhouse "Submit application" (react-select comboboxes)', () => {
  // Live: every field filled, score above 75, yet "Submit application" was
  // never clicked — Greenhouse's react-select inputs stay EMPTY after a
  // choice (shown in a sibling select__single-value), so each answered
  // dropdown was counted as a missing required field.
  const GREENHOUSE = (countryChosen) => `
    <div class="field-wrapper">
      <label for="country" id="country-label">Country<span aria-label="required">*</span></label>
      <div class="select__control">
        <div class="select__value-container">
          ${countryChosen ? '<div class="select__single-value">United States</div>' : '<div class="select__placeholder">Select...</div>'}
          <input class="select__input" id="country" role="combobox" aria-required="true" aria-labelledby="country-label" value="">
        </div>
      </div>
    </div>
    <div class="application--submit"><button type="submit" class="btn btn--pill" aria-disabled="false">Submit application</button></div>`;

  it('finds the button and submits when the dropdowns are answered', async () => {
    document.body.innerHTML = GREENHOUSE(true);
    const { autoSubmitApplicationIfReady, findFinalSubmitButton, events } = load();
    const btn = findFinalSubmitButton();
    expect(btn.textContent).toBe('Submit application');
    btn.addEventListener('click', () => events.push('SUBMIT_CLICKED'));

    expect(await autoSubmitApplicationIfReady(btn)).toBe(true);
    expect(events).toContain('SUBMIT_CLICKED');
  });

  it('still refuses when a react-select is genuinely unanswered', async () => {
    document.body.innerHTML = GREENHOUSE(false);
    const { autoSubmitApplicationIfReady, findFinalSubmitButton, events } = load();
    expect(await autoSubmitApplicationIfReady(findFinalSubmitButton())).toBe(false);
    expect(events.find(e => e && e.level === 'error').status).toContain('1 required field is still empty');
  });
});

describe('findUnfilledRequiredFields', () => {
  it('counts required radio groups, checkboxes and Workday prompts; ignores filled and optional fields', () => {
    document.body.innerHTML = `
      <input id="filled" aria-required="true" value="Randolph">
      <input id="optional" value="">
      <div aria-required="true"><input type="radio" name="relocate" id="r1"><input type="radio" name="relocate" id="r2"></div>
      <input type="checkbox" id="terms" required>
      <div data-automation-id="formField-source"><div data-automation-id="multiSelectContainer">
        <input id="source--source" data-uxi-widget-type="selectinput" aria-required="true" value=""></div></div>
      <div data-automation-id="formField-country"><div data-automation-id="multiSelectContainer">
        <input id="countryCode" data-uxi-widget-type="selectinput" aria-required="true" value="United States">
        <div data-automation-id="selectedItem">United States of America (+1)</div></div></div>
    `;
    expect(load().findUnfilledRequiredFields().sort()).toEqual(['r1', 'source--source', 'terms']);
  });
});
