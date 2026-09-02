// content.js is a large content script that isn't practical to load
// wholesale under happy-dom (see contentRadioGroupLabel.test.js), so this
// extracts just getRadioLabel() by source range and evals it in isolation.
//
// Root cause: getRadioLabel() tried input.closest('label') (an ANCESTOR
// <label> wrapping the input), then input.nextSibling (a label immediately
// adjacent to the input within its own parent). Neither strategy finds a
// <label for="optionId"> that sits OUTSIDE the input's wrapping element —
// e.g. Ashby's real markup:
//
//   <span class="_container_..."><span class="_circle_..."></span>
//     <input type="radio" id="opt-a">
//   </span>
//   <label for="opt-a">Yes</label>
//
// Here the label is a SIBLING of the <span> that wraps the radio, not an
// ancestor of the radio and not adjacent to it either (the radio is the
// last child of its own wrapping span). Every one of getRadioLabel's old
// strategies missed it, so it fell all the way through to '' for every
// option on this kind of form.
//
// The consequence was silent and total: detectFormFields() (content.js,
// section 3) only adds a radio group to `available_options` when at least
// one option's getRadioLabel() text is non-empty; with every option
// resolving to '', the WHOLE GROUP was dropped from `questions` before it
// was ever sent to the AI — not "answered wrong", just invisible to Pass 2
// entirely, with no error anywhere. Pass 1 (directFill.js) was unaffected
// since it already used the native `.labels` reflection for this — the
// fix here is to give getRadioLabel() that same first strategy.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');

let getRadioLabel;

beforeAll(() => {
  const src = fs.readFileSync(CONTENT_JS_PATH, 'utf8');
  const startMarker = 'function getRadioLabel(input) {';
  const endMarker = '/**\n   * Resolves a human-readable label for a form input';
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  }
  const extracted = src.slice(start, end);
  // eslint-disable-next-line no-eval
  const factory = (0, eval)(`(function () { ${extracted} return { getRadioLabel }; })`);
  ({ getRadioLabel } = factory());
});

describe('content.js getRadioLabel', () => {
  it('resolves a label that is a sibling of the radio\'s wrapping element (Ashby-style)', () => {
    document.body.innerHTML = `
      <div class="_option_1258i_34 ashby-application-form-input-radio-group-option">
        <span class="_container_132c8_28"><span class="_circle_132c8_77"></span>
          <input type="radio" id="opt-a" name="grp">
        </span>
        <label for="opt-a" class="ashby-application-form-input-radio-group-option-label">Yes </label>
      </div>
    `;
    const radio = document.getElementById('opt-a');
    expect(getRadioLabel(radio)).toBe('Yes');
  });

  it('still resolves a wrapping <label> (label is an ancestor of the input)', () => {
    document.body.innerHTML = `
      <label><input type="radio" id="opt-b" name="grp"> No</label>
    `;
    const radio = document.getElementById('opt-b');
    expect(getRadioLabel(radio)).toBe('No');
  });

  it('still resolves a label immediately following the input as a plain text sibling', () => {
    document.body.innerHTML = `
      <span><input type="radio" id="opt-c" name="grp"> Maybe</span>
    `;
    const radio = document.getElementById('opt-c');
    expect(getRadioLabel(radio)).toBe('Maybe');
  });

  it('falls back to aria-label when no label element is associated', () => {
    document.body.innerHTML = `<input type="radio" id="opt-d" name="grp" aria-label="Definitely">`;
    const radio = document.getElementById('opt-d');
    expect(getRadioLabel(radio)).toBe('Definitely');
  });

  it('returns empty string when nothing identifies the option (never returns the default "on" value)', () => {
    document.body.innerHTML = `<input type="radio" id="opt-e" name="grp">`;
    const radio = document.getElementById('opt-e');
    expect(getRadioLabel(radio)).toBe('');
  });
});
