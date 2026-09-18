// Regression test for a real bug, discovered in two stages against live
// Dice application forms.
//
// Stage 1 (narrower, now superseded): fillCustomDropdown()'s zip/postal-
// code shortcut (see zipCodeAutocompleteFill.test.js) never actually ran,
// because fillFormFromAnswers() skipped the field entirely BEFORE it was
// ever bucketed into customDropdowns[] — the bulk AI answer for "What is
// your current city of residence?" was NEEDS_USER_INPUT (a personal
// question it can't answer from a resume), and the very first gate —
// `if (!val || val === 'NEEDS_USER_INPUT') { skipped.push(...); continue; }`
// — ran before fillCustomDropdown() (or its zip shortcut) ever got a
// chance to run.
//
// Stage 2 (the actual, general root cause): the SAME thing was still
// happening for "Work Authorization" — a plain custom_dropdown with no
// zip/postal hint at all — even after the saved-Q&A matching itself was
// fixed and confirmed correct (deterministicMatcher.test.js). Looking at
// Phase 3 of fillFormFromAnswers (below this gate): it calls
// fillCustomDropdown(ref.el, ref.questionText || val) — `val` is used
// ONLY as a questionText fallback, never as the actual fill value.
// fillCustomDropdown() always independently re-derives the real answer
// via its own MATCH_DROPDOWN call against the dropdown's LIVE options,
// which tries the deterministic Q&A/profile matcher before ever falling
// back to AI. So gating ANY custom_dropdown field on the bulk answer
// being non-empty was simply wrong — it discarded every personal/
// ambiguous dropdown question (work authorization, city of residence,
// ...) that the deterministic matcher could have answered perfectly well
// on its own, no matter how correct that matcher already was.
//
// Fix: EVERY custom_dropdown field now bypasses this gate and reaches
// fillCustomDropdown() regardless of the bulk AI's own answer for it.
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom (see contentRadioGroupLabel.test.js), so this
// extracts just fillFormFromAnswers() by source range and evals it with
// small stand-ins for its dependencies.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');
const SRC = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

const START_MARKER = 'async function fillFormFromAnswers(answers) {';
const END_MARKER = '/**\n   * Legacy fill path for old-format AI responses';
const START = SRC.indexOf(START_MARKER);
const END = SRC.indexOf(END_MARKER);
if (START === -1 || END === -1 || END <= START) {
  throw new Error('content.js source anchors moved — update this test\'s extraction markers');
}
const FN_SRC = SRC.slice(START, END);

/**
 * Builds a runnable fillFormFromAnswers() with stubbed dependencies.
 * @param {Object} opts
 * @param {Object} opts.fieldMap - _fieldMap contents (question_id -> ref).
 * @param {Function} [opts.fillCustomDropdownImpl] - stand-in for fillCustomDropdown; defaults to always "succeeding".
 * @param {Array} [opts.calls] - array tagged events are pushed onto.
 */
function buildFillFormFromAnswers({ fieldMap, fillCustomDropdownImpl, calls = [] }) {
  const factory = new Function( // eslint-disable-line no-new-func
    'fieldMap', 'calls',
    `
    const _fieldMap = fieldMap;
    const _activeResumeId = 'r1';
    function showAutofillBadge() {}
    function fillRadioFromRef() { return true; }
    function fillCheckboxFromRef() {}
    function fillInput() {}
    function fillSelectByText() {}
    async function sendMessage() { return {}; }
    async function fillCustomDropdown(el, questionText) {
      calls.push({ type: 'fillCustomDropdown', questionText });
      return ${fillCustomDropdownImpl ? 'fillCustomDropdownImpl(el, questionText)' : 'true'};
    }
    async function fillFormLegacy() { return { filled: 0, skipped: [] }; }
    ${FN_SRC}
    return fillFormFromAnswers;
    `,
  );
  return factory(fieldMap, calls);
}

describe('fillFormFromAnswers — custom_dropdown fields always bypass the empty-answer skip', () => {
  let calls;

  beforeEach(() => {
    calls = [];
  });

  it('calls fillCustomDropdown() for a zip-shortcut field even when the AI answered NEEDS_USER_INPUT', async () => {
    const input = document.createElement('input');
    input.placeholder = 'Enter your city or postal code (e.g., Denver, CO or 80202)';
    const fieldMap = {
      location: { el: input, type: 'custom_dropdown', questionText: 'What is your current city of residence?' },
    };
    const fillFormFromAnswers = buildFillFormFromAnswers({ fieldMap, calls });

    const { filled, skipped } = await fillFormFromAnswers([
      { question_id: 'location', generated_text: 'NEEDS_USER_INPUT' },
    ]);

    expect(calls).toEqual([{ type: 'fillCustomDropdown', questionText: 'What is your current city of residence?' }]);
    expect(filled).toBe(1);
    expect(skipped).toEqual([]);
  });

  it('calls fillCustomDropdown() when the AI gave a completely empty answer', async () => {
    const input = document.createElement('input');
    input.placeholder = 'Enter your city or postal code (e.g., Denver, CO or 80202)';
    const fieldMap = {
      location: { el: input, type: 'custom_dropdown', questionText: 'What is your current city of residence?' },
    };
    const fillFormFromAnswers = buildFillFormFromAnswers({ fieldMap, calls });

    await fillFormFromAnswers([{ question_id: 'location', generated_text: '' }]);

    expect(calls.length).toBe(1);
  });

  it('ALSO calls fillCustomDropdown() for a plain, non-zip-hinted custom dropdown (the real, more general bug — "Work Authorization")', async () => {
    const trigger = document.createElement('button');
    trigger.setAttribute('aria-haspopup', 'listbox'); // no placeholder at all — buttons don't have one
    const fieldMap = {
      workAuthorization: { el: trigger, type: 'custom_dropdown', questionText: 'Work Authorization' },
    };
    const fillFormFromAnswers = buildFillFormFromAnswers({ fieldMap, calls });

    const { filled, skipped } = await fillFormFromAnswers([
      { question_id: 'workAuthorization', generated_text: 'NEEDS_USER_INPUT' },
    ]);

    expect(calls).toEqual([{ type: 'fillCustomDropdown', questionText: 'Work Authorization' }]);
    expect(filled).toBe(1);
    expect(skipped).toEqual([]);
  });

  it('still skips a plain TEXT field (not a custom_dropdown) when the AI answered NEEDS_USER_INPUT', async () => {
    const input = document.createElement('input');
    const fieldMap = {
      salary: { el: input, type: 'text' },
    };
    const fillFormFromAnswers = buildFillFormFromAnswers({ fieldMap, calls });

    const { filled, skipped } = await fillFormFromAnswers([
      { question_id: 'salary', generated_text: 'NEEDS_USER_INPUT' },
    ]);

    expect(calls).toEqual([]); // fillCustomDropdown is irrelevant here — never called
    expect(filled).toBe(0);
    expect(skipped).toEqual(['salary']);
  });

  it('reports skipped (not filled) if fillCustomDropdown itself can\'t fill the field', async () => {
    const trigger = document.createElement('button');
    const fieldMap = {
      workAuthorization: { el: trigger, type: 'custom_dropdown', questionText: 'Work Authorization' },
    };
    const fillFormFromAnswers = buildFillFormFromAnswers({
      fieldMap, calls, fillCustomDropdownImpl: () => false, // no matching saved answer, nothing to click
    });

    const { filled, skipped } = await fillFormFromAnswers([
      { question_id: 'workAuthorization', generated_text: 'NEEDS_USER_INPUT' },
    ]);

    expect(filled).toBe(0);
    expect(skipped).toEqual(['workAuthorization']);
  });
});
