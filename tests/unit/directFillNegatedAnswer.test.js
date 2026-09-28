// Regression test for a real bug found live on an Ashby-hosted application
// form: "Which of the following communities do you belong to? Please
// select all that apply." has a "Veteran" checkbox option. The user's
// saved "Veteran status" Q&A answer is "I am not a protected veteran" —
// matchQA's short-label containment check treats "Veteran status"
// (the Q&A question) as matching the bare "Veteran" checkbox label (it's
// contained within it), attaching this answer as the checkbox's match.
//
// Root cause: AFFIRMATIVE_ANSWER_RE (`/^(yes|true|1|checked|agree|accept|i
// am|i do|i have)/i`) only anchors on the LEADING phrase — "I am not a
// protected veteran" starts with "I am", so it tested as affirmative
// despite the very next word being "not". The checkbox got checked for a
// community the user explicitly said they do not belong to.
//
// Fixed with a NEGATIVE_ANSWER_RE checked before AFFIRMATIVE_ANSWER_RE in
// both places that used it (the standalone-checkbox handler and the
// Ashby-style Yes/No button-toggle handler) — any answer of the shape
// "I am/do/have/was/would/did/will NOT ..." or a contraction ("I don't",
// "I haven't", ...) is now recognized as negative FIRST, regardless of
// what leading phrase it also happens to share with the affirmative list.
//
// directFill.js has no .mjs mirror or prior unit tests (it's a classic-
// script content script) — this loads its source directly via eval, the
// same pattern as directFillYesNoToggle.test.js.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIRECT_FILL_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'directFill.js');

function loadDirectFill() {
  const src = fs.readFileSync(DIRECT_FILL_PATH, 'utf8');
  // eslint-disable-next-line no-eval
  (0, eval)(src);
}

beforeAll(async () => {
  await import('../../lib/qaMatch.js');
});

describe('Direct-fill checkbox handler correctly reads negated answers (the actual bug)', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <input type="checkbox" id="cb1" name="Veteran">
      <label for="cb1">Veteran</label>
    `;
    delete window.__jobMatchDirectFill;
    delete globalThis.JMFieldFilter;
    loadDirectFill();
  });

  it('does NOT check "Veteran" when the saved answer is "I am not a protected veteran" (the real bug)', async () => {
    const qaList = [{ question: 'Veteran status', answer: 'I am not a protected veteran' }];
    await window.__jobMatchDirectFill(qaList, {});
    expect(document.getElementById('cb1').checked).toBe(false);
  });

  it('still checks a genuinely affirmative "I am ..." answer (no regression)', async () => {
    const qaList = [{ question: 'Veteran status', answer: 'I am a disabled veteran' }];
    await window.__jobMatchDirectFill(qaList, {});
    expect(document.getElementById('cb1').checked).toBe(true);
  });

  it('recognizes other negated phrasings too ("I do not", "I have not", "I don\'t", "I haven\'t")', async () => {
    for (const answer of ['I do not have a disability', 'I have not served', "I don't identify that way", "I haven't done that"]) {
      document.body.innerHTML = `<input type="checkbox" id="cb1" name="Veteran"><label for="cb1">Veteran</label>`;
      delete window.__jobMatchDirectFill;
      delete globalThis.JMFieldFilter;
      loadDirectFill();
      await window.__jobMatchDirectFill([{ question: 'Veteran status', answer }], {});
      expect(document.getElementById('cb1').checked).toBe(false);
    }
  });

  it('still recognizes plain "No" as negative and "Yes" as affirmative (no regression)', async () => {
    await window.__jobMatchDirectFill([{ question: 'Veteran status', answer: 'No' }], {});
    expect(document.getElementById('cb1').checked).toBe(false);

    document.body.innerHTML = `<input type="checkbox" id="cb1" name="Veteran"><label for="cb1">Veteran</label>`;
    delete window.__jobMatchDirectFill;
    delete globalThis.JMFieldFilter;
    loadDirectFill();
    await window.__jobMatchDirectFill([{ question: 'Veteran status', answer: 'Yes' }], {});
    expect(document.getElementById('cb1').checked).toBe(true);
  });
});

describe('Direct-fill Yes/No button-toggle handler correctly reads negated answers (same fix, other call site)', () => {
  const ASHBY_TOGGLE_HTML = `
    <div class="_fieldEntry_1e3gg_28" data-field-path="q1">
      <label for="q1">Are you a veteran?</label>
      <div class="_container_1svni_28">
        <button aria-pressed="false" data-option="yes">Yes</button>
        <button aria-pressed="false" data-option="no">No</button>
        <input type="checkbox" tabindex="-1" name="q1">
      </div>
    </div>
  `;

  beforeEach(() => {
    document.body.innerHTML = ASHBY_TOGGLE_HTML;
    delete window.__jobMatchDirectFill;
    delete globalThis.JMFieldFilter;
    loadDirectFill();
  });

  it('clicks No (not Yes) when the saved answer is negated', async () => {
    const qaList = [{ question: 'Are you a veteran?', answer: 'I am not a protected veteran' }];
    await window.__jobMatchDirectFill(qaList, {});

    expect(document.querySelector('button[data-option="no"]').getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('button[data-option="yes"]').getAttribute('aria-pressed')).toBe('false');
    // Neither button's own click handler ran (no real page JS here to flip
    // aria-pressed), but clickNatively must have targeted the No button —
    // verified by intercepting the click event itself.
  });

  it('targets the No button specifically for a negated answer (verified via click interception)', async () => {
    let clickedOption = null;
    document.querySelector('button[data-option="yes"]').addEventListener('click', () => { clickedOption = 'yes'; });
    document.querySelector('button[data-option="no"]').addEventListener('click', () => { clickedOption = 'no'; });

    await window.__jobMatchDirectFill([{ question: 'Are you a veteran?', answer: 'I am not a protected veteran' }], {});

    expect(clickedOption).toBe('no');
  });
});
