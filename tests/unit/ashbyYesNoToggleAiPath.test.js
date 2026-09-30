// Regression test for a live bug on Ashby (jobs.ashbyhq.com): a Yes/No
// question rendered as two <button aria-pressed data-option> plus a hidden
// decoy checkbox ("Will you now or in the future require visa sponsorship?")
// was never answered when the saved Q&A didn't cover it.
//
// directFill.js already clicks the real buttons, but only for a Q&A match.
// The AI path (detectFormFields → fillFormFromAnswers) registered only the
// decoy checkbox and "filled" it by clicking the checkbox — which the page
// never reads — and for a "No" answer (checkbox already unchecked) clicked
// nothing at all. Fix: detectFormFields pass 3b registers the toggle as a
// Yes/No question and fillYesNoToggle() clicks the real button.
//
// content.js isn't practical to load wholesale under happy-dom (see
// contentRadioGroupLabel.test.js), so the pass and the fill helper are
// extracted by source range.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');

let runDetection;
let fillYesNoToggle;

function sliceBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  if (start === -1 || end === -1) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  }
  return src.slice(start, end);
}

beforeAll(() => {
  const src = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');
  const pass3b = sliceBetween(src, '// ── 3b. Yes/No button toggles', '// ── 4. Standalone checkboxes ──');
  const fillFn = sliceBetween(src, 'function fillYesNoToggle(ref, value) {', '\n  function fillCheckboxFromRef');

  runDetection = new Function( // eslint-disable-line no-new-func
    `
    const isFieldEligible = () => true;
    const seen = new Set();
    const questions = [];
    const _fieldMap = {};
    let qIndex = 0;
    ${pass3b}
    return { questions, _fieldMap, seen };
    `,
  );
  fillYesNoToggle = new Function( // eslint-disable-line no-new-func
    `function clickNatively(el) { el.click(); } ${fillFn} return fillYesNoToggle;`,
  )();
});

// Verbatim from the live form (before selection).
const ASHBY_HTML = `
  <div class="_fieldEntry_1e3gg_28 ashby-application-form-field-entry" data-field-path="8b37d98f-6fb2-41ac-b867-d35612a24a39">
    <label class="_heading_f7cvd_52 _required_f7cvd_91 _label_1e3gg_42 ashby-application-form-question-title" for="8b37d98f-6fb2-41ac-b867-d35612a24a39">Will you now or in the future require visa sponsorship?</label>
    <div class="_container_1svni_28 _yesno_1e3gg_148  ashby-application-form-input-yesno">
      <button class="_container_pjyt6_1 _option_1svni_32  ashby-application-form-input-yesno-option" aria-pressed="false" data-option="yes">Yes</button>
      <button class="_container_pjyt6_1 _option_1svni_32  ashby-application-form-input-yesno-option" aria-pressed="false" data-option="no">No</button>
      <input type="checkbox" class="_input_1svni_78" tabindex="-1" name="8b37d98f-6fb2-41ac-b867-d35612a24a39">
    </div>
  </div>
`;

let clicked;
beforeEach(() => {
  document.body.innerHTML = ASHBY_HTML;
  clicked = null;
  document.querySelectorAll('button[data-option]').forEach(b => {
    b.addEventListener('click', () => { clicked = b.getAttribute('data-option'); });
  });
});

describe('content.js detectFormFields pass 3b — Ashby Yes/No toggle', () => {
  it('registers the toggle as a required Yes/No question keyed by the decoy checkbox name', () => {
    const { questions, _fieldMap, seen } = runDetection();
    expect(questions).toEqual([{
      question_id: '8b37d98f-6fb2-41ac-b867-d35612a24a39',
      question_text: 'Will you now or in the future require visa sponsorship?',
      field_type: 'radio',
      required: true,
      available_options: ['Yes', 'No'],
    }]);
    expect(_fieldMap['8b37d98f-6fb2-41ac-b867-d35612a24a39'].type).toBe('yesno_toggle');
    // Claimed, so pass 4 won't also register the decoy as a plain checkbox.
    expect(seen.has('8b37d98f-6fb2-41ac-b867-d35612a24a39')).toBe(true);
  });

  it('skips a toggle that is already answered', () => {
    document.querySelector('button[data-option="no"]').setAttribute('aria-pressed', 'true');
    expect(runDetection().questions).toEqual([]);
  });
});

