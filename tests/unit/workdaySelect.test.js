// Workday apply-flow single-selects (*.myworkdayjobs.com — My Information and
// Application Questions steps, e.g. pae.wd1.myworkdayjobs.com/.../
// Software-Engineer-II_R0171825/apply): a bare
// <button aria-haspopup="listbox"> whose options don't exist in the DOM until
// it's clicked — Workday then appends a popper straight under <body> with
// <ul role="listbox" id=…> (the button's new aria-controls) and
// <li role="option" data-value=…><div>Yes</div></li> items. Choosing one
// writes the option's data-value into the button's value attribute.
//
// Before: none of these were detected (no role="combobox", no <form>), the
// question text was only the button's aria-label " Select One Required", and
// the unnamed sibling <input> was filled as a text field instead.
//
// Markup below is trimmed verbatim from the live pages.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');

function sliceBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  if (start === -1 || end === -1) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  }
  return src.slice(start, end);
}

let SRC;
let WORKDAY_HELPERS;

beforeAll(() => {
  SRC = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');
  WORKDAY_HELPERS = sliceBetween(SRC, '  // ── Workday apply-flow single-selects', '  /**\n   * Polls findVisibleOptions() until');
});

// happy-dom has no layout — give every element a visible box.
let originalRect;
beforeEach(() => {
  originalRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0 });
});
afterEach(() => {
  Element.prototype.getBoundingClientRect = originalRect;
});

const QUESTIONS_HTML = `
  <div data-automation-id="utilityButtonBarLanguageMenu">
    <button aria-expanded="false" aria-haspopup="listbox" id="languageSelectorButton">English</button>
  </div>
  <div data-automation-id="applyFlowPrimaryQuestionsPage">
    <div data-automation-id="formField-ae586816d2d01000bfe468cbad940001">
      <fieldset>
        <legend><div id="rich-label126"><div data-automation-id="richText"><p>Are you a U.S. Citizen?<abbr title="required" class="requiredAsterisk">*</abbr></p></div></div></legend>
        <div><div><div class="css-12zup1l">
          <button aria-haspopup="listbox" type="button" value="" aria-label=" Select One Required" name="ae586816d2d01000bfe468cbad940001" id="primaryQuestionnaire--ae586816d2d01000bfe468cbad940001">Select One</button>
          <input type="text" class="css-77hcv" value="">
        </div></div></div>
      </fieldset>
    </div>
    <div data-automation-id="formField-ae586816d2d01000bfdd1d66b00b0006">
      <fieldset>
        <legend><div id="rich-label130"><div data-automation-id="richText"><p><b>Are you willing to relocate?</b><abbr title="required" class="requiredAsterisk">*</abbr></p></div></div></legend>
        <div><div><div class="css-12zup1l">
          <button aria-haspopup="listbox" type="button" value="" aria-label=" Select One Required" name="ae586816d2d01000bfdd1d66b00b0006" id="primaryQuestionnaire--ae586816d2d01000bfdd1d66b00b0006">Select One</button>
          <input type="text" class="css-77hcv" value="">
        </div></div></div>
      </fieldset>
    </div>
    <div data-automation-id="formField-country">
      <label for="country--country"><span>Country<abbr aria-hidden="true">*</abbr></span></label>
      <div><div><div>
        <button aria-haspopup="listbox" type="button" value="bc33aa3152ec42d4995f4791a106ed09" aria-label="Country United States of America Required" name="country" id="country--country">United States of America</button>
        <input type="text" value="bc33aa3152ec42d4995f4791a106ed09">
      </div></div></div>
    </div>
  </div>
`;

