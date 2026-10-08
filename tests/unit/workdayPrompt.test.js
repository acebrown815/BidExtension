// Workday "prompt" selects (confirmed on bcbsla.wd1.myworkdayjobs.com — "How
// Did You Hear About Us?"): the field's input is only a search box; clicking
// it appends a popup under <body> whose list can be NESTED — "Job Board" (a
// category row with a side chevron) swaps the list for its children
// ("Job Board - Glassdoor", …, "Job Board - Linkedin"), and only a leaf row
// selects a value (shown as a selected-item pill in the field). The list is
// ReactVirtualized: ~8 rows are rendered at a time, aria-setsize gives the
// real count.
//
// Before: the search box was filled as a plain text field (selecting
// nothing), so Workday reported "The field How Did You Hear About Us? is
// required and must have a value."
//
// Markup below is trimmed verbatim from the live page.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import '../../lib/fieldFilter.js'; // real shouldKeepExistingAnswer / fieldShowsError for the sliced harness

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');

function sliceBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  if (start === -1 || end === -1) throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  return src.slice(start, end);
}

let SRC;
let WORKDAY_HELPERS; // button selects + prompts (shares getWorkdayFieldLabel / findOptionByText)

beforeAll(() => {
  SRC = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');
  WORKDAY_HELPERS = sliceBetween(SRC, '  // ── Workday apply-flow single-selects', '  /**\n   * Polls findVisibleOptions() until');
});

const WIDGET_ID = '0cf06936-6b86-421d-aec5-9c347c3b9e3c';

const FIELD_HTML = `
  <div data-automation-id="formField-source" data-fkit-id="source--source">
    <label for="source--source"><span>How Did You Hear About Us?<abbr aria-hidden="true">*</abbr></span></label>
    <div><div><div dir="ltr" tabindex="-1" data-automation-id="multiSelectContainer" id="${WIDGET_ID}" data-uxi-widget-type="multiselect">
      <div data-automation-id="multiselectInputContainer"><div>
        <input placeholder="Search" aria-required="true" autocomplete="off" data-uxi-widget-type="selectinput" id="source--source" value="">
        <div data-automation-id="promptAriaInstruction">0 items selected</div>
      </div><span data-automation-id="promptIcon"></span></div>
    </div></div></div>
  </div>
  <div data-automation-id="formField-countryPhoneCode">
    <label for="phoneNumber--countryPhoneCode">Country Phone Code</label>
    <div data-automation-id="multiSelectContainer" id="b33f68df-0517-47c4-b2c5-3dc41031318e">
      <input placeholder="Search" data-uxi-widget-type="selectinput" id="phoneNumber--countryPhoneCode" value="United States">
      <ul role="listbox" data-automation-id="selectedItemList"><li><div role="option" data-automation-id="selectedItem">
        <p data-automation-id="promptOption" data-automation-label="United States of America (+1)">United States of America (+1)</p></div></li></ul>
    </div>
  </div>
`;

const TOP_LEVEL = ['College/University', 'Corporate Career Site', 'Employee Referral', 'Job Board', 'Other', 'Print', 'Professional Organization', 'Social Media'];
const CHILDREN = {
  'Job Board': ['Job Board - Glassdoor', 'Job Board - Hispanic Chamber of Commerce', 'Job Board - Indeed', 'Job Board - Linkedin',
    'Job Board - Louisiana Job Connection', 'Job Board - Louisiana Workforce Commission', 'Job Board - Monster', 'Job Board - Other'],
  'Social Media': ['Social Media - Facebook', 'Social Media - Instagram', 'Social Media - X'],
};

function rowHtml(text, i, total, isBranch) {
  const slug = text.replace(/\W+/g, '-');
  return `<div aria-setsize="${total}" id="menuItem-${slug}" data-automation-id="menuItem" role="option" aria-posinset="${i + 1}" aria-selected="false" style="height: 32px; position: absolute; top: ${i * 32}px;">
    <div data-automation-id="promptLeafNode" data-uxi-multiselectlistitem-hassidecharm="${isBranch}" data-uxi-multiselectlistitem-type="${isBranch ? 2 : 1}">
      ${isBranch ? '' : `<input type="radio" data-automation-id="radioBtn" value="">`}
      <div data-automation-id="promptOption" data-automation-label="${text}">${text}</div>
    </div></div>`;
}

