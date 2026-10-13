// careers.gofasti.com (Greenhouse job 6181215004):
//   - "Are you currently based in a Latin American country?" — two radios
//     with NO name attribute, so no pass ever saw the question;
//   - "Please, enter a valid phone number" — a red <p> under the input, no
//     error class or ARIA; the page doesn't say which format it wants.
// coinbase.com/careers: "Apply now" is a target="_blank" link, which
// Auto-Bid used to leave alone.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

beforeAll(async () => {
  await import('../../lib/qaMatch.js');
  await import('../../lib/radioGroupLabel.js');
  await import('../../lib/fieldErrorFix.js');
  await import('../../lib/fieldFilter.js');
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(ROOT, 'directFill.js'), 'utf8'));
});

const LATAM = `
  <form>
    <div class="flex flex-col col-span-2 gap-2"><p class="text-sm text-[#383838]/80">Are you currently based in a Latin American country?</p><div class="flex items-center gap-2"><input type="radio" id="yes" value="1"><label for="yes">Yes</label><input type="radio" id="no" value="0"><label for="no">No</label></div><p class="mt-2 text-red-500 text-sm">This field is required</p></div>
  </form>`;

const PHONE = `
  <form class="grid">
    <div class="col-span-2 sm:col-span-1"><input placeholder="Email *" class="rounded-full" name="email" value="jane@x.com"></div>
    <div class="col-span-2 sm:col-span-1"><input placeholder="Phone Number *" class="rounded-full bg-beige" name="phone" value="+1 720 310 5861"><p class="mt-2 text-red-500 text-sm">Please, enter a valid phone number</p></div>
    <div class="col-span-2 sm:col-span-1"><button type="button" role="combobox" class="aria-invalid:ring-destructive/20 aria-invalid:border-destructive"><span data-slot="select-value">I understand very well</span></button><select aria-hidden="true"><option value="1">I understand very well</option></select></div>
  </form>`;

describe('radios without a name (gofasti)', () => {
  it('are one group, with the <p> above them as the question', () => {
    document.body.innerHTML = LATAM;
    const { radioGroupKey, radiosInGroup, getRadioGroupLabel } = globalThis.JMRadioGroupLabel;
    const yes = document.getElementById('yes');
    const no = document.getElementById('no');
    expect(radioGroupKey(yes)).toBeTruthy();
    expect(radioGroupKey(yes)).toBe(radioGroupKey(no));
    expect(radiosInGroup(yes)).toEqual([yes, no]);
    expect(getRadioGroupLabel([yes, no], () => 'FALLBACK')).toBe('Are you currently based in a Latin American country?');
  });

  it('are answered from the saved Q&A', async () => {
    document.body.innerHTML = LATAM;
    await window.__jobMatchDirectFill([{ question: 'Are you currently based in a Latin American country?', answer: 'No' }], {});
    expect(document.getElementById('no').checked).toBe(true);
    expect(document.getElementById('yes').checked).toBe(false);
  });

  it('count as answered once one is picked', () => {
    document.body.innerHTML = LATAM;
    document.getElementById('no').checked = true;
    expect(globalThis.JMFieldFilter.hasAnswer(document.getElementById('yes'))).toBe(true);
  });
});

describe('phone number the page calls invalid (gofasti)', () => {
  it("reads the red message under the phone box — and nothing for the other fields", () => {
    document.body.innerHTML = PHONE;
    const { fieldErrorMessage } = globalThis.JMFieldErrorFix;
    expect(fieldErrorMessage(document.querySelector('[name="phone"]'))).toBe('Please, enter a valid phone number');
    expect(fieldErrorMessage(document.querySelector('[name="email"]'))).toBe('');
    // a select trigger's shown option is never read as an error
    expect(fieldErrorMessage(document.querySelector('select'))).toBe('');
  });

  it('tries the next common format each time it is rejected, then wraps around', () => {
    const { suggestFixFromErrorMessage } = globalThis.JMFieldErrorFix;
    const msg = 'Please, enter a valid phone number';
    const seen = [];
    let v = '+1 720 310 5861';
    for (let i = 0; i < 6; i++) { v = suggestFixFromErrorMessage(v, msg); seen.push(v); }
    expect(seen).toEqual(['+17203105861', '+1 720-310-5861', '(720) 310-5861', '720-310-5861', '7203105861', '+17203105861']);
  });

  it('keeps the digits-only rule when the message states one', () => {
    const { suggestFixFromErrorMessage } = globalThis.JMFieldErrorFix;
    expect(suggestFixFromErrorMessage('+1 (720) 310-5861', 'Phone must contain only digits (10 digits)')).toBe('7203105861');
  });
});

