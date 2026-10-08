// Live on Ashby (jobs.ashbyhq.com, Trilitech): every field visibly held its
// value after AutoFill, yet Submit reported "Missing entry for required field"
// for LinkedIn Profile, "What location do you plan to work from?" and "If we
// were to hire you, when are you available to start?" — until the user
// clicked into each one by hand. The form only commits a field to its own
// (React) state on focus change; React's onFocus/onBlur listen to the
// bubbling focusin/focusout, and AutoFill only fired a plain 'blur'.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { qaQuestionMatchesLabel } = require(path.join(ROOT, 'lib', 'qaMatch.js'));

let FILL_SRC;
let RECOMMIT_SRC;

beforeAll(() => {
  const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8').replace(/\r\n/g, '\n');
  const slice = (a, b) => {
    const start = src.indexOf(a);
    const end = src.indexOf(b, start);
    if (start === -1 || end === -1) throw new Error('content.js source anchors moved — update this test\'s extraction markers');
    return src.slice(start, end);
  };
  FILL_SRC = slice('  function clickNatively(el) {', '  // ─── Cover letter');
  RECOMMIT_SRC = slice('  /**\n   * Re-commits a value a field already shows', '  // Normalized job URL this content-script instance already auto-submitted');
});

const ASHBY_FORM = `
  <div class="ashby-application-form-container">
    <div class="ashby-application-form-field-entry" data-field-path="a19c556b">
      <label for="a19c556b-468a-48d1-a16b-f947caa592a2">LinkedIn Profile</label>
      <div><input name="a19c556b" required id="a19c556b-468a-48d1-a16b-f947caa592a2" type="text" value=""></div></div>
    <div class="ashby-application-form-field-entry" data-field-path="d3c92b11">
      <label for="d3c92b11-ce64-4086-adfb-2c7408924b2d">What location do you plan to work from?</label>
      <div><input name="d3c92b11" required id="d3c92b11-ce64-4086-adfb-2c7408924b2d" type="text" value=""></div></div>
  </div>
`;

/**
 * Ashby-like state: a field's value only reaches the form's own state when
 * focus leaves it (focusout). Returns the committed state.
 */
function wireCommitOnBlur() {
  const committed = {};
  document.addEventListener('focusout', (e) => { if (e.target.id) committed[e.target.id] = e.target.value; });
  return committed;
}

function load() {
  const factory = new Function(` // eslint-disable-line no-new-func
    const sleep = (ms) => new Promise(r => setTimeout(r, Math.min(ms, 20))); const FIELD_FILL_PACE_MS = 0; const CHOICE_CLICK_PACE_MS = 0;
    const clickElement = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    ${FILL_SRC}
    ${RECOMMIT_SRC}
    return { fillInput, clickNatively, recommitFieldsNamedInErrors };
  `);
  return factory();
}

beforeEach(() => {
  document.body.innerHTML = ASHBY_FORM;
});

describe('fillInput — commits the value the way a person would (focus → type → leave)', () => {
  it('fires focusin/focusout around the value, so commit-on-blur forms register it', () => {
    const committed = wireCommitOnBlur();
    const { fillInput } = load();
    const order = [];
    const input = document.getElementById('a19c556b-468a-48d1-a16b-f947caa592a2');
    ['focusin', 'input', 'change', 'focusout'].forEach(t => input.addEventListener(t, () => order.push(t)));

    fillInput(input, 'https://linkedin.com/in/randolph-brown-34286528b');

    expect(order).toEqual(['focusin', 'input', 'change', 'focusout']);
    expect(committed['a19c556b-468a-48d1-a16b-f947caa592a2']).toBe('https://linkedin.com/in/randolph-brown-34286528b');
  });
});

describe('recommitFieldsNamedInErrors — after "Missing entry for required field"', () => {
  it('re-commits each field the error summary names, by its label', async () => {
    const committed = wireCommitOnBlur();
    document.getElementById('a19c556b-468a-48d1-a16b-f947caa592a2').value = 'https://linkedin.com/in/randolph';
    document.getElementById('d3c92b11-ce64-4086-adfb-2c7408924b2d').value = 'Remote';
    document.body.insertAdjacentHTML('afterbegin', `
      <div role="alert" aria-live="assertive"><h2>Your form needs corrections</h2><ul>
        <li><p>Missing entry for required field: <button>LinkedIn Profile</button></p></li>
        <li><p>Missing entry for required field: <button>What location do you plan to work from?</button></p></li>
      </ul></div>`);
    const { recommitFieldsNamedInErrors } = load();

    expect(await recommitFieldsNamedInErrors()).toBe(2);
    expect(committed).toEqual({
      'a19c556b-468a-48d1-a16b-f947caa592a2': 'https://linkedin.com/in/randolph',
      'd3c92b11-ce64-4086-adfb-2c7408924b2d': 'Remote',
    });
  });

  it('skips a named field that is actually empty, and does nothing without an error summary', async () => {
    const { recommitFieldsNamedInErrors } = load();
    expect(await recommitFieldsNamedInErrors()).toBe(0);
    document.body.insertAdjacentHTML('afterbegin', '<div role="alert"><p>Missing entry for required field: <button>LinkedIn Profile</button></p></div>');
    expect(await recommitFieldsNamedInErrors()).toBe(0);
  });
});

