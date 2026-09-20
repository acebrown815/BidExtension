// Cover-letter twin of jobviteResumeAttachTrigger.test.js — same Jobvite
// "Apply With" widget bug, but for the Cover Letter section, which repeats
// the identical structure with a second hidden input:
//   <div ng-show="visible.fileUpload">
//     <label for="file-input-1"><span role="button">File</span></label>
//     <input id="file-input-1" type="file" style="position:absolute;
//            width:1px;height:1px;...clip:rect(0,0,0,0);...">
//   </div>
//
// Unlike the resume path, attachCoverLetterFile() was previously gated
// behind `if (_coverLetterFileFields.length > 0)` in fillCurrentAutofillStep()
// — since a Jobvite cover-letter field never populates
// _coverLetterFileFields via the initial scan (unreachable until "Select"
// is clicked), that gate meant attachCoverLetterFile() was never even
// CALLED, let alone given a chance to reveal the hidden field. The gate now
// also checks findCoverLetterAttachTrigger() directly.
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom (see contentRadioGroupLabel.test.js), so this
// extracts getFieldLabel()/looksLikeResumeUpload()/
// findCoverLetterAttachTrigger()/revealAndCollectHiddenCoverLetterInput()
// by source range (all real implementations) and evals them together.
//
// happy-dom doesn't implement real layout, so `offsetParent` is always
// `undefined` regardless of `display`. Tests that need to model an
// unreachable-then-reachable transition mock `offsetParent` directly via
// Object.defineProperty rather than relying on actual CSS — see
// jobviteResumeAttachTrigger.test.js for the same pattern.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');

let combinedSrc;

beforeAll(() => {
  const src = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

  const labelStart = src.indexOf('function getFieldLabel(input) {');
  const labelEnd = src.indexOf('/**\n   * Like getFieldLabel, but for an entire radio GROUP');
  if (labelStart === -1 || labelEnd === -1 || labelEnd <= labelStart) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers (getFieldLabel)');
  }

  const uploadStart = src.indexOf('function looksLikeResumeUpload(el, label) {');
  const uploadEnd = src.indexOf('/**\n   * Re-affirms (or updates) the active resume');
  if (uploadStart === -1 || uploadEnd === -1 || uploadEnd <= uploadStart) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers (looksLikeResumeUpload)');
  }

  const triggerStart = src.indexOf('function findCoverLetterAttachTrigger() {');
  const triggerEnd = src.indexOf("/**\n   * Attaches a freshly AI-generated cover letter to every detected");
  if (triggerStart === -1 || triggerEnd === -1 || triggerEnd <= triggerStart) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers (findCoverLetterAttachTrigger..revealAndCollectHiddenCoverLetterInput)');
  }

  combinedSrc = [
    src.slice(labelStart, labelEnd),
    src.slice(uploadStart, uploadEnd),
    src.slice(triggerStart, triggerEnd),
  ].join('\n');
});

function buildHarness() {
  // eslint-disable-next-line no-eval
  const factory = (0, eval)(`(function () {
    const _coverLetterFileFields = [];
    async function waitForDomSettled() {}
    ${combinedSrc}
    return {
      findCoverLetterAttachTrigger,
      revealAndCollectHiddenCoverLetterInput,
      _coverLetterFileFields,
    };
  })`);
  return factory();
}

/** Mocks offsetParent (happy-dom always leaves it `undefined`) so tests can model reachable/unreachable. */
function mockOffsetParent(el, reachableRef) {
  Object.defineProperty(el, 'offsetParent', {
    configurable: true,
    get: () => (reachableRef.value ? document.body : null),
  });
}

