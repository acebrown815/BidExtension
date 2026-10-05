// Workday's "Start Your Application" dialog (confirmed on
// bcbsla.wd1.myworkdayjobs.com/.../Senior-Software-Engineer--Remote---Louisiana-_R11452)
// only renders a moment AFTER the Apply click, and the Apply click doesn't
// always change the URL — so the single, instant check that only ran from
// the URL-change hook never saw it, and Auto-Bid stalled on the open dialog
// without clicking "Autofill with Resume".
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');

let SECTION;

beforeAll(() => {
  const src = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('  function findWorkdayAutofillWithResumeLink() {');
  const endMarker = '  const WORKDAY_DIALOG_WAIT_MS = 10000;';
  const end = src.indexOf(endMarker, start);
  if (start === -1 || end === -1) throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  SECTION = src.slice(start, end + endMarker.length);
});

const DIALOG_HTML = `
  <div class="workday-popup wd-popup" data-automation-id="wd-popup-frame" role="dialog" aria-label="Start Your Application">
    <h2>Start Your Application</h2>
    <a href="https://bcbsla.wd1.myworkdayjobs.com/en-US/external/job/Remote-LA/Senior-Software-Engineer--Remote---Louisiana-_R11452/apply/autofillWithResume" role="button" data-automation-id="autofillWithResume">Autofill with Resume</a>
    <a href="https://bcbsla.wd1.myworkdayjobs.com/en-US/external/job/Remote-LA/Senior-Software-Engineer--Remote---Louisiana-_R11452/apply/applyManually" role="button" data-automation-id="applyManually">Apply Manually</a>
  </div>
`;

function load() {
  const clicks = [];
  const factory = new Function('clicks', ` // eslint-disable-line no-new-func
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    async function autoBidClick(el) { clicks.push(el.getAttribute('data-automation-id')); }
    ${SECTION}
    return { clickWorkdayAutofillWithResumeIfPresent };
  `);
  return { ...factory(clicks), clicks };
}

beforeEach(() => {
  document.body.innerHTML = '<div data-automation-id="jobPostingPage"><a data-automation-id="adventureButton" role="button">Apply</a></div>';
});

describe('clickWorkdayAutofillWithResumeIfPresent', () => {
  it('waits for the dialog that appears after the Apply click and clicks "Autofill with Resume"', async () => {
    const { clickWorkdayAutofillWithResumeIfPresent, clicks } = load();
    setTimeout(() => document.body.insertAdjacentHTML('beforeend', DIALOG_HTML), 700);

    expect(await clickWorkdayAutofillWithResumeIfPresent(3000)).toBe(true);
    expect(clicks).toEqual(['autofillWithResume']);
  });

  it('clicks it only once when both callers are waiting for the same dialog', async () => {
    const { clickWorkdayAutofillWithResumeIfPresent, clicks } = load();
    setTimeout(() => document.body.insertAdjacentHTML('beforeend', DIALOG_HTML), 500);

    const results = await Promise.all([
      clickWorkdayAutofillWithResumeIfPresent(3000),
      clickWorkdayAutofillWithResumeIfPresent(3000),
    ]);
    expect(results).toEqual([true, true]);
    expect(clicks).toEqual(['autofillWithResume']);
  });

  it('stops waiting as soon as the page is an apply-flow step (no dialog is coming)', async () => {
    const { clickWorkdayAutofillWithResumeIfPresent, clicks } = load();
    document.body.innerHTML = '<main><div data-automation-id="applyFlowPage"><div data-automation-id="signInContent"></div></div></main>';

    const startedAt = Date.now();
    expect(await clickWorkdayAutofillWithResumeIfPresent(5000)).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(clicks).toEqual([]);
  });

  it('without a wait, still only checks once (non-Workday behavior unchanged)', async () => {
    const { clickWorkdayAutofillWithResumeIfPresent, clicks } = load();
    expect(await clickWorkdayAutofillWithResumeIfPresent()).toBe(false);
    expect(clicks).toEqual([]);
  });
});
