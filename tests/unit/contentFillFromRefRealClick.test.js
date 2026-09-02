// content.js is a large content script that isn't practical to load
// wholesale under happy-dom (see contentRadioGroupLabel.test.js), so this
// extracts just fillRadioFromRef, fillCheckboxFromRef, fireEvents, and
// clickNatively by source range and evals them in isolation.
//
// Companion to tests/unit/directFillRealClick.test.js, but for content.js's
// own AI-facing (Pass 2) radio/checkbox fillers. Same root cause: assigning
// `.checked = true/false` and firing synthetic input/change events doesn't
// reliably register with a React-controlled component's internal state,
// even though `.checked` itself ends up looking correct in the DOM — the
// fix is a genuine `.click()`, which goes through the browser's native
// activation behavior instead. These tests assert a real 'click' event was
// dispatched, which the old `r.el.checked = true; fireEvents(r.el);` /
// `cb.checked = shouldCheck; fireEvents(cb);` code never did.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');

let fillRadioFromRef, fillCheckboxFromRef;

beforeAll(() => {
  const src = fs.readFileSync(CONTENT_JS_PATH, 'utf8');
  const startMarker = 'function fillRadioFromRef(radioRefs, selectedText) {';
  const endMarker = 'function fillInput(input, value) {';
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  }
  const extracted = src.slice(start, end);
  // eslint-disable-next-line no-eval
  const factory = (0, eval)(`(function () { ${extracted} return { fillRadioFromRef, fillCheckboxFromRef }; })`);
  ({ fillRadioFromRef, fillCheckboxFromRef } = factory());
});

function trackClicks(el) {
  const clicks = [];
  el.addEventListener('click', () => clicks.push(true));
  return clicks;
}

describe('content.js fillRadioFromRef uses a real click, not property assignment', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <input type="radio" id="opt-man" name="gender-grp" value="man">
      <input type="radio" id="opt-woman" name="gender-grp" value="woman">
      <input type="radio" id="opt-nonbinary" name="gender-grp" value="nonbinary">
    `;
  });

  it('selects the exact-match option via a genuine click', () => {
    const man = document.getElementById('opt-man');
    const woman = document.getElementById('opt-woman');
    const clicks = trackClicks(man);

    const radioRefs = [
      { el: man, text: 'Man' },
      { el: woman, text: 'Woman' },
      { el: document.getElementById('opt-nonbinary'), text: 'Non-Binary' }
    ];
    const result = fillRadioFromRef(radioRefs, 'Man');

    expect(result).toBe(true);
    expect(man.checked).toBe(true);
    expect(woman.checked).toBe(false);
    // The old code (`r.el.checked = true; fireEvents(r.el);`) never
    // dispatches a real 'click' event.
    expect(clicks.length).toBe(1);
  });

  it('selects the partial-match option via a genuine click', () => {
    const nonbinary = document.getElementById('opt-nonbinary');
    const clicks = trackClicks(nonbinary);

    const radioRefs = [
      { el: document.getElementById('opt-man'), text: 'Man' },
      { el: document.getElementById('opt-woman'), text: 'Woman' },
      { el: nonbinary, text: 'Non-Binary' }
    ];
    // Deliberately avoids substrings like "man"/"woman" that would collide
    // with the other options' labels (e.g. "a woman" contains "man").
    const result = fillRadioFromRef(radioRefs, 'identify as non-binary');

    expect(result).toBe(true);
    expect(nonbinary.checked).toBe(true);
    expect(clicks.length).toBe(1);
  });

  it('relies on native radio-group exclusivity to correct an already-wrong selection', () => {
    const nonbinary = document.getElementById('opt-nonbinary');
    nonbinary.checked = true; // stale/incorrect prior selection

    const man = document.getElementById('opt-man');
    const manClicks = trackClicks(man);

    const radioRefs = [
      { el: man, text: 'Man' },
      { el: document.getElementById('opt-woman'), text: 'Woman' },
      { el: nonbinary, text: 'Non-Binary' }
    ];
    fillRadioFromRef(radioRefs, 'Man');

    expect(man.checked).toBe(true);
    expect(nonbinary.checked).toBe(false);
    expect(manClicks.length).toBe(1);
  });

  it('does not click again when the correct option is already selected', () => {
    const man = document.getElementById('opt-man');
    man.checked = true;
    const clicks = trackClicks(man);

    const radioRefs = [
      { el: man, text: 'Man' },
      { el: document.getElementById('opt-woman'), text: 'Woman' }
    ];
    const result = fillRadioFromRef(radioRefs, 'Man');

    expect(result).toBe(true);
    expect(clicks.length).toBe(0);
  });

  it('returns false and clicks nothing when no option matches', () => {
    const radioRefs = [
      { el: document.getElementById('opt-man'), text: 'Man' },
      { el: document.getElementById('opt-woman'), text: 'Woman' }
    ];
    const result = fillRadioFromRef(radioRefs, 'Prefer not to say');
    expect(result).toBe(false);
  });
});

describe('content.js fillCheckboxFromRef uses a real click, not property assignment', () => {
  beforeEach(() => {
    document.body.innerHTML = `<input type="checkbox" id="subscribe">`;
  });

  it('checks the box via a genuine click for an affirmative value', () => {
    const cb = document.getElementById('subscribe');
    const clicks = trackClicks(cb);

    fillCheckboxFromRef(cb, 'yes');

    expect(cb.checked).toBe(true);
    expect(clicks.length).toBe(1);
  });

  it('unchecks an already-checked box via a genuine click for a negative value', () => {
    const cb = document.getElementById('subscribe');
    cb.checked = true;
    const clicks = trackClicks(cb);

    fillCheckboxFromRef(cb, 'no');

    expect(cb.checked).toBe(false);
    expect(clicks.length).toBe(1);
  });

  it('does not click again when already in the desired state', () => {
    const cb = document.getElementById('subscribe');
    const clicks = trackClicks(cb);

    fillCheckboxFromRef(cb, 'no');

    expect(cb.checked).toBe(false);
    expect(clicks.length).toBe(0);
  });
});
