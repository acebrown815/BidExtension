// Live on Ashby (jobs.ashbyhq.com, Horizon3.ai): Yes/No toggles and a radio
// group all LOOKED answered after AutoFill, yet Submit reported one or two of
// them "Missing entry for required field" — a DIFFERENT one on each run
// ("legally authorized" one time, "sponsorship" the next). That is the
// signature of state updates overwriting each other: the clicks went out
// back-to-back in one burst, and each update was built from the state as it
// was before the others landed.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js'), 'utf8').replace(/\r\n/g, '\n');
const slice = (a, b) => {
  const start = SRC.indexOf(a);
  const end = SRC.indexOf(b, start);
  if (start === -1 || end === -1) throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  return SRC.slice(start, end);
};

let FILL_SRC;
let RESELECT_SRC;
beforeAll(() => {
  FILL_SRC = slice('  // Pause after each click-based answer', '/**\n   * Legacy fill path for old-format AI responses');
  RESELECT_SRC = slice('  async function reselectChoiceFieldByLabel(labelText) {', '  /**\n   * After a rejected submit, finds the fields');
});

const FORM = `
  <div data-field-path="auth"><label>Are you legally authorized to work in the United States?</label>
    <div class="ashby-application-form-input-yesno">
      <button aria-pressed="false" data-option="yes">Yes</button><button aria-pressed="false" data-option="no">No</button>
      <input type="checkbox" tabindex="-1" name="auth"></div></div>
  <div data-field-path="sponsor"><label>Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa status)?</label>
    <div class="ashby-application-form-input-yesno">
      <button aria-pressed="false" data-option="yes">Yes</button><button aria-pressed="false" data-option="no">No</button>
      <input type="checkbox" tabindex="-1" name="sponsor"></div></div>
`;

/**
 * Ashby-like form state with the race: each click updates the screen at
 * once, but its state update is built from a snapshot taken at click time and
 * applied 100ms later — so two clicks inside that window lose one answer.
 */
