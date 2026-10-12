// Live on Ashby (jobs.ashbyhq.com/turquoise-health/.../application):
//   - "Are you legally authorized to work in the United States?" (Yes/No
//     buttons) stayed unselected with a saved "Yes": the click was never
//     checked, and the buttons may answer pointer events only.
//   - "Location — Our roles are fully remote within the United States."
//     only knows countries: typing the city listed nothing.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
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

const TOGGLE = `<div class="ashby-application-form-field-entry" data-field-path="3a26c255-5031-4b84-88ad-58c2be3a2e82">
  <label class="ashby-application-form-question-title" for="3a26c255-5031-4b84-88ad-58c2be3a2e82">Are you legally authorized to work in the United States?</label>
  <div class="ashby-application-form-input-yesno">
    <button class="ashby-application-form-input-yesno-option" aria-pressed="false" data-option="yes">Yes</button>
    <button class="ashby-application-form-input-yesno-option" aria-pressed="false" data-option="no">No</button>
    <input type="checkbox" tabindex="-1" name="3a26c255-5031-4b84-88ad-58c2be3a2e82"></div></div>`;

describe('Ashby Yes/No toggle', () => {
  let api;
  beforeAll(() => {
    const toggle = slice('  function fillYesNoToggle(ref, value) {', '  /**\n   * The boxes of a checkbox group the AI');
    const click = slice('  function clickNatively(el) {', '\n  }\n') + '\n  }\n';
    api = new Function(` // eslint-disable-line no-new-func
      const sleep = (ms) => new Promise(r => setTimeout(r, Math.min(ms, 20)));
      ${click}
      ${toggle}
      return { fillYesNoToggle, waitForYesNoPressed, yesNoButtonFor };
    `)();
  });

  const ref = () => {
    const group = document.querySelector('.ashby-application-form-input-yesno');
    return { type: 'yesno_toggle', yesBtn: group.querySelector('[data-option="yes"]'), noBtn: group.querySelector('[data-option="no"]'), decoyName: '3a26c255-5031-4b84-88ad-58c2be3a2e82', questionText: 'Are you legally authorized…' };
  };
  const press = (btn) => btn.parentElement.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));

  beforeEach(() => { document.body.innerHTML = TOGGLE; });
  afterEach(() => { document.body.innerHTML = ''; });

  it('presses a toggle that only answers pointer events', async () => {
    const yes = document.querySelector('[data-option="yes"]');
    yes.addEventListener('pointerdown', () => press(yes));
    api.fillYesNoToggle(ref(), 'Yes');
    expect(await api.waitForYesNoPressed(ref(), 'Yes', 200)).toBe(true);
  });

  it('waits for the press to show, and presses again only when it never did', async () => {
    const yes = document.querySelector('[data-option="yes"]');
    let clicks = 0;
    yes.addEventListener('click', () => { if (++clicks >= 2) press(yes); }); // ignores the first click
    api.fillYesNoToggle(ref(), 'Yes');
    expect(await api.waitForYesNoPressed(ref(), 'Yes', 100)).toBe(false);
    api.fillYesNoToggle(ref(), 'Yes');
    expect(await api.waitForYesNoPressed(ref(), 'Yes', 100)).toBe(true);
    // pressed now — a further fill never clicks it again (would switch it off)
    api.fillYesNoToggle(ref(), 'Yes');
    expect(clicks).toBe(2);
  });

  it('a press that shows up late is waited for, not clicked twice', async () => {
    const yes = document.querySelector('[data-option="yes"]');
    let clicks = 0;
    yes.addEventListener('click', () => { clicks++; setTimeout(() => press(yes), 60); });
    api.fillYesNoToggle(ref(), 'Yes');
    expect(await api.waitForYesNoPressed(ref(), 'Yes', 500)).toBe(true);
    expect(clicks).toBe(1);
  });
});

describe('Location that only knows countries: city first, then the country', { timeout: 20000 }, () => {
  let api;
  let env;
  beforeAll(() => {
    const helpers = slice('  function findBestLocationMatch(suggestions, fullLocation) {', '  /**\n   * Fills a custom ARIA dropdown by');
    api = (e) => new Function('env', ` // eslint-disable-line no-new-func
      const sleep = (ms) => new Promise(r => setTimeout(r, Math.min(ms, 30)));
      const console = { info: () => {}, warn: () => {} };
      function dispatchFocusEvents(el, dir) { env.focus.push(dir); }
      function clickElement(el) { env.clicked.push(el.textContent.trim()); }
      ${helpers}
      return { typeCityThenCountry };
    `)(e);
  });

  let rect;
  beforeEach(() => {
    rect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 });
    document.body.innerHTML = `<div data-field-path="_systemfield_location"><label for="_systemfield_location">Location</label>
      <div class="ashby-application-form-question-description"><p>Our roles are fully remote within the United States.</p></div>
      <div><input class="ashby-application-form-input-autocomplete" placeholder="Start typing..." aria-autocomplete="list" role="combobox" value=""><button></button></div></div>`;
    env = { clicked: [], focus: [] };
  });
  afterEach(() => { Element.prototype.getBoundingClientRect = rect; document.body.innerHTML = ''; });

  // Lists only countries matching what's typed.
  const countriesOnly = (input) => input.addEventListener('input', () => setTimeout(() => {
    document.querySelector('[data-floating-ui-portal]')?.remove();
    const hits = ['United States', 'United Kingdom', 'Canada'].filter(c => c.toLowerCase().startsWith(input.value.toLowerCase()));
    if (hits.length) document.body.insertAdjacentHTML('beforeend', `<div data-floating-ui-portal=""><div role="listbox">${hits.map(h => `<div role="option">${h}</div>`).join('')}</div></div>`);
  }, 20));

  it('types the city, sees nothing, then types the country and picks it', async () => {
    const input = document.querySelector('input[role="combobox"]');
    countriesOnly(input);
    expect(await api(env).typeCityThenCountry(input, 'Location', 'Summerfield', 'United States', 'Summerfield, NC')).toBe(true);
    expect(env.clicked).toEqual(['United States']);
    expect(env.focus).toEqual(['out']);
  });

  it('keeps the city when the city lists places (an ordinary place search)', async () => {
    const input = document.querySelector('input[role="combobox"]');
    input.addEventListener('input', () => setTimeout(() => {
      document.body.insertAdjacentHTML('beforeend', '<div data-floating-ui-portal=""><div role="listbox"><div role="option">Summerfield, North Carolina, United States</div><div role="option">Summerfield, Florida, United States</div></div></div>');
    }, 20));
    await api(env).typeCityThenCountry(input, 'Location', 'Summerfield', 'United States', 'Summerfield, NC');
    expect(env.clicked).toEqual(['Summerfield, North Carolina, United States']);
  });
});
