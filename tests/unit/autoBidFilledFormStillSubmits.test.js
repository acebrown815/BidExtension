// Live on Greenhouse (job-boards.greenhouse.io/robotsandpencils/jobs/5447044008):
// description and application form on one page, an "Apply" button at the top
// that only scrolls down. Once every field already held an answer (after
// "Resume Auto Mode", or a second Auto-Bid pass), detectFormFields() — which
// skips answered fields — reported nothing to fill, so the flow took the
// "no form here, click Apply" branch and "Submit application" was never
// reached.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let FN_SRC;
beforeAll(() => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('  async function autoClickApplyThenAutofillIfNeeded() {');
  const end = src.indexOf('\n  /**', start);
  if (start === -1 || end === -1) throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  FN_SRC = src.slice(start, end);
});

function run({ fieldsToFill, submitVisible }) {
  const calls = [];
  const fn = new Function('calls', 'fieldsToFill', 'submitVisible', ` // eslint-disable-line no-new-func
    let _autoBidAutofillRun = false;
    const _activeResumeId = 'r1';
    const WORKDAY_DIALOG_WAIT_MS = 0;
    const isWorkdayHost = () => false;
    async function lockAutoBidResumeSelection() {}
    async function clickWorkdayAutofillWithResumeIfPresent() { return false; }
    function detectFormFields() { return fieldsToFill; }
    function findFinalSubmitButton() { return submitVisible ? document.querySelector('.application--submit button') : null; }
    async function autofillForm() { calls.push('autofillForm'); }
    function findApplyButton() { return document.getElementById('apply-top'); }
    function findDropdownApplyMenuItem() { return null; }
    async function autoBidClick(el) { calls.push('click:' + el.id); }
    async function waitForDomSettled() {}
    ${FN_SRC}
    return autoClickApplyThenAutofillIfNeeded;
  `)(calls, fieldsToFill, submitVisible);
  return { fn, calls };
}

describe('autoClickApplyThenAutofillIfNeeded — a fully filled one-page form still reaches Submit', () => {
  it('runs the fill/submit step (not the Apply click) when "Submit application" is on the page, even with nothing left to fill', async () => {
    document.body.innerHTML = `
      <a id="apply-top" href="#application-form">Apply</a>
      <form id="application-form"><input id="first_name" value="Randolph">
        <div class="application--submit"><button type="submit" class="btn btn--rounded" aria-disabled="false">Submit application</button></div>
      </form>`;
    const { fn, calls } = run({ fieldsToFill: [], submitVisible: true });
    await fn();
    expect(calls).toEqual(['autofillForm']);
  });

  it('still clicks Apply on a posting page with no form and no submit button', async () => {
    document.body.innerHTML = '<a id="apply-top" href="/apply">Apply</a>';
    const { fn, calls } = run({ fieldsToFill: [], submitVisible: false });
    await fn();
    expect(calls).toEqual(['click:apply-top']);
  });
});
