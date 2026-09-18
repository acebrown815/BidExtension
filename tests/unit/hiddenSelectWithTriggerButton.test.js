// Regression test for a real bug: Dice's "Work Authorization" field (and
// similar accessible-component-library patterns — this one is React Aria
// Components, confirmed via its `data-rac` attributes) renders a REAL
// <select> purely for native form semantics, visually hidden via the
// standard clip-rect/clip-path technique, while the actual visible
// interaction happens through a separate custom trigger button
// (aria-haspopup="listbox") + listbox popover.
//
// detectFormFields() used to treat every <select> — hidden or not — as a
// plain native dropdown, filled by setting .value directly and firing a
// 'change' event. For a React-Aria-controlled select, that does NOT
// reliably update the library's own internal state: the library's next
// render can silently revert the select back to whatever it still
// believes is selected. This was confirmed live: no matter what the
// deterministic Q&A matcher correctly decided ("US Citizen"), the visible
// widget kept "choosing" the same wrong option ("Have H1 Visa") — the
// fill technically ran, but never actually took effect.
//
// Fix: a <select> that's visually hidden AND has a sibling custom trigger
// button is now registered as a custom_dropdown using the TRIGGER BUTTON
// as the element to interact with (open it, wait for the listbox, click
// the matching option) — exactly the same flow already used for every
// other custom ARIA dropdown, which correctly drives the library's real
// selection-change handling.
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom (see contentRadioGroupLabel.test.js), so this
// extracts isVisuallyHiddenElement() and the new hidden-select-with-
// trigger detection block by source range and evals them with small
// stand-ins for their dependencies.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');

let runDetection;

beforeAll(() => {
  const src = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');
  const startMarker = 'function isVisuallyHiddenElement(el) {';
  const endMarker = '\n    // ── 1. ALL <select> elements (visible AND hidden) ──';
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  }
  const extracted = src.slice(start, end);

  // The extracted block reads/mutates `seen`, `questions`, `_fieldMap`,
  // `qIndex` as outer-scope variables (matching how it actually runs
  // inside detectFormFields()) and calls isFieldEligible/getFieldLabel/
  // buildSelectOptions — stubbed here rather than also extracted, since
  // this test is specifically about the detection/classification
  // decision, not those already-covered helpers.
  const factory = new Function( // eslint-disable-line no-new-func
    'stubs',
    `
    const seen = new Set();
    const questions = [];
    const _fieldMap = {};
    let qIndex = 0;
    function isFieldEligible(el) { return stubs.isFieldEligible(el); }
    function getFieldLabel(el) { return stubs.getFieldLabel(el); }
    function buildSelectOptions(sel) { return stubs.buildSelectOptions(sel); }
    ${extracted}
    return { questions, _fieldMap };
    `,
  );
  runDetection = (stubs) => factory(stubs);
});

function defaultStubs(overrides = {}) {
  return {
    isFieldEligible: () => true,
    getFieldLabel: (el) => (el.tagName === 'SELECT' ? '' : el.getAttribute('aria-label') || ''),
    buildSelectOptions: (sel) => {
      const optTexts = Array.from(sel.options).map(o => o.textContent.trim()).filter(Boolean);
      return { optMap: {}, optTexts };
    },
    ...overrides,
  };
}

// Verbatim (trimmed) structure from Dice's real "Work Authorization" field.
function makeDiceWorkAuthField() {
  document.body.innerHTML = `
    <div class="group flex flex-col gap-1 mb-2" data-rac="" data-required="true">
      <div><span slot="label">Work Authorization</span></div>
      <button aria-haspopup="listbox" aria-expanded="false" aria-label="Work Authorization">
        Have H1 Visa
      </button>
      <div aria-hidden="true" data-testid="hidden-select-container"
           style="clip: rect(0px, 0px, 0px, 0px); clip-path: inset(50%); height: 1px; width: 1px; position: fixed;">
        <label>
          <select tabindex="-1" name="workAuthorization">
            <option value="" label="&nbsp;">&nbsp;</option>
            <option value="US_CITIZEN">US Citizen</option>
            <option value="HAVE_H1_VISA">Have H1 Visa</option>
          </select>
        </label>
      </div>
    </div>
  `;
  return {
    select: document.querySelector('select'),
    trigger: document.querySelector('button[aria-haspopup="listbox"]'),
  };
}

describe('hidden-select-with-trigger-button detection (Dice Work Authorization case)', () => {
  it('registers the field as custom_dropdown using the TRIGGER BUTTON, not the hidden select', () => {
    makeDiceWorkAuthField();
    const { questions, _fieldMap } = runDetection(defaultStubs());

    expect(questions).toHaveLength(1);
    expect(questions[0].field_type).toBe('custom_dropdown');
    expect(questions[0].available_options).toEqual(['US Citizen', 'Have H1 Visa']);

    const qid = questions[0].question_id;
    expect(_fieldMap[qid].type).toBe('custom_dropdown');
    expect(_fieldMap[qid].el.tagName).toBe('BUTTON'); // NOT the <select>
  });

  it('ignores a genuinely visible <select> (the normal, unhidden case)', () => {
    document.body.innerHTML = `
      <select name="country"><option value="US">United States</option></select>
    `;
    const { questions } = runDetection(defaultStubs());
    expect(questions).toHaveLength(0); // visible selects are handled by the existing native-dropdown pass, not this one
  });

  it('ignores a visually-hidden select with no associated trigger button', () => {
    document.body.innerHTML = `
      <div style="clip: rect(0px, 0px, 0px, 0px);">
        <select name="lonely"><option value="a">A</option></select>
      </div>
    `;
    const { questions } = runDetection(defaultStubs());
    expect(questions).toHaveLength(0); // nothing to click — leave it for the native-dropdown pass to attempt
  });

  it('skips a hidden select+trigger pair when nothing identifies the field at all (no label, no id, no name)', () => {
    document.body.innerHTML = `
      <div data-rac="">
        <button aria-haspopup="listbox"></button>
        <div style="clip: rect(0px, 0px, 0px, 0px);">
          <select><option value="a">A</option></select>
        </div>
      </div>
    `;
    const { questions } = runDetection(defaultStubs({ getFieldLabel: () => '' }));
    expect(questions).toHaveLength(0);
  });
});
