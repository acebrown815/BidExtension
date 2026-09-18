// content.js is a large content script that isn't practical to load
// wholesale under happy-dom (see contentRadioGroupLabel.test.js), so this
// extracts just findApplyButton() by source range and evals it in
// isolation.
//
// findApplyButton() is used only by Auto-Bid's automated flow (see
// autoClickApplyThenAutofillIfNeeded in content.js): when a job posting's
// page has a strong match but no application form yet — e.g. CATS
// (catsone.com) postings, whose real form lives on a SEPARATE page reached
// only by clicking "Apply Now" — the extension needs to find that link
// reliably, without misfiring on unrelated page text that merely mentions
// "apply" (e.g. "Terms apply", a coupon-code "Apply" button, "Applying
// for a mortgage?").
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');

let findApplyButton;
beforeAll(() => {
  const src = fs.readFileSync(CONTENT_JS_PATH, 'utf8');
  const startMarker = 'function findApplyButton() {';
  const endMarker = '/**\n   * Initiates the autofill pipeline:';
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  }
  const extracted = src.slice(start, end);
  // eslint-disable-next-line no-eval
  const factory = (0, eval)(`(function () { ${extracted} return { findApplyButton }; })`);
  ({ findApplyButton } = factory());
});

describe('findApplyButton — finds the real CTA', () => {
  it('finds the real CATS "Apply Now" link, verbatim from the live page', () => {
    document.body.innerHTML = `
      <div class="job-header">
        <h1>C#.NET Developer</h1>
        <a class="btn" href="/careers/7276/jobs/15742823-CNET-Developer/apply" data-discover="true">Apply Now</a>
      </div>
    `;
    const el = findApplyButton();
    expect(el).not.toBeNull();
    expect(el.tagName).toBe('A');
    expect(el.getAttribute('href')).toBe('/careers/7276/jobs/15742823-CNET-Developer/apply');
  });

  it('matches a bare "Apply" button', () => {
    document.body.innerHTML = '<button type="button">Apply</button>';
    expect(findApplyButton()).not.toBeNull();
  });

  it('matches "Apply for this job/position/role"', () => {
    document.body.innerHTML = '<a href="/apply">Apply for this position</a>';
    expect(findApplyButton()).not.toBeNull();
  });
});

describe('findApplyButton — avoids false positives', () => {
  it('ignores unrelated text that merely mentions "apply"', () => {
    document.body.innerHTML = `
      <p>Terms apply.</p>
      <button>Apply coupon</button>
      <a href="/mortgage">Applying for a mortgage?</a>
    `;
    expect(findApplyButton()).toBeNull();
  });

  it('ignores a long sentence containing the word "apply"', () => {
    document.body.innerHTML = '<button>Apply now and one of our recruiters will reach out within 48 hours</button>';
    expect(findApplyButton()).toBeNull();
  });

  it('returns null when there is nothing apply-shaped on the page', () => {
    document.body.innerHTML = '<div>Senior Backend Engineer</div><p>Remote, full-time.</p>';
    expect(findApplyButton()).toBeNull();
  });
});
