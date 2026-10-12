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
import '../../lib/fieldErrorFix.js';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');

let hasVisibleValidationErrors;
beforeAll(() => {
  const src = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');
  const startMarker = 'function hasVisibleValidationErrors(';
  const endMarker = '/**\n   * Initiates the autofill pipeline:';
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  }
  const extracted = src.slice(start, end);
  // eslint-disable-next-line no-eval
  const factory = (0, eval)(`(function () { const { fieldErrorMessage } = globalThis.JMFieldErrorFix; ${extracted} return { hasVisibleValidationErrors }; })`);
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

  it("detects Paylocity's .form-group.form-error footnote (no aria-invalid, no alert)", () => {
    document.body.innerHTML = `
      <div class="form-group form-required form-error"><label>LinkedIn Profile URL<span><em> (required)</em></span></label><input data-automation-id="infoLinkedIn" id="info.linkedIn" type="text" value="linkedin.com/in/randolph-brown-34286528b"><div class="type-footnote show">Must be a valid LinkedIn URL. Example: https://www.linkedin.com/in/yourname</div></div>`;
    expect(hasVisibleValidationErrors()).toBe(true);
    document.querySelector('.form-group').classList.remove('form-error');
    expect(hasVisibleValidationErrors()).toBe(false);
  });

  it("fieldMessages modes: Paylocity's acknowledgement flagged on a ticked box", () => {
    document.body.innerHTML = `
      <div class="form-group form-required form-error"><input id="applyAcknowledgement" type="checkbox" checked=""><label for="applyAcknowledgement">I have read and accept the above acknowledgement</label><span><div class="type-footnote">Please accept the acknowledgement</div></span></div>`;
    expect(hasVisibleValidationErrors()).toBe(true);
    expect(hasVisibleValidationErrors({ fieldMessages: 'unanswered' })).toBe(false);
    expect(hasVisibleValidationErrors({ fieldMessages: 'none' })).toBe(false);
    document.getElementById('applyAcknowledgement').checked = false;
    expect(hasVisibleValidationErrors({ fieldMessages: 'unanswered' })).toBe(true);
  });

  it("fieldMessages 'none' still sees aria-invalid / alerts", () => {
    document.body.innerHTML = '<input aria-invalid="true">';
    expect(hasVisibleValidationErrors({ fieldMessages: 'none' })).toBe(true);
  });

  it('detects aria-invalid alone', () => {
    document.body.innerHTML = '<input aria-invalid="true">';
    expect(hasVisibleValidationErrors()).toBe(true);
  });

  it('detects role="alert" alone', () => {
    document.body.innerHTML = '<div role="alert">Something went wrong</div>';
    expect(hasVisibleValidationErrors()).toBe(true);
  });

  it('ignores an EMPTY role="alert" live region (Greenhouse keeps these on the page)', () => {
    // Live: Greenhouse's "Submit application" was never auto-clicked — an
    // empty screen-reader alert region counted as "the form shows an error".
    document.body.innerHTML = `
      <form id="application-form" class="application--form">
        <input id="first_name" aria-invalid="false" aria-required="true" value="Randolph">
        <div role="alert" aria-live="assertive"></div>
        <div class="application--submit"><button type="submit">Submit application</button></div>
      </form>`;
    expect(hasVisibleValidationErrors()).toBe(false);
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

  // happy-dom doesn't implement real layout, so offsetParent is always
  // `undefined` (never a real `null`/element) regardless of `display` —
  // these two mock it directly via Object.defineProperty to model the
  // hidden-vs-visible transition a browser would compute for real. See
  // jobviteResumeAttachTrigger.test.js for the same pattern.
  it('ignores an always-in-DOM but currently-hidden alert banner (the real Jobvite bug: ng-show/ng-hide only toggles a CSS class, never removes the element)', () => {
    document.body.innerHTML = `
      <div class="jv-apply-error ng-hide">
        <p role="alert"><strong>The above information is required.</strong></p>
      </div>
    `;
    const alertEl = document.querySelector('[role="alert"]');
    Object.defineProperty(alertEl, 'offsetParent', { configurable: true, get: () => null });
    expect(hasVisibleValidationErrors()).toBe(false);
  });

  it('detects that same banner once it genuinely becomes visible', () => {
    document.body.innerHTML = `
      <div class="jv-apply-error">
        <p role="alert"><strong>The above information is required.</strong></p>
      </div>
    `;
    const alertEl = document.querySelector('[role="alert"]');
    Object.defineProperty(alertEl, 'offsetParent', { configurable: true, get: () => document.body });
    expect(hasVisibleValidationErrors()).toBe(true);
  });
});
