// content.js is a large content script that isn't practical to load
// wholesale under happy-dom (see contentRadioGroupLabel.test.js), so this
// extracts waitForVisibleOptions()/findVisibleOptions()/collectOptions()
// by source range and evals them in isolation.
//
// Root cause this covers: fillCustomDropdown() used to open a custom
// dropdown, sleep a single FIXED 600ms, then check once for rendered
// options — giving up (leaving the field unfilled) if that guess was too
// short. Some ATS custom dropdowns (React-based comboboxes) fetch or
// render their option list asynchronously after being opened and can take
// well over 600ms, so a real form could have some fields silently skipped
// depending only on how fast that particular dropdown happened to be.
// waitForVisibleOptions() polls instead of guessing a single wait.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');

// happy-dom's getBoundingClientRect() always returns a zero-size rect (it
// doesn't run real layout), but collectOptions() in content.js treats a
// zero-size rect as "hidden" and filters the element out. Stub a non-zero
// rect for every element so option elements in these tests read as visible,
// matching how they'd actually render in a browser.
beforeEach(() => {
  Element.prototype.getBoundingClientRect = () => ({
    width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON() {},
  });
});

let waitForVisibleOptions;
let findVisibleOptions;
beforeAll(() => {
  const src = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');
  const startMarker = 'async function waitForVisibleOptions(triggerEl';
  const endMarker = '/**\n   * Dispatches a realistic pointerdown';
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  }
  const extracted = src.slice(start, end);
  // sleep() is defined later in content.js — inlined here rather than
  // extracting from far away in the file, since it's a one-liner.
  const sleepDef = 'function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }';
  // eslint-disable-next-line no-eval
  const factory = (0, eval)(`(function () { ${sleepDef}\n${extracted} return { waitForVisibleOptions, findVisibleOptions }; })`);
  ({ waitForVisibleOptions, findVisibleOptions } = factory());
});

function makeListboxTrigger() {
  document.body.innerHTML = `
    <input id="trigger" aria-controls="my-listbox">
    <div id="my-listbox" role="listbox"></div>
  `;
  return document.getElementById('trigger');
}

describe('waitForVisibleOptions', () => {
  it('resolves immediately when options are already present', async () => {
    const trigger = makeListboxTrigger();
    const listbox = document.getElementById('my-listbox');
    listbox.innerHTML = '<div role="option">Texas</div><div role="option">California</div>';

    const start = Date.now();
    const options = await waitForVisibleOptions(trigger, 5000, 50);
    expect(options.map(o => o.text)).toEqual(['Texas', 'California']);
    expect(Date.now() - start).toBeLessThan(200); // no unnecessary waiting
  });

  it('picks up options that render asynchronously after the dropdown opens (the real bug)', async () => {
    const trigger = makeListboxTrigger();
    const listbox = document.getElementById('my-listbox');
    // Simulates a dropdown that fetches/renders its options ~150ms after
    // opening — well past the OLD fixed-600ms-then-give-up window would
    // have still caught this, but this test proves the POLL mechanism
    // itself works for content that appears after any given single check.
    setTimeout(() => {
      listbox.innerHTML = '<div role="option">Remote</div>';
    }, 150);

    const options = await waitForVisibleOptions(trigger, 2000, 50);
    expect(options.map(o => o.text)).toEqual(['Remote']);
  });

  it('gives up and returns an empty array after maxWaitMs if nothing ever appears', async () => {
    const trigger = makeListboxTrigger(); // listbox stays empty forever
    const start = Date.now();
    const options = await waitForVisibleOptions(trigger, 300, 50);
    expect(options).toEqual([]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(300);
  });
});

describe('findVisibleOptions — react-select-style markup (Greenhouse job-boards.greenhouse.io)', () => {
  // Regression test for a real bug: Greenhouse's react-select-based EEO
  // fields (Gender, Hispanic/Latino, Job Applicant Data Privacy Notice,
  // etc.) name the trigger <input> itself with a class containing "select"
  // (e.g. class="select__input"). findVisibleOptions()'s old container
  // lookup did `triggerEl.closest('[class*="select"], ...')`, which matches
  // an element against itself before walking up — so it always resolved to
  // the <input> itself. An <input> can't have child elements, so searching
  // for options "inside" it silently always found nothing, and every such
  // dropdown fell through to Strategy 3, which (before this fix) had no
  // generic "[class*='option']" selector either — so these fields could
  // never be filled.
  function makeGreenhouseStyleDropdown() {
    // Mirrors real markup: a wrapper carrying the emotion-generated
    // "-control"/"-container" classes, with the combobox <input> itself
    // named "select__input" (matches the old buggy selector on itself).
    document.body.innerHTML = `
      <div class="select__container">
        <div class="select__control remix-css-13cymwt-control">
          <input id="gender" class="select__input" role="combobox" aria-expanded="true">
        </div>
        <div class="select__menu">
          <div class="select__option remix-css-1n7v3ny-option">Male</div>
          <div class="select__option remix-css-1n7v3ny-option">Female</div>
          <div class="select__option remix-css-1n7v3ny-option">Decline to self-identify</div>
        </div>
      </div>
    `;
    return document.getElementById('gender');
  }

  it('finds options via the nearby container even when the trigger input\'s own class contains "select"', () => {
    const trigger = makeGreenhouseStyleDropdown();
    const options = findVisibleOptions(trigger);
    expect(options.map(o => o.text)).toEqual(['Male', 'Female', 'Decline to self-identify']);
  });

  it('falls back to a document-wide option-class search when the menu is portaled outside the trigger\'s container', () => {
    document.body.innerHTML = `
      <div class="select__container">
        <div class="select__control remix-css-13cymwt-control">
          <input id="race" class="select__input" role="combobox" aria-expanded="true">
        </div>
      </div>
      <div class="select__menu-portal">
        <div class="select__option remix-css-1n7v3ny-option">Hispanic or Latino</div>
        <div class="select__option remix-css-1n7v3ny-option">Not Hispanic or Latino</div>
      </div>
    `;
    const trigger = document.getElementById('race');
    const options = findVisibleOptions(trigger);
    expect(options.map(o => o.text)).toEqual(['Hispanic or Latino', 'Not Hispanic or Latino']);
  });
});