describe('findCoverLetterAttachTrigger — Jobvite "Apply With" widget', () => {
  it('finds the "Select" button via its aria-labelledby cover-letter heading', () => {
    document.body.innerHTML = `
      <h3 id="jv-cl-header">Cover Letter</h3>
      <div id="attachCoverLetter"><div>
        <button type="button" aria-labelledby="jv-cl-header">Select</button>
      </div></div>
    `;
    const { findCoverLetterAttachTrigger } = buildHarness();
    const trigger = findCoverLetterAttachTrigger();
    expect(trigger).not.toBeNull();
    expect(trigger.textContent.trim()).toBe('Select');
  });

  it('does not match the resume section\'s trigger', () => {
    document.body.innerHTML = `
      <h3 id="jv-resume-header">Add Resume*</h3>
      <button type="button" aria-labelledby="jv-resume-header">Select</button>
    `;
    const { findCoverLetterAttachTrigger } = buildHarness();
    expect(findCoverLetterAttachTrigger()).toBeNull();
  });
});

describe('revealAndCollectHiddenCoverLetterInput — Jobvite-shaped: input pre-exists, ancestor toggles reachability', () => {
  it('collects an already-in-DOM file input that becomes reachable only after the trigger click', async () => {
    document.body.innerHTML = `
      <h3 id="jv-cl-header">Cover Letter</h3>
      <button id="jv-select" type="button" aria-labelledby="jv-cl-header">Select</button>
      <label for="file-input-1"><span role="button">File</span></label>
      <input id="file-input-1" type="file">
    `;
    const fileInput = document.getElementById('file-input-1');
    const reachable = { value: false };
    mockOffsetParent(fileInput, reachable);
    document.getElementById('jv-select').addEventListener('click', () => { reachable.value = true; });

    const { revealAndCollectHiddenCoverLetterInput, _coverLetterFileFields } = buildHarness();
    const found = await revealAndCollectHiddenCoverLetterInput();

    expect(found).toBe(true);
    expect(_coverLetterFileFields.length).toBe(1);
    expect(_coverLetterFileFields[0].el).toBe(fileInput);
  });

  it('never clicks the file input or its wrapping label (would open a native OS dialog)', async () => {
    document.body.innerHTML = `
      <h3 id="jv-cl-header">Cover Letter</h3>
      <button id="jv-select" type="button" aria-labelledby="jv-cl-header">Select</button>
      <label id="jv-label" for="file-input-1"><span role="button">File</span></label>
      <input id="file-input-1" type="file">
    `;
    const fileInput = document.getElementById('file-input-1');
    mockOffsetParent(fileInput, { value: true });
    let labelClicked = false;
    let inputClicked = false;
    document.getElementById('jv-label').addEventListener('click', () => { labelClicked = true; });
    fileInput.addEventListener('click', () => { inputClicked = true; });

    const { revealAndCollectHiddenCoverLetterInput } = buildHarness();
    await revealAndCollectHiddenCoverLetterInput();

    expect(labelClicked).toBe(false);
    expect(inputClicked).toBe(false);
  });

  it('skips a newly-reachable field that unambiguously looks like a resume upload', async () => {
    document.body.innerHTML = `
      <h3 id="jv-cl-header">Cover Letter</h3>
      <button id="jv-select" type="button" aria-labelledby="jv-cl-header">Select</button>
      <label for="resume-input">Resume</label>
      <input id="resume-input" type="file">
    `;
    const resumeInput = document.getElementById('resume-input');
    const reachable = { value: false };
    mockOffsetParent(resumeInput, reachable);
    document.getElementById('jv-select').addEventListener('click', () => { reachable.value = true; });

    const { revealAndCollectHiddenCoverLetterInput, _coverLetterFileFields } = buildHarness();
    const found = await revealAndCollectHiddenCoverLetterInput();

    expect(found).toBe(false);
    expect(_coverLetterFileFields.length).toBe(0);
  });

  it('returns false when there is no cover-letter-attach trigger to click at all', async () => {
    document.body.innerHTML = `<div>Nothing relevant here</div>`;
    const { revealAndCollectHiddenCoverLetterInput, _coverLetterFileFields } = buildHarness();
    const found = await revealAndCollectHiddenCoverLetterInput();
    expect(found).toBe(false);
    expect(_coverLetterFileFields.length).toBe(0);
  });
});
