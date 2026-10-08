// Live on Greenhouse (job-boards.greenhouse.io/thenewyorktimes/jobs/4696589005):
// "Resume/CV is required" although a file could sit in input#resume — the
// file reached the <input> but not Greenhouse's own state. Every later pass
// then skipped the field ("already has a file"), and the pre-submit check
// ignored file uploads entirely. Same widget markup as robotsandpencils, where
// the resume did register.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
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

const RESUME_WIDGET = (error) => `
  <div class="field-wrapper"><div role="group" aria-labelledby="upload-label-resume" aria-required="true" class="file-upload" data-allow-s3="false">
    <div id="upload-label-resume" class="label upload-label${error ? ' upload-label--error' : ''}">Resume/CV<span class="required">*</span></div>
    <div class="file-upload__wrapper"><div class="button-container"><div class="secondary-button"><div>
      <button type="button" class="btn btn--rectangle">Attach</button><label class="visually-hidden" for="resume">Attach</label>
      <input id="resume" class="visually-hidden" type="file" accept=".pdf,.doc,.docx,.txt,.rtf"></div></div></div></div>
    ${error ? '<p id="resume-error" class="helper-text helper-text--error" aria-live="polite">Resume/CV is required. </p>' : ''}
  </div></div>`;

function putFile(input) {
  Object.defineProperty(input, 'files', { value: [{ name: 'Resume_Randolph.docx' }], configurable: true });
}

let api;
beforeAll(() => {
  const showsError = slice('  function uploadFieldShowsError(fileEl) {', '  /**\n   * Heuristic: does this file input look like a resume/CV upload field');
  const resumeHeuristics = slice('  function looksLikeResumeUpload(el, label) {', '  /**\n   * Re-affirms (or updates) the active resume');
  const filePass = slice('    document.querySelectorAll(\'input[type="file"]\').forEach(fileEl => {\n      if (!isFieldEligible(fileEl)) return;', '    return questions;');
  const required = slice('  function findUnfilledRequiredFields() {', '  /**\n   * The score the application is judged by');
  api = new Function(` // eslint-disable-line no-new-func
    const fieldShowsError = (el) => globalThis.JMFieldFilter.fieldShowsError(el);
    const hasAnswer = (el) => globalThis.JMFieldFilter.hasAnswer(el);
    const isFieldEligible = () => true;
    const getFieldLabel = (el) => { const l = el.id && document.querySelector('label[for="' + el.id + '"]'); return l ? l.textContent.trim() : ''; };
    const getWorkdayFieldLabel = () => '';
    const workdayPromptHasSelection = () => false;
    const getCheckboxGroups = () => [];
    const isAccumulatingFileInput = (el) => !!(el.multiple || el.getAttribute('data-automation-id') === 'file-upload-input-ref');
    const WORKDAY_SELECT_TRIGGER_SELECTOR = '[data-automation-id^="formField-"] button[aria-haspopup="listbox"]';
    ${showsError}
    ${resumeHeuristics}
    ${required}
    function collectResumeFields() {
      let _resumeFileFields = [];
      let _coverLetterFileFields = [];
      ${filePass}
      return _resumeFileFields.map(f => f.el.id);
    }
    return { uploadFieldShowsError, collectResumeFields, findUnfilledRequiredFields };
  `)();
});

beforeEach(() => { document.body.innerHTML = ''; });

describe('Greenhouse Resume/CV — the file never registered', () => {
  it('re-attaches when the page says "Resume/CV is required" even though the input holds a file', () => {
    document.body.innerHTML = RESUME_WIDGET(true);
    putFile(document.getElementById('resume'));
    expect(api.uploadFieldShowsError(document.getElementById('resume'))).toBe(true);
    expect(api.collectResumeFields()).toEqual(['resume']);
  });

  it('leaves a resume that registered fine alone', () => {
    document.body.innerHTML = RESUME_WIDGET(false);
    putFile(document.getElementById('resume'));
    expect(api.uploadFieldShowsError(document.getElementById('resume'))).toBe(false);
    expect(api.collectResumeFields()).toEqual([]);
  });

  it('the pre-submit check reports a required upload with no file, or one the page flags', () => {
    document.body.innerHTML = RESUME_WIDGET(false);
    expect(api.findUnfilledRequiredFields()).toEqual(['Resume/CV']);

    putFile(document.getElementById('resume'));
    expect(api.findUnfilledRequiredFields()).toEqual([]);

    document.body.innerHTML = RESUME_WIDGET(true);
    putFile(document.getElementById('resume'));
    expect(api.findUnfilledRequiredFields()).toEqual(['Resume/CV']);
  });
});