const ASHBY_TOGGLES = `
  <div class="ashby-application-form-field-entry" data-field-path="78d2fa31">
    <label for="78d2fa31-5fc7-4f98-be45-9e2db9522a11">Are you legally authorized to work in the United States?</label>
    <div class="ashby-application-form-input-yesno">
      <button aria-pressed="false" data-option="yes">Yes</button><button aria-pressed="false" data-option="no">No</button>
      <input type="checkbox" tabindex="-1" name="78d2fa31-5fc7-4f98-be45-9e2db9522a11"></div></div>
  <div data-field-path="b25ce0fe"><fieldset class="ashby-application-form-input-radio-group">
    <label for="b25ce0fe-68dc-4d63-9f11-d9a0946d6577">How did you hear about this opportunity?</label>
    <div><input type="radio" id="r0" name="hear"><label for="r0">Company website / careers page</label></div>
    <div><input type="radio" id="r1" name="hear"><label for="r1">LinkedIn</label></div>
  </fieldset></div>
`;

/**
 * Ashby-like: a click updates what's shown at once, but the field's answer
 * only reaches the form's state on focusout from inside that field.
 */
function wireAshbyChoiceFields() {
  const shown = {};
  const committed = {};
  document.querySelectorAll('[data-option]').forEach(btn => btn.addEventListener('click', () => {
    btn.parentElement.querySelectorAll('[data-option]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
    shown.auth = btn.getAttribute('data-option');
  }));
  document.querySelectorAll('input[name="hear"]').forEach(r => r.addEventListener('change', () => { shown.hear = r.id; }));
  document.addEventListener('focusout', (e) => {
    const entry = e.target.closest('[data-field-path]');
    if (entry && entry.getAttribute('data-field-path') === '78d2fa31' && shown.auth) committed.auth = shown.auth;
    if (entry && entry.getAttribute('data-field-path') === 'b25ce0fe' && shown.hear) committed.hear = shown.hear;
  });
  return { shown, committed };
}

describe('clickNatively — choice fields commit like a real click (Ashby Yes/No toggle, radio group)', () => {
  beforeEach(() => { document.body.innerHTML = ASHBY_TOGGLES; });

  it('a toggle click reaches the form state, not just the screen', () => {
    const { shown, committed } = wireAshbyChoiceFields();
    load().clickNatively(document.querySelector('[data-option="yes"]'));
    expect(shown.auth).toBe('yes');
    expect(committed.auth).toBe('yes');
  });

  it('a radio click reaches the form state', () => {
    const { committed } = wireAshbyChoiceFields();
    load().clickNatively(document.getElementById('r1'));
    expect(committed.hear).toBe('r1');
  });

  it('still commits when the click re-renders (detaches) the clicked element', () => {
    const { committed } = wireAshbyChoiceFields();
    const yes = document.querySelector('[data-option="yes"]');
    yes.addEventListener('click', () => {
      const fresh = yes.cloneNode(true);
      yes.replaceWith(fresh); // React swapping the node mid-click
    });
    load().clickNatively(yes);
    expect(committed.auth).toBe('yes');
  });

  it('after a rejected submit, the safety net commits choice fields named in the error summary', async () => {
    const { shown, committed } = wireAshbyChoiceFields();
    shown.auth = 'yes'; // chosen on screen, never committed
    document.body.insertAdjacentHTML('afterbegin', `<div role="alert"><h2>Your form needs corrections</h2>
      <p>Missing entry for required field: <button id="link-auth">Are you legally authorized to work in the United States?</button></p></div>`);
    // Like Ashby: the error link moves focus to the field's control.
    document.getElementById('link-auth').addEventListener('click', () => document.querySelector('[data-option="yes"]').focus());

    expect(await load().recommitFieldsNamedInErrors()).toBe(1);
    expect(committed.auth).toBe('yes');
  });
});

describe('qaQuestionMatchesLabel — "relocation" must not answer a "location" question', () => {
  it('a single shared strong word only counts when it appears whole in the label', () => {
    expect(qaQuestionMatchesLabel('Are you open to relocation?', 'What location do you plan to work from?')).toBe(false);
    expect(qaQuestionMatchesLabel('Are you open to relocation?', 'Are you willing to consider relocation for this role?')).toBe(true);
    expect(qaQuestionMatchesLabel('Will you require visa sponsorship now or in the future?', 'Do you need sponsorship?')).toBe(true);
  });
});