describe('new-tab Apply link (coinbase)', () => {
  let api;
  let sent;
  beforeAll(() => {
    const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8').replace(/\r\n/g, '\n');
    const start = src.indexOf('  function applyLinkUrl(');
    const end = src.indexOf('  /**\n   * If the current page has a strong match', start);
    if (start === -1 || end === -1) throw new Error('content.js source anchors moved — update this test\'s extraction markers');
    api = new Function('sent', ` // eslint-disable-line no-new-func
      const currentAnalysis = { matchScore: 88, url: 'https://www.coinbase.com/careers/positions/8095252?gh_jid=8095252' };
      const _activeResumeId = 'resume-1';
      const _tailoredSlotActive = false;
      const _tailoredResumeSlot = null;
      function setStatus() {}
      async function sendMessage(msg) { sent.push(msg); return { tabId: 2 }; }
      ${src.slice(start, end)}
      return { applyLinkUrl, applyLinkLeadsElsewhere, openApplyInNewAutoBidTab };
    `)(sent = []);
  });

  it('opens the Apply link in a new tab that carries this job\'s Auto-Bid state', async () => {
    document.body.innerHTML = '<a rel="noopener noreferrer" data-variant="primary" href="https://job-boards.greenhouse.io/embed/job_app?token=8095252&amp;for=coinbase&amp;gh_jid=8095252" target="_blank"><span>Apply now</span></a>';
    const url = api.applyLinkUrl(document.querySelector('a'));
    expect(url).toBe('https://job-boards.greenhouse.io/embed/job_app?token=8095252&for=coinbase&gh_jid=8095252');
    expect(await api.openApplyInNewAutoBidTab(url)).toBe(true);
    expect(sent).toEqual([{
      type: 'OPEN_APPLY_TAB',
      url,
      analysis: { matchScore: 88, url: 'https://www.coinbase.com/careers/positions/8095252?gh_jid=8095252' },
      activeResumeId: 'resume-1',
      tailoredResumeSlot: null,
    }]);
  });

  it('tells an Apply link to another page from one that scrolls this page', () => {
    // Coinbase: the page's own inputs must not stop Auto-Bid from following
    // an Apply link that leads to the application elsewhere.
    document.body.innerHTML = `
      <a id="away" href="https://job-boards.greenhouse.io/embed/job_app?token=8095252&amp;for=coinbase" target="_blank">Apply now</a>
      <a id="here" href="#app">Apply</a>
      <button id="btn">Apply</button>`;
    expect(api.applyLinkLeadsElsewhere(document.getElementById('away'))).toBe(true);
    expect(api.applyLinkLeadsElsewhere(document.getElementById('here'))).toBe(false);
    expect(api.applyLinkLeadsElsewhere(document.getElementById('btn'))).toBe(false);
    expect(api.applyLinkLeadsElsewhere(null)).toBe(false);
  });

  it('has no address for a script-driven control', () => {
    document.body.innerHTML = '<a href="javascript:void(0)" target="_blank">Apply now</a><button target="_blank">Apply now</button>';
    expect(api.applyLinkUrl(document.querySelector('a'))).toBeNull();
    expect(api.applyLinkUrl(document.querySelector('button'))).toBeNull();
  });
});