/**
 * Simulates the live widget: click the input → (delay) popup with the top
 * level; click a category → (delay) its children replace the list; click a
 * leaf → selected-item pill appears in the field and the popup closes. Only
 * `visibleRows` rows are rendered at a time; scrolling the listbox renders the
 * rest, like ReactVirtualized.
 */
function wirePrompt({ children = CHILDREN, top = TOP_LEVEL, renderDelayMs = 300, visibleRows = 8 } = {}) {
  const input = document.getElementById('source--source');
  let popup = null;

  const renderLevel = (title, items, isBranchFn) => {
    popup.innerHTML = `<div>
      <div data-associated-widget="${WIDGET_ID}" data-automation-id="responsiveMonikerPrompt" data-automation-type="singleSelectPrompt">
        ${title ? `<div data-automation-id="multiSelectHeader"><span data-automation-id="backButton"></span><div data-automation-id="promptTitle" title="${title}">${title}</div></div>` : ''}
        <div><div data-automation-id="activeListContainer" role="listbox" style="height: 256px; overflow: hidden;"><div class="inner"></div></div></div>
      </div></div>`;
    const list = popup.querySelector('[role="listbox"]');
    const inner = list.querySelector('.inner');
    let scroll = 0;
    const paint = () => {
      const start = Math.min(Math.floor(scroll / 32), Math.max(0, items.length - visibleRows));
      inner.innerHTML = items.slice(start, start + visibleRows).map((t, k) => rowHtml(t, start + k, items.length, isBranchFn(t))).join('');
      inner.querySelectorAll('[data-automation-id="menuItem"]').forEach(row => {
        const text = row.querySelector('[data-automation-id="promptOption"]').textContent;
        row.addEventListener('click', () => {
          if (isBranchFn(text)) {
            setTimeout(() => renderLevel(text, children[text], () => false), renderDelayMs);
          } else {
            const container = document.getElementById(WIDGET_ID);
            container.insertAdjacentHTML('beforeend',
              `<ul role="listbox" data-automation-id="selectedItemList"><li><div role="option" data-automation-id="selectedItem"><p data-automation-id="promptOption" data-automation-label="${text}">${text}</p></div></li></ul>`);
            popup.remove();
          }
        });
      });
    };
    Object.defineProperty(list, 'scrollTop', { get: () => scroll, set: (v) => { scroll = v; }, configurable: true });
    Object.defineProperty(list, 'clientHeight', { get: () => 256, configurable: true });
    Object.defineProperty(list, 'scrollHeight', { get: () => items.length * 32, configurable: true });
    list.addEventListener('scroll', paint);
    paint();
    const back = popup.querySelector('[data-automation-id="backButton"]');
    if (back) back.addEventListener('click', () => setTimeout(() => renderLevel('', top, (t) => !!children[t]), renderDelayMs));
  };

  input.addEventListener('click', () => {
    if (popup) return;
    setTimeout(() => {
      popup = document.createElement('div');
      popup.setAttribute('data-popper-placement', 'bottom');
      document.body.appendChild(popup);
      renderLevel('', top, (t) => !!children[t]);
    }, renderDelayMs);
  });
  return input;
}

function load(answerFor) {
  const requests = [];
  const factory = new Function('answerFor', 'requests', ` // eslint-disable-line no-new-func
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const clickElement = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const _activeResumeId = 'resume-1';
    const getFieldLabel = () => '';
    async function sendMessage(msg) { requests.push(msg); return answerFor(msg.options, msg.questionText); }
    ${WORKDAY_HELPERS}
    return { fillWorkdayPrompt, workdayPromptHasSelection, isWorkdayPromptInput };
  `);
  return { ...factory(answerFor, requests), requests };
}

beforeEach(() => {
  document.body.innerHTML = FIELD_HTML;
});

