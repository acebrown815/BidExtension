// Live on Ashby (jobs.ashbyhq.com/meridianlink/.../application): "Please let
// us know where you heard about this job opening?" was never filled. It's a
// search-as-you-type <input role="combobox" aria-autocomplete="list"> whose
// options only appear once typed into (or opened with its toggle button),
// in a floating-ui portal appended to <body>. Only the Location field typed
// into such inputs; now every search-as-you-type question does.
// Markup trimmed verbatim from the live page.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../../lib/qaMatch.js';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js'), 'utf8').replace(/\r\n/g, '\n');
const slice = (a, b) => {
  const start = SRC.indexOf(a);
  const end = SRC.indexOf(b, start);
  if (start === -1 || end === -1) throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  return SRC.slice(start, end);
};

const FIELD = `
  <div data-field-path="471fca4d-e9a3-4011-bdbb-71c2410d61a1"><fieldset>
    <label class="ashby-application-form-question-title" for="471fca4d-e9a3-4011-bdbb-71c2410d61a1">Please let us know where you heard about this job opening?</label>
    <div class="_inputContainer_d7ago_28">
      <input class="ashby-application-form-input-autocomplete" placeholder="Start typing..." aria-autocomplete="list" aria-expanded="false" aria-haspopup="listbox" role="combobox" value="">
      <button class="_toggleButton_d7ago_32"><svg></svg></button>
    </div></fieldset></div>`;

const PORTAL = `<div id=":r5:" data-floating-ui-portal=""><div tabindex="-1" id=":r3:" role="listbox">
  <div class="ashby-application-form-input-autocomplete-popup">
    <div role="option" id=":r4c:" aria-selected="false"><span>LinkedIn</span></div>
    <div role="option" id=":r4d:" aria-selected="false"><span>MeridianLink Career Site</span></div>
  </div></div><button type="button" tabindex="-1">Dismiss</button></div>`;

let api;
let env;
beforeAll(() => {
  const code = slice('  function isSearchAsYouTypeCombobox(el) {', '  async function fillCustomDropdownOnce(');
  api = (e) => new Function('env', ` // eslint-disable-line no-new-func
    const _activeResumeId = 'r1';
    const console = { info: () => {}, warn: () => {} };
    const sleep = () => Promise.resolve();
    async function sendMessage(msg) {
      env.sent.push(msg.type);
      if (msg.type === 'GET_QA_LIST') return env.qa;
      if (msg.type === 'MATCH_DROPDOWN') return env.pick(msg);
      return null;
    }
    function typeIntoAutocomplete(input, text) { input.value = text; env.typed.push(text); if (env.onType) env.onType(text); }
    async function waitForNewSuggestionOptions(before) {
      return Array.from(document.querySelectorAll('[role="option"]')).filter(o => !before.has(o)).map(el => ({ el, text: el.textContent.trim() }));
    }
    function clickElement(el) { env.clicked.push(el.textContent.trim()); }
    function dispatchFocusEvents(el, dir) { env.focus.push(dir); }
    ${code}
    return { isSearchAsYouTypeCombobox, comboboxToggleButton, typeAndPickSuggestion, searchTextsFor };
  `)(e);
});

let rectSpy;
beforeEach(() => {
  // happy-dom lays nothing out; give every element a size so "visible" checks pass.
  rectSpy = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 });
  document.body.innerHTML = FIELD;
  env = {
    qa: [{ question: 'How did you hear about this position?', answer: 'Linkedin' }],
    sent: [], typed: [], clicked: [], focus: [],
    pick: () => null,
    onType: () => document.body.insertAdjacentHTML('beforeend', PORTAL),
  };
});
afterEach(() => { Element.prototype.getBoundingClientRect = rectSpy; document.body.innerHTML = ''; });

const input = () => document.querySelector('input[role="combobox"]');
const QUESTION = 'Please let us know where you heard about this job opening?';

