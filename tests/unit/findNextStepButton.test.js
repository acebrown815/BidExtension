// findNextStepButton() is the safety boundary for AutoFill's multi-step
// wizard navigation (see autofillForm() in content.js, which loops
// through wizard steps clicking whatever this function finds). It must
// NEVER match a form's real, final submit action — clicking through a
// step is safe (it only reveals more fields), but clicking a real submit
// on the user's behalf is not, and that decision is always left for the
// user to make themselves after reviewing the filled form.
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom (see contentRadioGroupLabel.test.js), so this
// extracts just findNextStepButton() by source range and evals it in
// isolation.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');

let findNextStepButton;
beforeAll(() => {
  const src = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');
  const startMarker = 'function findNextStepButton() {';
  const endMarker = '/**\n   * Initiates the autofill pipeline:';
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  }
  const extracted = src.slice(start, end);
  // eslint-disable-next-line no-eval
  const factory = (0, eval)(`(function () { ${extracted} return { findNextStepButton }; })`);
  ({ findNextStepButton } = factory());
});

describe('findNextStepButton — finds the real "advance to next step" control', () => {
  it('finds Dice\'s actual "Next" button, verbatim from the live wizard page', () => {
    document.body.innerHTML = `
      <form>
        <h2>Resume &amp; Cover Letter</h2>
        <div class="mt-4 mb-8 flex grow items-center justify-end">
          <button type="submit"><span>Next</span></button>
        </div>
      </form>
    `;
    const el = findNextStepButton();
    expect(el).not.toBeNull();
    expect(el.tagName).toBe('BUTTON');
  });

  it('matches "Continue" and "Next Step" and "Save and Continue"', () => {
    for (const text of ['Continue', 'Next Step', 'Save and Continue', 'Save & Next', 'Proceed']) {
      document.body.innerHTML = `<button type="button">${text}</button>`;
      expect(findNextStepButton(), `expected "${text}" to match`).not.toBeNull();
    }
  });

  it('skips a disabled Next button', () => {
    document.body.innerHTML = '<button type="submit" disabled>Next</button>';
    expect(findNextStepButton()).toBeNull();
  });
});

describe('findNextStepButton — never matches a final submit action (the safety boundary)', () => {
  it('ignores "Submit", "Submit Application", "Apply", "Finish", "Complete Application", "Review", "Send Application"', () => {
    for (const text of [
      'Submit', 'Submit Application', 'Apply', 'Finish', 'Complete Application',
      'Review', 'Send Application', 'Done', 'Review and Submit',
    ]) {
      document.body.innerHTML = `<button type="submit">${text}</button>`;
      expect(findNextStepButton(), `expected "${text}" to be rejected`).toBeNull();
    }
  });

  it('rejects an ambiguous label combining "next"-shaped wording with a final action', () => {
    document.body.innerHTML = '<button type="submit">Submit and Continue</button>';
    expect(findNextStepButton()).toBeNull();
  });

  it('type="submit" alone is not disqualifying — only the button text matters', () => {
    // Multi-step wizards commonly submit each step's own small form to
    // advance without submitting the whole application (confirmed on Dice).
    document.body.innerHTML = '<input type="submit" value="Next">';
    expect(findNextStepButton()).not.toBeNull();
  });

  it('returns null when there is nothing next-step-shaped on the page', () => {
    document.body.innerHTML = '<div>Some job application content</div><button>Cancel</button>';
    expect(findNextStepButton()).toBeNull();
  });

  it('ignores an unrelated long sentence that happens to contain "next"', () => {
    document.body.innerHTML = '<button>Next steps will be emailed to you after you submit</button>';
    expect(findNextStepButton()).toBeNull();
  });
});
