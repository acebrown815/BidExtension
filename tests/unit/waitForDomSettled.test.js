// Regression test for a real Auto-Bid bug: after clicking an "Apply Now" /
// "Easy Apply" link that does a CLIENT-SIDE (SPA) route change rather than
// a real navigation (confirmed on Dice, https://www.dice.com/job-detail/...
// -> .../job-applications/.../wizard via history.pushState),
// checkPendingAutoBidAutofill() used to call waitForFormFieldsReady(),
// whose check is just "is there ANY form/input/select/textarea on the
// page anywhere". That was already true the instant the click fired —
// from page chrome that predates the route change (e.g. a persistent nav
// search box) — so it returned near-instantly, long before the new
// route's own content (Dice's Resume/Cover-letter file inputs) had
// actually rendered. autofillForm() then ran against a form that wasn't
// there yet and found nothing to attach.
//
// waitForDomSettled() waits for DOM mutations to quiet down instead of
// checking for a specific selector, so it isn't fooled by content that
// was already on the page before the route swap.
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom (see contentRadioGroupLabel.test.js), so this
// extracts just waitForDomSettled() by source range and evals it in
// isolation.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');

let waitForDomSettled;
beforeAll(() => {
  const src = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');
  const startMarker = 'function waitForDomSettled(maxWaitMs';
  const endMarker = "\n\n  /** @returns {string} The job title extracted from the page, or ''. */";
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  }
  const extracted = src.slice(start, end);
  // eslint-disable-next-line no-eval
  const factory = (0, eval)(`(function () { ${extracted} return { waitForDomSettled }; })`);
  ({ waitForDomSettled } = factory());
});

describe('waitForDomSettled', () => {
  it('resolves quickly when nothing mutates at all', async () => {
    document.body.innerHTML = '<div>static content</div>';
    const start = Date.now();
    await waitForDomSettled(2000, 100);
    expect(Date.now() - start).toBeLessThan(1000); // resolves off the quietMs timer, not the full maxWaitMs
  });

  it('waits out a burst of mutations before resolving (the real bug: an SPA route swap still in progress)', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.getElementById('root');
    let mutationCount = 0;
    // Simulate a route swap that keeps appending content for ~300ms —
    // e.g. React progressively rendering the new page's form.
    const interval = setInterval(() => {
      mutationCount++;
      const el = document.createElement('div');
      el.textContent = `chunk ${mutationCount}`;
      root.appendChild(el);
      if (mutationCount >= 5) clearInterval(interval);
    }, 60);

    const start = Date.now();
    await waitForDomSettled(3000, 150);
    const elapsed = Date.now() - start;

    // Must have waited at least through the mutation burst (5 * 60ms) plus
    // the quiet window — proves it didn't resolve on the FIRST mutation.
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(root.children.length).toBe(5); // all mutations happened before we resolved
    clearInterval(interval);
  });

  it('gives up at maxWaitMs if mutations never stop', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.getElementById('root');
    const interval = setInterval(() => {
      const el = document.createElement('div');
      root.appendChild(el);
    }, 20);

    const start = Date.now();
    await waitForDomSettled(300, 150);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(600); // didn't hang forever waiting for quiet that never comes
    clearInterval(interval);
  });
});
