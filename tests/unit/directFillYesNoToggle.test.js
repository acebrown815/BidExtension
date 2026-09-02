// directFill.js has no .mjs mirror or prior unit tests (it's a
// classic-script content script, not imported as a module) — this loads
// its source directly via eval, the same way content.js relies on the
// IIFE hanging its API on globalThis. Covers the Ashby-style Yes/No
// button-toggle handler (section 5): the widget's real interactive
// elements are two <button>s, with a hidden, tabindex="-1" checkbox that
// only mirrors state and never drives it — the bug this handler exists
// to work around.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIRECT_FILL_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'directFill.js');

const ASHBY_HTML = `
<div class="_fieldEntry_1e3gg_28 ashby-application-form-field-entry" data-field-path="2424217b-c007-4295-9650-390f68ca2d34" data-field-entry-id="99d44f78-2fc3-4607-b1d4-256fc5d95ff0_2424217b-c007-4295-9650-390f68ca2d34">
  <label class="_heading_f7cvd_52 _required_f7cvd_91 _label_1e3gg_42 ashby-application-form-question-title" for="2424217b-c007-4295-9650-390f68ca2d34">Are you a U.S. Citizen or Green Card holder?</label>
  <div class="_container_1svni_28 _yesno_1e3gg_148  ashby-application-form-input-yesno">
    <button class="_container_pjyt6_1 _option_1svni_32  ashby-application-form-input-yesno-option" aria-pressed="false" data-option="yes">Yes</button>
    <button class="_container_pjyt6_1 _option_1svni_32  ashby-application-form-input-yesno-option" aria-pressed="false" data-option="no">No</button>
    <input type="checkbox" class="_input_1svni_78" tabindex="-1" name="2424217b-c007-4295-9650-390f68ca2d34">
  </div>
</div>
`;

function loadDirectFill() {
  const src = fs.readFileSync(DIRECT_FILL_PATH, 'utf8');
  // eslint-disable-next-line no-eval
  (0, eval)(src);
}

describe('Ashby-style Yes/No toggle direct-fill', () => {
  beforeEach(() => {
    document.body.innerHTML = ASHBY_HTML;
    delete window.__jobMatchDirectFill;
    delete globalThis.JMFieldFilter;
    loadDirectFill();

    // Simulate the page's OWN click handler (real Ashby JS, not ours) —
    // happy-dom's native <button>.click() doesn't toggle aria-pressed on
    // its own the way a real click handler would, so this stand-in is
    // what actually proves our code fired a real click the page would react to.
    const yesBtn = document.querySelector('button[data-option="yes"]');
    const noBtn = document.querySelector('button[data-option="no"]');
    const checkbox = document.querySelector('input[type="checkbox"]');
    yesBtn.addEventListener('click', () => {
      yesBtn.setAttribute('aria-pressed', 'true');
      noBtn.setAttribute('aria-pressed', 'false');
      checkbox.checked = true;
    });
    noBtn.addEventListener('click', () => {
      noBtn.setAttribute('aria-pressed', 'true');
      yesBtn.setAttribute('aria-pressed', 'false');
      checkbox.checked = false;
    });
  });

  it('clicks the Yes button when the Q&A answer is Yes, counted exactly once', async () => {
    const qaList = [{ question: 'Are you a U.S. Citizen or Green Card holder?', answer: 'Yes' }];
    const result = await window.__jobMatchDirectFill(qaList, {});

    const yesBtn = document.querySelector('button[data-option="yes"]');
    const noBtn = document.querySelector('button[data-option="no"]');

    // Exactly 1, not 2 — proves the checkbox handler (section 4) backed off
    // and left this field to the toggle handler (section 5) instead of both
    // independently "filling" the same question.
    expect(result.filled).toBe(1);
    expect(yesBtn.getAttribute('aria-pressed')).toBe('true');
    expect(noBtn.getAttribute('aria-pressed')).toBe('false');
  });

  it('clicks the No button when the Q&A answer is No', async () => {
    const qaList = [{ question: 'Are you a U.S. Citizen or Green Card holder?', answer: 'No' }];
    await window.__jobMatchDirectFill(qaList, {});

    expect(document.querySelector('button[data-option="yes"]').getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('button[data-option="no"]').getAttribute('aria-pressed')).toBe('true');
  });

  it('does not override an already-answered toggle', async () => {
    document.querySelector('button[data-option="no"]').setAttribute('aria-pressed', 'true');
    const qaList = [{ question: 'Are you a U.S. Citizen or Green Card holder?', answer: 'Yes' }];
    const result = await window.__jobMatchDirectFill(qaList, {});

    expect(result.filled).toBe(0);
    expect(document.querySelector('button[data-option="no"]').getAttribute('aria-pressed')).toBe('true');
  });

  it('skips silently when there is no matching Q&A entry', async () => {
    const result = await window.__jobMatchDirectFill([{ question: 'Unrelated question', answer: 'Yes' }], {});
    expect(result.filled).toBe(0);
    expect(document.querySelector('button[data-option="yes"]').getAttribute('aria-pressed')).toBe('false');
  });
});
