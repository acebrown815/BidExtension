// Regression coverage for the "left blank" bug: direct-filling a radio
// group or checkbox by assigning `.checked = true/false` and firing
// synthetic input/change events doesn't reliably register with a
// React-controlled component (the same class of problem already fixed
// elsewhere in this codebase for text-input `.value` via
// setNativeInputValue, and for the Ashby Yes/No toggle buttons via a real
// `.click()` instead of manipulating the decoy checkbox — see
// directFillYesNoToggle.test.js).
//
// These tests exercise the FULL __jobMatchDirectFill entry point (not just
// the clickNatively helper in isolation) so they fail the same way
// the pre-fix code did: they assert that a genuine 'click' event was
// dispatched on the target element. A raw `el.checked = ...` + synthetic
// `fireEvents()` never fires a 'click' event at all, so these tests would
// have failed against the old code even though `.checked` ended up correct
// — which is exactly the discrepancy that let the old bug hide behind
// "the code says filled" while a React re-render silently reverted it.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIRECT_FILL_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'directFill.js');

// Same shape as the user's real, live Ashby gender-identity fieldset, but
// with non-digit-leading option ids (sidesteps an unrelated happy-dom
// CSS.escape quirk with digit-leading ids — see
// directFillRadioGroupLabel.test.js for the full writeup).
const GENDER_FIELDSET_HTML = `
<fieldset class="ashby-application-form-input-radio-group">
  <label for="gender-q">What is your gender identity?</label>
  <div class="ashby-application-form-input-radio-group-option">
    <input type="radio" id="opt-man" name="gender-grp">
    <label for="opt-man">Man</label>
  </div>
  <div class="ashby-application-form-input-radio-group-option">
    <input type="radio" id="opt-woman" name="gender-grp">
    <label for="opt-woman">Woman</label>
  </div>
  <div class="ashby-application-form-input-radio-group-option">
    <input type="radio" id="opt-nonbinary" name="gender-grp">
    <label for="opt-nonbinary">Non-Binary</label>
  </div>
</fieldset>
`;

const NEWSLETTER_CHECKBOX_HTML = `
<label for="subscribe">Subscribe to our newsletter?</label>
<input type="checkbox" id="subscribe">
`;

function loadDirectFill() {
  const src = fs.readFileSync(DIRECT_FILL_PATH, 'utf8');
  // eslint-disable-next-line no-eval
  (0, eval)(src);
}

// Attaches a listener that records every 'click' event actually dispatched
// on the element (as opposed to the .checked property just ending up
// correct, which a raw assignment could also produce).
function trackClicks(el) {
  const clicks = [];
  el.addEventListener('click', () => clicks.push(true));
  return clicks;
}

describe('Direct-fill radio groups use a real click, not property assignment', () => {
  beforeEach(() => {
    document.body.innerHTML = GENDER_FIELDSET_HTML;
    delete window.__jobMatchDirectFill;
    delete globalThis.JMFieldFilter;
    loadDirectFill();
  });

  it('selects the matching option via a genuine click', async () => {
    const man = document.getElementById('opt-man');
    const woman = document.getElementById('opt-woman');
    const nonbinary = document.getElementById('opt-nonbinary');
    const manClicks = trackClicks(man);

    const qaList = [{ question: 'What is your gender identity?', answer: 'Man' }];
    const result = await window.__jobMatchDirectFill(qaList, {});

    expect(result.filled).toBe(1);
    expect(man.checked).toBe(true);
    expect(woman.checked).toBe(false);
    expect(nonbinary.checked).toBe(false);
    // The old code (`radio.el.checked = true; fireEvents(radio.el);`) never
    // dispatches a 'click' event — only synthetic input/change/focus/blur.
    expect(manClicks.length).toBe(1);
  });

  it('relies on native radio-group exclusivity to correct an already-wrong selection', async () => {
    // Simulate a stale/incorrect prior selection.
    const nonbinary = document.getElementById('opt-nonbinary');
    nonbinary.checked = true;

    const man = document.getElementById('opt-man');
    const manClicks = trackClicks(man);

    const qaList = [{ question: 'What is your gender identity?', answer: 'Man' }];
    await window.__jobMatchDirectFill(qaList, {});

    // A real click on `man` natively unchecks `nonbinary` as part of the
    // browser's own radio-group activation behavior — no manual bookkeeping
    // needed, and no way for the DOM to end up in an inconsistent state
    // with two "checked" radios in the same group.
    expect(man.checked).toBe(true);
    expect(nonbinary.checked).toBe(false);
    expect(manClicks.length).toBe(1);
  });

  it('does not click again when the correct option is already selected', async () => {
    const man = document.getElementById('opt-man');
    man.checked = true;
    const manClicks = trackClicks(man);

    const qaList = [{ question: 'What is your gender identity?', answer: 'Man' }];
    const result = await window.__jobMatchDirectFill(qaList, {});

    // Still counted as filled/matched...
    expect(result.filled).toBe(1);
    // ...but no click was needed, since clicking an already-checked radio
    // would be a no-op anyway — this just confirms the `!radio.el.checked`
    // guard actually skips the redundant click.
    expect(manClicks.length).toBe(0);
    expect(man.checked).toBe(true);
  });
});

describe('Direct-fill checkboxes use a real click, not property assignment', () => {
  beforeEach(() => {
    document.body.innerHTML = NEWSLETTER_CHECKBOX_HTML;
    delete window.__jobMatchDirectFill;
    delete globalThis.JMFieldFilter;
    loadDirectFill();
  });

  it('checks the box via a genuine click when the answer is affirmative', async () => {
    const cb = document.getElementById('subscribe');
    const clicks = trackClicks(cb);

    const qaList = [{ question: 'Subscribe to our newsletter?', answer: 'Yes' }];
    const result = await window.__jobMatchDirectFill(qaList, {});

    expect(result.filled).toBe(1);
    expect(cb.checked).toBe(true);
    // Same distinction as the radio case: the old
    // `cb.checked = shouldCheck; fireEvents(cb);` never fires a real click.
    expect(clicks.length).toBe(1);
  });

  it('unchecks an already-checked box via a genuine click when the answer is negative', async () => {
    const cb = document.getElementById('subscribe');
    cb.checked = true;
    const clicks = trackClicks(cb);

    const qaList = [{ question: 'Subscribe to our newsletter?', answer: 'No' }];
    const result = await window.__jobMatchDirectFill(qaList, {});

    expect(result.filled).toBe(1);
    expect(cb.checked).toBe(false);
    expect(clicks.length).toBe(1);
  });

  it('does not click again when already in the desired state', async () => {
    const cb = document.getElementById('subscribe');
    cb.checked = false;
    const clicks = trackClicks(cb);

    const qaList = [{ question: 'Subscribe to our newsletter?', answer: 'No' }];
    const result = await window.__jobMatchDirectFill(qaList, {});

    expect(result.filled).toBe(0);
    expect(clicks.length).toBe(0);
    expect(cb.checked).toBe(false);
  });
});
