// Live on Paylocity (recruiting.paylocity.com): AutoFill kept trying the same
// fields. Country / State / "Address Line 1" widgets that never render a
// list were re-opened (and re-asked of the AI) by every pass of one run —
// main fill, retry, newly-revealed pass, "required still empty → fill
// again", the Next retry. And react-widgets' "Have you applied for a job
// with us before?" went to No and straight back to Yes.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js'), 'utf8').replace(/\r\n/g, '\n');
const slice = (a, b) => {
  const start = SRC.indexOf(a);
  const end = SRC.indexOf(b, start);
  if (start === -1 || end === -1) throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  return SRC.slice(start, end);
};

describe('fillCustomDropdown — at most two tries per field in one run', () => {
  const wrapper = slice('  async function fillCustomDropdown(input, questionText) {', '  /**\n   * The text a custom dropdown trigger shows');

  const build = (results) => new Function('results', ` // eslint-disable-line no-new-func
    const calls = [];
    const console = { info: () => {}, warn: () => {} };
    const isWorkdaySelectTrigger = () => false;
    const isWorkdayPromptInput = () => false;
    const _customDropdownAttempts = new Map();
    const MAX_CUSTOM_DROPDOWN_ATTEMPTS = 2;
    async function fillCustomDropdownOnce(input) { calls.push(input.id); return results.shift() ?? false; }
    ${wrapper}
    return { fillCustomDropdown, calls, newRun: () => _customDropdownAttempts.clear() };
  `)(results);

  beforeEach(() => { document.body.innerHTML = '<div id="public-site-address-country" role="combobox"></div><div id="info.smsOptedIn" role="combobox"></div>'; });

  it('stops re-trying a dropdown that came up empty twice, until the next run', async () => {
    const api = build([]);
    const country = document.getElementById('public-site-address-country');
    for (let pass = 0; pass < 5; pass++) await api.fillCustomDropdown(country, 'Country');
    expect(api.calls).toEqual(['public-site-address-country', 'public-site-address-country']);
    api.newRun();
    await api.fillCustomDropdown(country, 'Country');
    expect(api.calls).toHaveLength(3);
  });

  it('keeps the retry that helps, and never limits a field that fills', async () => {
    const api = build([false, true]);
    const country = document.getElementById('public-site-address-country');
    expect(await api.fillCustomDropdown(country, 'Country')).toBe(false);
    expect(await api.fillCustomDropdown(country, 'Country')).toBe(true);
    const sms = document.getElementById('info.smsOptedIn');
    api.calls.length = 0;
    const ok = build([true, true, true]);
    for (let i = 0; i < 3; i++) expect(await ok.fillCustomDropdown(sms, 'SMS')).toBe(true);
    expect(ok.calls).toHaveLength(3);
  });
});

describe('clickCustomDropdownOption — the choice has to stick', () => {
  const code = slice('  function customDropdownShownValue(trigger) {', '  async function fillCustomDropdownOnce(');
  const api = new Function(` // eslint-disable-line no-new-func
    const console = { warn: () => {} };
    const sleep = () => Promise.resolve();
    function clickElement(el) { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
    async function waitForVisibleOptions(trigger) {
      return Array.from(document.querySelectorAll('[role="option"]')).map(el => ({ el, text: el.textContent.trim() }));
    }
    ${code}
    return { clickCustomDropdownOption, customDropdownShownValue };
  `)();

  // react-widgets DropdownList as on Paylocity; the first pick of "No"
  // bounces back to "Yes", like the live page did.
  function rwDropdown({ bounceOnce }) {
    document.body.innerHTML = `
      <div id="info.haveYouAppliedWithUsBefore" role="combobox" aria-owns="info.haveYouAppliedWithUsBefore__listbox" class="rw-dropdownlist rw-widget">
        <div class="rw-input">--</div>
        <ul id="info.haveYouAppliedWithUsBefore__listbox" role="listbox"><li role="option">Yes</li><li role="option">No</li></ul>
      </div>`;
    const shown = document.querySelector('.rw-input');
    let bounced = !bounceOnce;
    document.querySelectorAll('[role="option"]').forEach(li => li.addEventListener('click', () => {
      shown.textContent = li.textContent;
      if (!bounced && li.textContent === 'No') { bounced = true; shown.textContent = 'Yes'; }
    }));
    return document.getElementById('info.haveYouAppliedWithUsBefore');
  }

  it('selects the chosen option again when the dropdown bounced to another one', async () => {
    const trigger = rwDropdown({ bounceOnce: true });
    const no = Array.from(document.querySelectorAll('[role="option"]')).find(li => li.textContent === 'No');
    await api.clickCustomDropdownOption(trigger, { el: no, text: 'No' }, ['Yes', 'No']);
    expect(api.customDropdownShownValue(trigger)).toBe('No');
  });

  it('clicks once when the choice sticks', async () => {
    const trigger = rwDropdown({ bounceOnce: false });
    const no = Array.from(document.querySelectorAll('[role="option"]')).find(li => li.textContent === 'No');
    let clicks = 0;
    no.addEventListener('click', () => clicks++);
    await api.clickCustomDropdownOption(trigger, { el: no, text: 'No' }, ['Yes', 'No']);
    expect(clicks).toBe(1);
    expect(api.customDropdownShownValue(trigger)).toBe('No');
  });
});