function wireStaleStateForm() {
  const form = { state: {} };
  document.querySelectorAll('[data-field-path]').forEach(entry => {
    const field = entry.getAttribute('data-field-path');
    entry.querySelectorAll('button[data-option]').forEach(btn => btn.addEventListener('click', () => {
      const already = btn.getAttribute('aria-pressed') === 'true';
      entry.querySelectorAll('button[data-option]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
      if (already) return; // re-clicking the selected option changes nothing
      const snapshot = { ...form.state };
      setTimeout(() => { form.state = { ...snapshot, [field]: btn.getAttribute('data-option') }; }, 100);
    }));
  });
  return form;
}

function loadFill() {
  return new Function(` // eslint-disable-line no-new-func
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const _fieldMap = {};
    const _activeResumeId = 'r1';
    function showAutofillBadge() {}
    function fillRadioFromRef() { return true; }
    function fillCheckboxFromRef() {}
    function fillInput(el, value) {
      el.value = value;
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      return true;
    }
    function fillSelectByText() {}
    function fillYesNoToggle(ref, val) {
      const btn = val === 'Yes' ? ref.yesBtn : ref.noBtn;
      btn.click();
      return btn;
    }
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
    ${FILL_SRC}
    return { fillFormFromAnswers, _fieldMap };
  `)();
}

function loadReselect() {
  return new Function(` // eslint-disable-line no-new-func
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const CHOICE_CLICK_PACE_MS = 250;
    const clickNatively = (el) => el.click();
    ${RESELECT_SRC}
    return reselectChoiceFieldByLabel;
  `)();
}

const toggleRef = (field) => {
  const entry = document.querySelector(`[data-field-path="${field}"]`);
  return {
    type: 'yesno_toggle',
    yesBtn: entry.querySelector('[data-option="yes"]'),
    noBtn: entry.querySelector('[data-option="no"]'),
  };
};

beforeEach(() => { document.body.innerHTML = FORM; });

describe('fillFormFromAnswers — paces click-based answers', () => {
  it('both toggles reach the form state (a burst would have lost one)', async () => {
    const form = wireStaleStateForm();
    const { fillFormFromAnswers, _fieldMap } = loadFill();
    _fieldMap.auth = toggleRef('auth');
    _fieldMap.sponsor = toggleRef('sponsor');

    await fillFormFromAnswers([
      { question_id: 'auth', selected_option: 'Yes' },
      { question_id: 'sponsor', selected_option: 'No' },
    ]);
    await new Promise(r => setTimeout(r, 150));

    expect(form.state).toEqual({ auth: 'yes', sponsor: 'no' });
  });

  it('(control) the same two clicks in one burst do lose an answer on this form', async () => {
    const form = wireStaleStateForm();
    toggleRef('auth').yesBtn.click();
    toggleRef('sponsor').noBtn.click();
    await new Promise(r => setTimeout(r, 150));
    expect(Object.keys(form.state)).toHaveLength(1);
  });
});

describe('fillFormFromAnswers — paces text fills too', () => {
  it('Phone and LinkedIn both reach the form state when filled one after another', async () => {
    document.body.innerHTML = `
      <div data-field-path="phone"><label for="phone">Phone</label><input id="phone" type="tel" value=""></div>
      <div data-field-path="linkedin"><label for="linkedin">LinkedIn Profile</label><input id="linkedin" value=""></div>`;
    // Ashby-like: each blur commits from a snapshot taken at blur time,
    // applied 100ms later.
    const form = { state: {} };
    document.addEventListener('focusout', (e) => {
      const snapshot = { ...form.state };
      const { id, value } = e.target;
      setTimeout(() => { form.state = { ...snapshot, [id]: value }; }, 100);
    });
    const { fillFormFromAnswers, _fieldMap } = loadFill();
    _fieldMap.phone = { type: 'text', el: document.getElementById('phone') };
    _fieldMap.linkedin = { type: 'text', el: document.getElementById('linkedin') };

    await fillFormFromAnswers([
      { question_id: 'phone', generated_text: '+1(720)310-5861' },
      { question_id: 'linkedin', generated_text: 'https://linkedin.com/in/randolph-brown-34286528b' },
    ]);
    await new Promise(r => setTimeout(r, 150));

    expect(form.state).toEqual({ phone: '+1(720)310-5861', linkedin: 'https://linkedin.com/in/randolph-brown-34286528b' });
  });
});

describe('reselectChoiceFieldByLabel — safety net after "Missing entry"', () => {
  it('re-picks the shown answer of a toggle whose update was lost', async () => {
    const form = wireStaleStateForm();
    // On screen "No", but the form never recorded it.
    document.querySelector('[data-field-path="sponsor"] [data-option="no"]').setAttribute('aria-pressed', 'true');

    const reselect = loadReselect();
    expect(await reselect('Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa status)?')).toBe(true);
    await new Promise(r => setTimeout(r, 150));

    expect(form.state.sponsor).toBe('no');
    expect(document.querySelector('[data-field-path="sponsor"] [data-option="no"]').getAttribute('aria-pressed')).toBe('true');
  });

  it('re-picks the checked option of a radio group', async () => {
    document.body.innerHTML = `
      <div data-field-path="hear"><fieldset><label>How did you hear about this opportunity?</label>
        <div><input type="radio" id="r0" name="hear"><label for="r0">Company website / careers page</label></div>
        <div><input type="radio" id="r1" name="hear"><label for="r1">LinkedIn</label></div></fieldset></div>`;
    document.getElementById('r1').checked = true;
    const changes = [];
    document.querySelectorAll('input[name="hear"]').forEach(r => r.addEventListener('change', () => changes.push(r.id)));

    expect(await loadReselect()('How did you hear about this opportunity?')).toBe(true);

    expect(changes).toEqual(['r0', 'r1']);
    expect(document.getElementById('r1').checked).toBe(true);
  });

  it('returns false for a field that is not a choice field', async () => {
    document.body.innerHTML = '<div data-field-path="li"><label>LinkedIn Profile</label><input value="x"></div>';
    expect(await loadReselect()('LinkedIn Profile')).toBe(false);
  });
});