describe('detectFormFields — Workday select buttons', () => {
  let runPass2;
  let runPass2b;

  beforeAll(() => {
    const pass2 = sliceBetween(SRC, '// ── 2. Text inputs, textareas', '// ── 2b. Rippling');
    const pass2b = sliceBetween(SRC, '// ── 2b. Rippling', '// ── 3. Radio button groups ──');
    const prelude = `
      ${WORKDAY_HELPERS}
      const isRipplingPage = () => false;
      const getFieldLabel = (el) => el.getAttribute('aria-label') || 'fallback label';
      const isFieldEligible = () => true;
      const isCustomDropdown = () => false;
      const readCustomOptions = () => [];
      const buildSelectOptions = () => ({ optMap: {}, optTexts: [] });
      const seen = new Set();
      const questions = [];
      const _fieldMap = {};
      let qIndex = 0;
    `;
    runPass2 = new Function(`${prelude} ${pass2} return { questions };`); // eslint-disable-line no-new-func
    runPass2b = new Function(`${prelude} ${pass2b} return { questions, _fieldMap };`); // eslint-disable-line no-new-func
  });

  beforeEach(() => {
    document.body.innerHTML = QUESTIONS_HTML;
  });

  it('registers each unanswered select with its <legend> question, not the button\'s aria-label', () => {
    const { questions, _fieldMap } = runPass2b();
    const byId = Object.fromEntries(questions.map(q => [q.question_id, q]));
    expect(Object.keys(byId).sort()).toEqual([
      'primaryQuestionnaire--ae586816d2d01000bfdd1d66b00b0006',
      'primaryQuestionnaire--ae586816d2d01000bfe468cbad940001',
    ]);
    expect(byId['primaryQuestionnaire--ae586816d2d01000bfe468cbad940001'].question_text).toBe('Are you a U.S. Citizen?');
    expect(byId['primaryQuestionnaire--ae586816d2d01000bfdd1d66b00b0006'].question_text).toBe('Are you willing to relocate?');
    expect(_fieldMap['primaryQuestionnaire--ae586816d2d01000bfe468cbad940001'].type).toBe('custom_dropdown');
  });

  it('skips an already-answered select and the header\'s language menu', () => {
    const ids = runPass2b().questions.map(q => q.question_id);
    expect(ids).not.toContain('country--country');
    expect(ids).not.toContain('languageSelectorButton');
  });

  it('never registers the unnamed input beside each select as a text field', () => {
    // The pre-filled Country's companion input has a value but still no id/name.
    expect(runPass2().questions).toEqual([]);
  });
});

/**
 * Wires a Workday select button to behave like the live page: clicking it
 * appends (after a delay, like the real async render) a popper under <body>
 * with the listbox; clicking an option writes its data-value into the
 * button and removes the popper.
 */
function wireWorkdaySelect(button, { optionsHtml, renderDelayMs = 400, optionsRespondToClick = true }) {
  button.addEventListener('click', () => {
    if (button.getAttribute('aria-expanded') === 'true') return;
    setTimeout(() => {
      const popper = document.createElement('div');
      popper.setAttribute('data-popper-placement', 'bottom');
      popper.innerHTML = `<div visibility="opened"><ul role="listbox" tabindex="-1" aria-activedescendant="select-one" id="h348q">${optionsHtml}</ul></div>`;
      document.body.appendChild(popper);
      button.setAttribute('aria-expanded', 'true');
      button.setAttribute('aria-controls', 'h348q');
      const listbox = popper.querySelector('ul');
      const options = Array.from(listbox.querySelectorAll('li'));
      const commit = (li) => {
        button.setAttribute('value', li.getAttribute('data-value'));
        button.textContent = li.textContent.trim();
        button.setAttribute('aria-expanded', 'false');
        button.removeAttribute('aria-controls');
        popper.remove();
      };
      if (optionsRespondToClick) {
        options.forEach(li => li.addEventListener('click', () => commit(li)));
      }
      listbox.addEventListener('keydown', (e) => {
        const idx = options.findIndex(li => li.id === listbox.getAttribute('aria-activedescendant'));
        if (e.key === 'ArrowDown') listbox.setAttribute('aria-activedescendant', options[Math.min(idx + 1, options.length - 1)].id);
        if (e.key === 'Enter') commit(options[idx]);
      });
    }, renderDelayMs);
  });
}

