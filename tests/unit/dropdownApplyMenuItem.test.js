// Regression test for a real bug: on Leonardo DRS's career site
// (confirmed on https://careers.leonardodrs.com/job/.../1396791300/),
// the "Apply now" control found by findApplyButton() is a Bootstrap
// dropdown-toggle button:
//   <button data-toggle="dropdown" aria-haspopup="true" aria-label="Apply now">
//     Apply now <span class="caret"></span>
//   </button>
// Clicking it never navigates anywhere — it only reveals a menu of apply
// METHODS ("Apply Now", "Start applying with LinkedIn", ...). Auto-Bid's
// automated flow (autoClickApplyThenAutofillIfNeeded) clicked this button
// and then just assumed navigation was underway, so it silently did
// nothing beyond opening the menu — the tab was left sitting on the same
// page with the dropdown open.
//
// Fix: detect a dropdown-toggle "Apply" control via its standard
// aria-haspopup/data-toggle attributes, click it to open the menu (unless
// it's already expanded — a toggle TOGGLES, so clicking an
// already-expanded one would close it instead), then click through to the
// real "Apply Now" item inside it via the new findDropdownApplyMenuItem()
// — reusing findApplyButton()'s own apply-shaped text regex so it only
// ever matches the plain "Apply Now" option, never "...with LinkedIn" or
// another social/SSO option.
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom (see contentRadioGroupLabel.test.js), so this
// extracts findApplyButton()/findDropdownApplyMenuItem() by source range
// and evals them in isolation.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');

let findApplyButton;
let findDropdownApplyMenuItem;

beforeAll(() => {
  const src = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

  const applyStart = src.indexOf('function findApplyButton() {');
  const applyEnd = src.indexOf('// Hard cap on how many wizard steps');
  if (applyStart === -1 || applyEnd === -1 || applyEnd <= applyStart) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers (findApplyButton)');
  }

  const menuStart = src.indexOf('function findDropdownApplyMenuItem(toggleBtn) {');
  const menuEnd = src.indexOf('/**\n   * If the current page has a strong match but no application form yet');
  if (menuStart === -1 || menuEnd === -1 || menuEnd <= menuStart) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers (findDropdownApplyMenuItem)');
  }

  const combined = [src.slice(applyStart, applyEnd), src.slice(menuStart, menuEnd)].join('\n');
  // eslint-disable-next-line no-eval
  const factory = (0, eval)(`(function () { ${combined} return { findApplyButton, findDropdownApplyMenuItem }; })`);
  ({ findApplyButton, findDropdownApplyMenuItem } = factory());
});

// Trimmed but structurally faithful reproduction of Leonardo DRS's real
// "Apply now" dropdown-toggle button and its revealed menu.
function makeLeonardoDrsApplyDropdown() {
  document.body.innerHTML = `
    <div class="btn-group btn-social btn-social-apply open">
      <button class="btn btn-primary btn-large btn-lg dropdown-toggle" data-toggle="dropdown"
              aria-haspopup="true" aria-label="Apply now" aria-expanded="true">
        Apply now <span class="caret"></span>
      </button>
      <ul class="dropdown-menu socialbutton pull-right">
        <li class="tc-provider-option social-apply-option" role="none">
          <a role="menuitem" href="#" id="applyOption-top-manual" class="networkContainer applyOption socialbutton-link" aria-label="Apply Now">
            Apply Now
          </a>
        </li>
        <li role="none" class="tc-provider-option social-apply-option">
          <a role="menuitem" href="#" aria-label="Start applying with LinkedIn" id="applyOption-top-linkedin" class="networkContainer applyOption socialbutton-link">
            Start applying with LinkedIn
          </a>
        </li>
      </ul>
    </div>
  `;
  return {
    toggleBtn: document.querySelector('button.dropdown-toggle'),
    manualLink: document.getElementById('applyOption-top-manual'),
    linkedinLink: document.getElementById('applyOption-top-linkedin'),
  };
}

describe('findApplyButton — finds the Leonardo DRS dropdown-toggle "Apply now" button', () => {
  it('matches the toggle button by its "Apply now" text', () => {
    const { toggleBtn } = makeLeonardoDrsApplyDropdown();
    const found = findApplyButton();
    expect(found).toBe(toggleBtn);
  });
});

describe('findDropdownApplyMenuItem — picks the plain "Apply Now" item, never LinkedIn', () => {
  it('finds the manual "Apply Now" link inside the revealed menu', () => {
    const { toggleBtn, manualLink } = makeLeonardoDrsApplyDropdown();
    const found = findDropdownApplyMenuItem(toggleBtn);
    expect(found).toBe(manualLink);
  });

  it('never returns the "Start applying with LinkedIn" option', () => {
    const { toggleBtn, linkedinLink } = makeLeonardoDrsApplyDropdown();
    const found = findDropdownApplyMenuItem(toggleBtn);
    expect(found).not.toBe(linkedinLink);
  });

  it('returns null when the menu has no plain apply-shaped item at all (e.g. only social options)', () => {
    document.body.innerHTML = `
      <div class="btn-group">
        <button data-toggle="dropdown" aria-haspopup="true">Apply now</button>
        <ul class="dropdown-menu">
          <li><a role="menuitem" href="#">Start applying with LinkedIn</a></li>
          <li><a role="menuitem" href="#">Start applying with Google</a></li>
        </ul>
      </div>
    `;
    const toggleBtn = document.querySelector('button');
    expect(findDropdownApplyMenuItem(toggleBtn)).toBeNull();
  });

  it('returns null when there is no menu at all near the toggle', () => {
    document.body.innerHTML = `<button data-toggle="dropdown" aria-haspopup="true">Apply now</button>`;
    const toggleBtn = document.querySelector('button');
    expect(findDropdownApplyMenuItem(toggleBtn)).toBeNull();
  });
});
