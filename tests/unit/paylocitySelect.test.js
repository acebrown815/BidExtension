// Live on Paylocity (recruiting.paylocity.com): Country / State selects were
// re-tried on every pass and never filled ("no options ever rendered for
// StateSelect a state"). Their pcty-input-select:
//   - generates its option list on open and appends it straight to <body>,
//     owned through aria-owns on a WRAPPER around the <input>;
//   - shows its value (or placeholder) inside the <label>, so the question
//     read "StateIN" / "CountryUnited States";
//   - keeps the <input> empty once a value is chosen, so a filled State
//     still looked empty.
// Markup trimmed verbatim from the live page.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../../lib/fieldFilter.js';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js'), 'utf8').replace(/\r\n/g, '\n');
const slice = (a, b) => {
  const start = SRC.indexOf(a);
  const end = SRC.indexOf(b, start);
  if (start === -1 || end === -1) throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  return SRC.slice(start, end);
};

const stateField = (shown) => `
  <div data-automation-id="public-site-address-us-state-wrapper" type="dropdown-wrapper"><div>
    <label for="public-site-address-us-state" data-automation-id="public-site-address-us-state-label">
      <span data-automation-id="public-site-address-us-state-label-span">State</span>
      <div data-automation-id="public-site-address-us-state-input-select-main-container">
        <div class="pcty-input-select-full-container" aria-expanded="false" aria-haspopup="listbox" aria-owns="public-site-address-us-state-dropdown-list-container" id="public-site-address-us-state-select-wrapper">
          <div class="pcty-input-select-input-container"><div id="public-site-address-us-state-input-action-area"></div>
            <div><div class="input-select-input-single-value">${shown}</div>
              <div class="pcty-input-select__input"><input aria-autocomplete="list" id="public-site-address-us-state" maxlength="250" required="" type="text" value=""></div></div></div>
          <div aria-hidden="true"><div><span class="pcty-input-select__indicator-separator"></span><div class="pcty-input-select__dropdown-icon" aria-hidden="true" tabindex="0"></div></div></div>
        </div>
      </div>
    </label></div>
    <span id="public-site-address-us-state-error-message" data-automation-id="public-site-address-us-state-error">Select a State/Province</span>
  </div>`;

let api;
let rectSpy;
beforeAll(() => {
  const labelHelper = slice('  function labelTextWithoutBadges(label) {', '  /** @returns {boolean} true on a Rippling');
  const options = slice('  function findVisibleOptions(triggerEl, bodyChildrenBefore) {', '  /**\n   * Collects visible, non-placeholder option elements');
  const collect = slice('  function collectOptions(nodeList, results, seen) {', '\n  }\n') + '\n  }\n';
  api = new Function(` // eslint-disable-line no-new-func
    ${labelHelper}
    ${options}
    ${collect}
    return { labelTextWithoutBadges, findVisibleOptions };
  `)();
});

beforeEach(() => {
  // happy-dom lays nothing out; give every element a size so "visible" checks pass.
  rectSpy = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 });
});
afterEach(() => { Element.prototype.getBoundingClientRect = rectSpy; document.body.innerHTML = ''; });

describe('Paylocity pcty-input-select', () => {
  it('reads the question without the value shown inside the label', () => {
    document.body.innerHTML = stateField('Select a state');
    expect(api.labelTextWithoutBadges(document.querySelector('label')).replace(/\s+/g, ' ')).toBe('State');
    document.body.innerHTML = stateField('IN');
    expect(api.labelTextWithoutBadges(document.querySelector('label')).replace(/\s+/g, ' ')).toBe('State');
  });

  it('treats "Select a state" as empty and a chosen state as answered', () => {
    document.body.innerHTML = stateField('Select a state');
    expect(globalThis.JMFieldFilter.hasAnswer(document.getElementById('public-site-address-us-state'))).toBe(false);
    document.body.innerHTML = stateField('IN');
    expect(globalThis.JMFieldFilter.hasAnswer(document.getElementById('public-site-address-us-state'))).toBe(true);
  });

  it('finds the options in the list appended to <body>, owned through the wrapper', () => {
    document.body.innerHTML = stateField('Select a state');
    const input = document.getElementById('public-site-address-us-state');
    const before = new Set(document.body.children);
    document.body.insertAdjacentHTML('beforeend', `<div id="public-site-address-us-state-dropdown-list-container">
      <div class="pcty-list"><div class="pcty-list-item">Illinois</div><div class="pcty-list-item">Indiana</div><div class="pcty-list-item">Iowa</div></div></div>`);
    expect(api.findVisibleOptions(input, before).map(o => o.text)).toEqual(['Illinois', 'Indiana', 'Iowa']);
  });

  it('finds options in any list added to <body> after opening, even without aria-owns or role="option"', () => {
    document.body.innerHTML = '<label for="c">Country</label><input id="c" aria-autocomplete="list"><div id="footer">Contact us</div>';
    const input = document.getElementById('c');
    const before = new Set(document.body.children);
    document.body.insertAdjacentHTML('beforeend', '<div class="portal"><ul><li>Canada</li><li>United States</li></ul></div>');
    expect(api.findVisibleOptions(input, before).map(o => o.text)).toEqual(['Canada', 'United States']);
  });
});