const CITIZEN_OPTIONS = `
  <li data-value="" role="option" aria-disabled="true" aria-selected="true" id="select-one"><div>Select One</div></li>
  <li data-value="ae586816d2d01000bfe46831b0bd0000" role="option" id="ae586816d2d01000bfe46831b0bd0000"><div>Yes</div></li>
  <li data-value="ae586816d2d01000bfe46831b0bd0001" role="option" id="ae586816d2d01000bfe46831b0bd0001"><div>No</div></li>
  <li data-value="ae586816d2d01000bfe468cbad940000" role="option" id="ae586816d2d01000bfe468cbad940000"><div>US Permanent Resident</div></li>
`;

describe('fillWorkdaySelect — open, wait for the generated options, pick, confirm', () => {
  let fillWorkdaySelect;
  let matchRequests;

  function load(answer) {
    matchRequests = [];
    const factory = new Function('answer', 'matchRequests', ` // eslint-disable-line no-new-func
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const clickElement = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      const _activeResumeId = 'resume-1';
      async function sendMessage(msg) { matchRequests.push(msg); return answer; }
      ${WORKDAY_HELPERS}
      return { fillWorkdaySelect };
    `);
    ({ fillWorkdaySelect } = factory(answer, matchRequests));
  }

  beforeEach(() => {
    document.body.innerHTML = QUESTIONS_HTML;
  });

  it('waits for the options generated by the click, matches only those, and commits the chosen one', async () => {
    load('US Permanent Resident');
    const button = document.getElementById('primaryQuestionnaire--ae586816d2d01000bfe468cbad940001');
    wireWorkdaySelect(button, { optionsHtml: CITIZEN_OPTIONS });

    expect(await fillWorkdaySelect(button, ' Select One Required')).toBe(true);

    expect(button.getAttribute('value')).toBe('ae586816d2d01000bfe468cbad940000');
    expect(button.textContent).toBe('US Permanent Resident');
    // Asked about the real question, with only the real (non-placeholder) options.
    expect(matchRequests[0].questionText).toBe('Are you a U.S. Citizen?');
    expect(matchRequests[0].options).toEqual(['Yes', 'No', 'US Permanent Resident']);
  });

  it('falls back to the keyboard (ArrowDown to the option, Enter) when clicking an option does not commit it', async () => {
    load('No');
    const button = document.getElementById('primaryQuestionnaire--ae586816d2d01000bfe468cbad940001');
    wireWorkdaySelect(button, { optionsHtml: CITIZEN_OPTIONS, optionsRespondToClick: false });

    expect(await fillWorkdaySelect(button, '')).toBe(true);
    expect(button.getAttribute('value')).toBe('ae586816d2d01000bfe46831b0bd0001');
  });

  it('returns false and leaves the select empty when no option matches the answer', async () => {
    load('Maybe later');
    const button = document.getElementById('primaryQuestionnaire--ae586816d2d01000bfe468cbad940001');
    wireWorkdaySelect(button, { optionsHtml: CITIZEN_OPTIONS });

    expect(await fillWorkdaySelect(button, '')).toBe(false);
    expect(button.getAttribute('value')).toBe('');
  });

  it('matches an AI answer written with a hyphen against an en-dash option', async () => {
    load('Online Job Board - LinkedIn');
    const button = document.getElementById('primaryQuestionnaire--ae586816d2d01000bfdd1d66b00b0006');
    wireWorkdaySelect(button, {
      optionsHtml: `
        <li data-value="" role="option" aria-disabled="true" id="select-one"><div>Select One</div></li>
        <li data-value="41933b7a72851082db7e277bd8ff46d8" role="option" id="41933b7a72851082db7e277bd8ff46d8"><div>Online Job Board – LinkedIn</div></li>
      `,
    });

    expect(await fillWorkdaySelect(button, '')).toBe(true);
    expect(button.getAttribute('value')).toBe('41933b7a72851082db7e277bd8ff46d8');
  });
});
