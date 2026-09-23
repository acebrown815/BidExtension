// Regression test for a real bug found live on a Greenhouse application
// form: the phone NUMBER <input> (from the "intl-tel-input" library, wrapper
// class "iti") was misclassified as a custom-dropdown trigger, so AutoFill
// tried to open it and wait for options instead of just typing the phone
// number — it always failed with "no options ever rendered".
//
// Root cause: isCustomDropdown()'s fallback heuristic treats an input as a
// combobox if some nearby ancestor's class name contains "select"/
// "dropdown"/"combobox"/"listbox" AND that ancestor's subtree contains a
// real [role="listbox"]/[role="option"]. intl-tel-input's outer wrapper
// carries BEM modifier classes like "iti--allow-dropdown" and
// "iti--inline-dropdown" — which contain the substring "dropdown" — and
// that same wrapper also contains a *separate*, unrelated country-code
// picker (a button + a real role="listbox" of ~240 countries) used only for
// phone format validation. The phone number input has nothing to do with
// that listbox, but the loose substring/nearby-container heuristic linked
// them anyway.
//
// content.js is too large to load wholesale under happy-dom, so this
// extracts just isCustomDropdown() by source range (it only touches its own
// `el` argument, so no other dependencies need stubbing) and evals it.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');
const SRC = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

const START_MARKER = 'function isCustomDropdown(el) {';
const END_MARKER = '\n  }\n';
const START = SRC.indexOf(START_MARKER);
const END = SRC.indexOf(END_MARKER, START);
if (START === -1 || END === -1 || END <= START) {
  throw new Error('content.js source anchors moved — update this test\'s extraction markers');
}
const FN_SRC = SRC.slice(START, END + END_MARKER.length - 1); // keep the closing brace

const isCustomDropdown = new Function(`${FN_SRC}\nreturn isCustomDropdown;`)(); // eslint-disable-line no-new-func

function makeEl({ tag = 'input', type, attrs = {}, className = '', ancestorClasses = [], nearbyListbox = false }) {
  const target = document.createElement(tag);
  if (type) target.type = type;
  Object.entries(attrs).forEach(([k, v]) => target.setAttribute(k, v));
  target.className = className;

  let current = target;
  let nearestWrapper = null; // the wrapper closest() will match first
  for (const cls of ancestorClasses) {
    const wrapper = document.createElement('div');
    wrapper.className = cls;
    wrapper.appendChild(current);
    if (!nearestWrapper) nearestWrapper = wrapper;
    current = wrapper;
  }
  if (nearbyListbox) {
    const listbox = document.createElement('ul');
    listbox.setAttribute('role', 'listbox');
    const option = document.createElement('li');
    option.setAttribute('role', 'option');
    listbox.appendChild(option);
    (nearestWrapper || current).appendChild(listbox);
  }
  document.body.appendChild(current);
  return target;
}

describe('isCustomDropdown — the actual phone-widget false positive', () => {
  it('does NOT classify an intl-tel-input phone number input as a dropdown', () => {
    const phoneInput = makeEl({
      type: 'tel',
      attrs: { id: 'phone' },
      ancestorClasses: ['iti iti--allow-dropdown iti--show-flags iti--inline-dropdown'],
      nearbyListbox: true, // the country-code picker's own listbox, unrelated to this input
    });
    expect(isCustomDropdown(phoneInput)).toBe(false);
  });

  it('does NOT classify a plain input inside a ".iti" wrapper even without type="tel"', () => {
    const input = makeEl({
      attrs: { id: 'phone' },
      ancestorClasses: ['iti'],
      nearbyListbox: true,
    });
    expect(isCustomDropdown(input)).toBe(false);
  });

  it('still classifies a genuine react-select combobox as a custom dropdown (no regression)', () => {
    const raceInput = makeEl({
      attrs: { id: 'race', role: 'combobox', 'aria-haspopup': 'true' },
      ancestorClasses: ['select__control'],
    });
    expect(isCustomDropdown(raceInput)).toBe(true);
  });

  it('still classifies a generic custom-select wrapper via the nearby-listbox fallback (no regression)', () => {
    // The trigger input itself carries none of the combobox attributes/
    // classes — only its ancestor wrapper does — matching the real
    // react-select DOM shape this fallback exists for.
    const input = makeEl({
      ancestorClasses: ['select__value-container', 'select__control'],
      nearbyListbox: true,
    });
    expect(isCustomDropdown(input)).toBe(true);
  });
});
