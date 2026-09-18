// hasVisibleValidationErrors() is the safety check that stops AutoFill's
// multi-step wizard-navigation loop (see autofillForm() in content.js)
// from clicking "Next" over and over into the same validation failure —
// confirmed live on Dice's wizard: a required Google-Places-backed
// "current city of residence" autocomplete field AutoFill couldn't
// actually satisfy meant every "Next" click just re-rendered the same
// step with the same "Location is required" error, and the loop had no
// way to tell the difference from genuine progress.
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom (see contentRadioGroupLabel.test.js), so this
// extracts just hasVisibleValidationErrors() by source range and evals it
// in isolation.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');

let hasVisibleValidationErrors;
beforeAll(() => {
  const src = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');
  const startMarker = 'function hasVisibleValidationErrors() {';
  const endMarker = '/**\n   * Initiates the autofill pipeline:';
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  }
  const extracted = src.slice(start, end);
  // eslint-disable-next-line no-eval
  const factory = (0, eval)(`(function () { ${extracted} return { hasVisibleValidationErrors }; })`);
  ({ hasVisibleValidationErrors } = factory());
});

describe('hasVisibleValidationErrors', () => {
  it('detects Dice\'s actual "Location is required" markup (aria-invalid + role=alert)', () => {
    document.body.innerHTML = `
      <div role="alert" aria-live="assertive">Please correct the following errors: Location is required</div>
      <input aria-invalid="true" data-invalid="true" name="candidateLocation">
    `;
    expect(hasVisibleValidationErrors()).toBe(true);
  });

  it('detects aria-invalid alone', () => {
    document.body.innerHTML = '<input aria-invalid="true">';
    expect(hasVisibleValidationErrors()).toBe(true);
  });

  it('detects role="alert" alone', () => {
    document.body.innerHTML = '<div role="alert">Something went wrong</div>';
    expect(hasVisibleValidationErrors()).toBe(true);
  });

  it('returns false on a clean step with no errors', () => {
    document.body.innerHTML = `
      <form>
        <label>Full Name</label>
        <input name="fullName" value="Jane Doe">
      </form>
    `;
    expect(hasVisibleValidationErrors()).toBe(false);
  });

  it('does not false-positive on aria-invalid="false"', () => {
    document.body.innerHTML = '<input aria-invalid="false">';
    expect(hasVisibleValidationErrors()).toBe(false);
  });
});