describe('content.js fillYesNoToggle', () => {
  function ref() {
    const { _fieldMap } = runDetection();
    return _fieldMap['8b37d98f-6fb2-41ac-b867-d35612a24a39'];
  }

  it('clicks the real "No" button for a No answer (the case that used to click nothing)', () => {
    expect(fillYesNoToggle(ref(), 'No')).toBe(document.querySelector('button[data-option="no"]'));
    expect(clicked).toBe('no');
  });

  it('handles verbose answers', () => {
    fillYesNoToggle(ref(), 'No, I will not require sponsorship');
    expect(clicked).toBe('no');
    fillYesNoToggle(ref(), 'Yes');
    expect(clicked).toBe('yes');
  });

  it('skips rather than guesses on an unclear answer', () => {
    expect(fillYesNoToggle(ref(), 'Depends on the role')).toBeNull();
    expect(clicked).toBeNull();
  });
});

// The live TRM Labs form has 7 of these toggles (work authorization,
// sponsorship, on-call, remote experience, 100% remote, outside-work
// disclosure, heard of TRM) — every one must be picked up and filled
// independently, including after a re-render replaces a button node.
describe('content.js Yes/No toggles — several on one form', () => {
  function toggleHtml(id, question) {
    return `
      <div class="ashby-application-form-field-entry" data-field-path="${id}">
        <label class="_required_f7cvd_91 ashby-application-form-question-title" for="${id}">${question}</label>
        <div class="ashby-application-form-input-yesno">
          <button aria-pressed="false" data-option="yes">Yes</button>
          <button aria-pressed="false" data-option="no">No</button>
          <input type="checkbox" tabindex="-1" name="${id}">
        </div>
      </div>`;
  }
  const QUESTIONS = {
    'q-auth': 'Are you legally authorized to work in your current country of employment?',
    'q-visa': 'Will you now or in the future require visa sponsorship?',
    'q-oncall': 'On-Call Requirements: Are you willing and able to participate in this job\'s on-call requirements?',
    'q-heard': 'Have you heard of TRM before applying?',
  };

  beforeEach(() => {
    document.body.innerHTML = Object.entries(QUESTIONS).map(([id, q]) => toggleHtml(id, q)).join('');
  });

  it('registers every toggle with its own question', () => {
    const { questions } = runDetection();
    expect(questions.map(q => [q.question_id, q.question_text])).toEqual(Object.entries(QUESTIONS));
  });

  it('clicks the right button in each group', () => {
    const { _fieldMap } = runDetection();
    const answers = { 'q-auth': 'Yes', 'q-visa': 'No', 'q-oncall': 'Yes', 'q-heard': 'No' };
    const clicks = [];
    document.querySelectorAll('button[data-option]').forEach(b => b.addEventListener('click', () => {
      clicks.push(`${b.parentElement.querySelector('input').name}=${b.getAttribute('data-option')}`);
    }));
    for (const [qid, val] of Object.entries(answers)) fillYesNoToggle(_fieldMap[qid], val);
    expect(clicks).toEqual(['q-auth=yes', 'q-visa=no', 'q-oncall=yes', 'q-heard=no']);
  });

  it('re-finds a button that a re-render replaced after detection', () => {
    const { _fieldMap } = runDetection();
    // Simulate React replacing the q-visa group's buttons.
    const group = document.querySelector('input[name="q-visa"]').parentElement;
    group.innerHTML = '<button aria-pressed="false" data-option="yes">Yes</button><button aria-pressed="false" data-option="no">No</button><input type="checkbox" name="q-visa">';
    let clickedFresh = false;
    group.querySelector('button[data-option="no"]').addEventListener('click', () => { clickedFresh = true; });
    expect(fillYesNoToggle(_fieldMap['q-visa'], 'No')).toBe(group.querySelector('button[data-option="no"]'));
    expect(clickedFresh).toBe(true);
  });
});

describe('content.js Yes/No toggles — scope guards', () => {
  it('ignores a Yes/No button pair outside any form field (e.g. "Was this helpful?")', () => {
    document.body.innerHTML = `
      <div class="feedback-field">
        <label>Was this helpful?</label>
        <div><button aria-pressed="false">Yes</button><button aria-pressed="false">No</button></div>
      </div>`;
    expect(runDetection().questions).toEqual([]);
  });

  it('claims an already-answered toggle\'s decoy so it is not registered as a checkbox', () => {
    document.querySelector('button[data-option="no"]').setAttribute('aria-pressed', 'true');
    const { questions, seen } = runDetection();
    expect(questions).toEqual([]);
    expect(seen.has('8b37d98f-6fb2-41ac-b867-d35612a24a39')).toBe(true);
  });
});