// The resume was attached before Greenhouse's React was listening, and React
// then held the input's value as "already this file", so later 'change'
// events with the same file were ignored. The cover letter, attached seconds
// later, registered fine.
describe('confirmUploadsRegistered — re-deliver a file the widget never took', () => {
  let confirm;
  beforeAll(() => {
    const widgetText = slice('  function uploadWidgetText(el) {', '  /**\n   * Makes sure the page actually took a file');
    const confirmSrc = slice('  async function confirmUploadsRegistered(delivered, opts = {}) {', '  async function verifyAndReattachResumeFile(');
    const showsError = slice('  function uploadFieldShowsError(fileEl) {', '  /**\n   * Heuristic: does this file input look like a resume/CV upload field');
    confirm = new Function(` // eslint-disable-line no-new-func
      const fieldShowsError = (el) => globalThis.JMFieldFilter.fieldShowsError(el);
      const sleep = () => Promise.resolve();
      class DataTransfer { constructor() { const list = []; this.items = { add: f => list.push(f) }; this.files = list; } }
      ${showsError}
      ${widgetText}
      ${confirmSrc}
      return { confirmUploadsRegistered, uploadWidgetText };
    `)();
  });

  // Mimics React's value tracking: 'change' only counts when the value moved
  // since the tracker last saw it, and writes through .value reset the tracker.
  function reactLikeInput(input, trackedAtStart) {
    let tracked = trackedAtStart;
    let files = [];
    Object.defineProperty(input, 'files', { get: () => files, set: v => { files = v; }, configurable: true });
    Object.defineProperty(input, 'value', {
      get: () => (files.length ? 'C:/fakepath/' + files[0].name : ''),
      set: v => { if (v === '') files = []; tracked = v; },
      configurable: true,
    });
    input.addEventListener('change', () => {
      if (input.value === tracked) return; // React: "no change"
      tracked = input.value;
      const widget = input.closest('.file-upload');
      widget.insertAdjacentHTML('beforeend', '<span class="file-name">' + files[0].name + ' Remove</span>');
      widget.querySelector('.upload-label').classList.remove('upload-label--error');
      widget.querySelector('#resume-error')?.remove();
    });
  }

  it('clears the stale value and re-sends change until the widget shows the file', async () => {
    document.body.innerHTML = RESUME_WIDGET(true);
    const input = document.getElementById('resume');
    const file = { name: 'Resume_Randolph.docx' };
    reactLikeInput(input, 'C:/fakepath/Resume_Randolph.docx'); // hydrated after our first attach
    input.files = [file];
    const before = api.uploadFieldShowsError(input) && confirm.uploadWidgetText(input);
    input.dispatchEvent(new Event('change')); // the early attach: ignored
    expect(api.uploadFieldShowsError(input)).toBe(true);

    const n = await confirm.confirmUploadsRegistered([{ el: input, file, before }], { waitMs: 0 });
    expect(n).toBe(1);
    expect(confirm.uploadWidgetText(input)).toContain('Resume_Randolph.docx Remove');
    expect(api.uploadFieldShowsError(input)).toBe(false);
  });

  it('leaves an upload the widget already took alone', async () => {
    document.body.innerHTML = RESUME_WIDGET(false);
    const input = document.getElementById('resume');
    const file = { name: 'Resume_Randolph.docx' };
    reactLikeInput(input, '');
    const before = confirm.uploadWidgetText(input);
    input.files = [file];
    input.dispatchEvent(new Event('change'));
    let resets = 0;
    const desc = Object.getOwnPropertyDescriptor(input, 'value');
    Object.defineProperty(input, 'value', { get: desc.get, set: v => { resets++; desc.set(v); }, configurable: true });
    expect(await confirm.confirmUploadsRegistered([{ el: input, file, before }], { waitMs: 0 })).toBe(0);
    expect(resets).toBe(0);
  });
});

describe('findUnfilledRequiredFields — Workday upload list', () => {
  it('does not report the Workday emptied-by-design upload input as missing', () => {
    document.body.innerHTML = '<div data-automation-id="formField-resume" aria-required="true"><label for="f">Upload a file</label>' +
      '<input type="file" id="f" required data-automation-id="file-upload-input-ref" multiple></div>';
    expect(api.findUnfilledRequiredFields()).toEqual([]);
  });
});