describe('Ashby search-as-you-type question', () => {
  it('is recognised, with its toggle button', () => {
    const a = api(env);
    expect(a.isSearchAsYouTypeCombobox(input())).toBe(true);
    expect(a.comboboxToggleButton(input()).className).toContain('toggleButton');
  });

  it('types the saved referral answer and picks "LinkedIn" from the <body> portal, then leaves the field', async () => {
    const a = api(env);
    expect(await a.typeAndPickSuggestion(input(), QUESTION, '')).toBe(true);
    expect(env.typed).toEqual(['Linkedin']);
    expect(env.clicked).toEqual(['LinkedIn']);
    expect(env.focus).toEqual(['out']);
  });

  it('falls back to the AI answer, and lets the matcher choose when nothing matches the typed text', async () => {
    env.qa = [];
    env.pick = (msg) => (msg.options.includes('MeridianLink Career Site') ? 'MeridianLink Career Site' : null);
    const a = api(env);
    expect(await a.typeAndPickSuggestion(input(), QUESTION, 'Company website')).toBe(true);
    expect(env.typed).toEqual(['Company website']);
    expect(env.clicked).toEqual(['MeridianLink Career Site']);
  });

  it('gives up (false) when typing produces no suggestions', async () => {
    env.onType = null;
    const a = api(env);
    expect(await a.typeAndPickSuggestion(input(), QUESTION, '')).toBe(false);
    expect(env.clicked).toEqual([]);
  });

  it('a plain text input is not treated as search-as-you-type', () => {
    document.body.innerHTML = '<input id="name" type="text">';
    expect(api(env).isSearchAsYouTypeCombobox(document.getElementById('name'))).toBe(false);
  });
});

// What the live run hit: the arrow button "listed 34 options" that didn't
// include LinkedIn, and typing "Linkedin" found nothing new.
describe('Ashby: one shared floating-ui portal, rows reused while typing', () => {
  let findVisibleOptions, snapshotDropdownState;
  beforeAll(() => {
    const opts = slice('  function findVisibleOptions(triggerEl, before) {', '  /**\n   * Collects visible, non-placeholder option elements');
    const collect = slice('  function collectOptions(nodeList, results, seen) {', '\n  }\n') + '\n  }\n';
    ({ findVisibleOptions, snapshotDropdownState } = new Function(`${opts}\n${collect}\nreturn { findVisibleOptions, snapshotDropdownState };`)()); // eslint-disable-line no-new-func
  });

  it('reads only the list the arrow opened, inside the portal another field already created', () => {
    // The portal is already in <body> (Location used it), with stale suggestions.
    document.body.insertAdjacentHTML('beforeend', `<div data-floating-ui-portal=""><div role="listbox" id="loc"><div role="option">Summerfield, NC</div></div></div>
      <ul class="nav"><li class="menu-option">Jobs</li><li class="menu-option">Teams</li></ul>`);
    const snap = snapshotDropdownState();
    document.querySelector('[data-floating-ui-portal]').insertAdjacentHTML('beforeend',
      '<div role="listbox" id=":r3:"><div role="option"><span>LinkedIn</span></div><div role="option"><span>MeridianLink Career Site</span></div></div>');
    expect(findVisibleOptions(input(), snap).map(o => o.text)).toEqual(['LinkedIn', 'MeridianLink Career Site']);
  });

  it('picks the typed answer when typing filters the open list down to the same row', async () => {
    env.onType = null;
    document.body.insertAdjacentHTML('beforeend', PORTAL); // full list already open
    const linkedin = document.querySelector('[role="option"]');
    env.onType = () => document.querySelectorAll('[role="option"]').forEach(o => { if (o !== linkedin) o.remove(); });
    expect(await api(env).typeAndPickSuggestion(input(), QUESTION, '')).toBe(true);
    expect(env.clicked).toEqual(['LinkedIn']);
  });
});