describe('fillWorkdayPrompt — nested Workday prompt', { timeout: 20000 }, () => {
  it('picks the category, waits for its sub-list to replace the list, then picks the leaf', async () => {
    const input = wirePrompt();
    const { fillWorkdayPrompt, workdayPromptHasSelection, requests } = load((options) => {
      if (options.includes('Job Board')) return 'Job Board';
      if (options.includes('Job Board - Linkedin')) return 'Job Board - Linkedin';
      return null;
    });

    expect(await fillWorkdayPrompt(input, '')).toBe(true);

    expect(workdayPromptHasSelection(input)).toBe(true);
    expect(document.getElementById(WIDGET_ID).querySelector('[data-automation-id="selectedItem"]').textContent.trim()).toBe('Job Board - Linkedin');
    // First question tells the matcher these are categories; second is the plain question.
    expect(requests[0].questionText).toMatch(/^How Did You Hear About Us\? \(these are categories/);
    expect(requests[0].options).toEqual(TOP_LEVEL);
    expect(requests[1].questionText).toBe('How Did You Hear About Us?');
    expect(requests[1].options).toEqual(CHILDREN['Job Board']);
  });

  it('goes back and tries another category when a sub-list has nothing suitable', async () => {
    const input = wirePrompt();
    const { fillWorkdayPrompt, requests } = load((options) => {
      if (options.includes('Social Media')) return 'Social Media'; // first guess: no LinkedIn under it
      if (options.includes('Job Board')) return 'Job Board';       // after backing up (Social Media excluded)
      if (options.includes('Job Board - Linkedin')) return 'Job Board - Linkedin';
      return null;
    });

    expect(await fillWorkdayPrompt(input, '')).toBe(true);
    expect(document.querySelector('[data-automation-id="selectedItem"]').textContent.trim()).toBe('Job Board - Linkedin');
    // The retry at the top level no longer offers the dead-end category.
    const retry = requests.find((r, i) => i > 0 && r.options.includes('Job Board'));
    expect(retry.options).not.toContain('Social Media');
  });

  it('reads past the rendered window of a virtualized list (aria-setsize > rows rendered)', async () => {
    const top = [...TOP_LEVEL, 'Recruiter Outreach', 'Radio', 'Television', 'Word of Mouth'];
    const input = wirePrompt({ top, children: {}, visibleRows: 8 });
    const { fillWorkdayPrompt, requests } = load((options) => (options.includes('Word of Mouth') ? 'Word of Mouth' : null));

    expect(await fillWorkdayPrompt(input, '')).toBe(true);
    expect(requests[0].options).toEqual(top);
    expect(document.querySelector('[data-automation-id="selectedItem"]').textContent.trim()).toBe('Word of Mouth');
  });

  it('leaves an already-answered prompt alone', async () => {
    const { fillWorkdayPrompt, requests } = load(() => null);
    expect(await fillWorkdayPrompt(document.getElementById('phoneNumber--countryPhoneCode'), '')).toBe(true);
    expect(requests).toEqual([]);
  });
});

describe('detectFormFields pass 2 — Workday prompt inputs', () => {
  it('registers an unanswered prompt as a dropdown with its label, and skips an answered one', () => {
    const pass2 = sliceBetween(SRC, '// ── 2. Text inputs, textareas', '// ── 2b. Rippling');
    const run = new Function(` // eslint-disable-line no-new-func
      ${WORKDAY_HELPERS}
      const getFieldLabel = (el) => 'fallback';
      const isFieldEligible = () => true; const shouldKeepExistingAnswer = (el) => globalThis.JMFieldFilter.shouldKeepExistingAnswer(el); const fieldShowsError = (el) => globalThis.JMFieldFilter.fieldShowsError(el);
      const isCustomDropdown = () => false;
      const readCustomOptions = () => [];
      const buildSelectOptions = () => ({ optMap: {}, optTexts: [] });
      const seen = new Set();
      const questions = [];
      const _fieldMap = {};
      let qIndex = 0;
      ${pass2}
      return { questions, _fieldMap };
    `);
    const { questions, _fieldMap } = run();
    expect(questions).toEqual([{
      question_id: 'source--source',
      question_text: 'How Did You Hear About Us?',
      field_type: 'dropdown',
      required: true,
      available_options: [],
    }]);
    expect(_fieldMap['source--source'].type).toBe('custom_dropdown');
  });
});
