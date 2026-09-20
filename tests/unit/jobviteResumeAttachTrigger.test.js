// Regression test for a real bug: on Jobvite-hosted application pages
// (confirmed on https://jobs.jobvite.com/<company>/job/<id>/apply), the
// "Add Resume" section's real <input type="file"> is in the DOM the whole
// time but unreachable — its wrapping element toggles hidden/shown (e.g.
// Angular's `ng-show="visible.fileUpload"`) only once a "Select"-style
// button is clicked:
//   <div ng-show="visible.fileUpload">
//     <label for="file-input-0"><span role="button">File</span></label>
//     <input id="file-input-0" type="file" style="position:absolute;
//            width:1px;height:1px;...clip:rect(0,0,0,0);...">
//   </div>
//
// detectFormFields()'s file-input scan runs once, before "Select" is ever
// clicked, so it finds the input but skips it as unreachable (its ancestor
// is display:none at that point) — _resumeFileFields stays empty and
// attachResumeFile() silently no-opped, with nothing surfaced to explain
// why (0 fields found isn't treated as a failure).
//
// Fix: attachResumeFile() now falls back to revealAndCollectHiddenResumeInput()
// when its normal scan found nothing — it clicks a resume-labeled trigger
// button, then re-scans for any file input that changed from unreachable to
// reachable as a result. It deliberately never clicks the file input (or a
// <label for="..."> wrapping it, as Jobvite's does) — for a REAL file
// input, that would open the browser's native OS file-picker dialog, which
// no script can drive or dismiss.
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom (see contentRadioGroupLabel.test.js), so this
// extracts getFieldLabel()/looksLikeResumeUpload()/
// looksLikeCoverLetterUpload()/findResumeAttachTrigger()/
// revealAndCollectHiddenResumeInput() by source range (all real
// implementations, nothing stubbed out) and evals them together, with only
// `_resumeFileFields` and `waitForDomSettled` declared fresh per test as
// their free-variable stand-ins.
//
// happy-dom doesn't implement real layout, so `offsetParent` is always
// `undefined` regardless of `display` — never the real `null`/element
// values a browser would compute. Tests that need to model an
// unreachable-then-reachable transition mock `offsetParent` directly via
// Object.defineProperty rather than relying on actual CSS.
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
    throw new Error('content.js source anchors moved — update this test\'s extraction markers (looksLike*Upload)');
  }

  const triggerStart = src.indexOf('function findResumeAttachTrigger() {');
  const triggerEnd = src.indexOf("/**\n   * Attaches the active resume's raw file to every detected resume-upload");
  if (triggerStart === -1 || triggerEnd === -1 || triggerEnd <= triggerStart) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers (findResumeAttachTrigger..revealAndCollectHiddenResumeInput)');
  }

  combinedSrc = [
    src.slice(labelStart, labelEnd),
    src.slice(uploadStart, uploadEnd),
    src.slice(triggerStart, triggerEnd),
  ].join('\n');
});

/**
 * Builds a fresh set of the real extracted functions, each call getting its
 * own empty _resumeFileFields array — same pattern as
 * checkPendingAutoBidAutofill.test.js's per-test factory.
 */
function buildHarness() {
  // eslint-disable-next-line no-eval
  const factory = (0, eval)(`(function () {
    const _resumeFileFields = [];
    async function waitForDomSettled() {}
    ${combinedSrc}
    return {
      findResumeAttachTrigger,
      revealAndCollectHiddenResumeInput,
      _resumeFileFields,
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

describe('findResumeAttachTrigger — Jobvite "Apply With" widget', () => {
  it('finds the "Select" button via its aria-labelledby resume heading', () => {
    document.body.innerHTML = `
      <h3 id="jv-resume-header">Add Resume*</h3>
      <div id="attachResume"><div>
        <button type="button" aria-labelledby="jv-resume-header">Select</button>
      </div></div>
    `;
    const { findResumeAttachTrigger } = buildHarness();
    const trigger = findResumeAttachTrigger();
    expect(trigger).not.toBeNull();
    expect(trigger.textContent.trim()).toBe('Select');
  });

  it('does not match an unrelated button with no resume context', () => {
    document.body.innerHTML = `<button type="button">Select</button>`;
    const { findResumeAttachTrigger } = buildHarness();
    expect(findResumeAttachTrigger()).toBeNull();
  });

  it('does not match a resume-context button whose text is not an attach-style action', () => {
    document.body.innerHTML = `
      <h3 id="jv-resume-header">Add Resume*</h3>
      <button type="button" aria-labelledby="jv-resume-header">Learn more</button>
    `;
    const { findResumeAttachTrigger } = buildHarness();
    expect(findResumeAttachTrigger()).toBeNull();
  });
});

describe('revealAndCollectHiddenResumeInput — Jobvite-shaped: input pre-exists, ancestor toggles reachability', () => {
  it('collects an already-in-DOM file input that becomes reachable only after the trigger click', async () => {
    document.body.innerHTML = `
      <h3 id="jv-resume-header">Add Resume*</h3>
      <button id="jv-select" type="button" aria-labelledby="jv-resume-header">Select</button>
      <div id="file-wrap">
        <label for="file-input-0"><span role="button">File</span></label>
        <input id="file-input-0" type="file">
      </div>
    `;
    const fileInput = document.getElementById('file-input-0');
    const reachable = { value: false };
    mockOffsetParent(fileInput, reachable);
    document.getElementById('jv-select').addEventListener('click', () => { reachable.value = true; });

    const { revealAndCollectHiddenResumeInput, _resumeFileFields } = buildHarness();
    const found = await revealAndCollectHiddenResumeInput();

    expect(found).toBe(true);
    expect(_resumeFileFields.length).toBe(1);
    expect(_resumeFileFields[0].el).toBe(fileInput);
  });

  it('never clicks the file input or its wrapping label (would open a native OS dialog)', async () => {
    document.body.innerHTML = `
      <h3 id="jv-resume-header">Add Resume*</h3>
      <button id="jv-select" type="button" aria-labelledby="jv-resume-header">Select</button>
      <label id="jv-label" for="file-input-0"><span role="button">File</span></label>
      <input id="file-input-0" type="file">
    `;
    const fileInput = document.getElementById('file-input-0');
    mockOffsetParent(fileInput, { value: true }); // already reachable throughout
    let labelClicked = false;
    let inputClicked = false;
    document.getElementById('jv-label').addEventListener('click', () => { labelClicked = true; });
    fileInput.addEventListener('click', () => { inputClicked = true; });

    const { revealAndCollectHiddenResumeInput } = buildHarness();
    await revealAndCollectHiddenResumeInput();

    expect(labelClicked).toBe(false);
    expect(inputClicked).toBe(false);
  });

  it('does not re-collect a file input that was already reachable before the click (nothing this click revealed)', async () => {
    document.body.innerHTML = `
      <h3 id="jv-resume-header">Add Resume*</h3>
      <button type="button" aria-labelledby="jv-resume-header">Select</button>
      <input id="already-reachable" type="file">
    `;
    mockOffsetParent(document.getElementById('already-reachable'), { value: true });

    const { revealAndCollectHiddenResumeInput, _resumeFileFields } = buildHarness();
    const found = await revealAndCollectHiddenResumeInput();

    expect(found).toBe(false);
    expect(_resumeFileFields.length).toBe(0);
  });

  it('returns false when there is no resume-attach trigger to click at all', async () => {
    document.body.innerHTML = `<div>Nothing relevant here</div>`;
    const { revealAndCollectHiddenResumeInput, _resumeFileFields } = buildHarness();
    const found = await revealAndCollectHiddenResumeInput();
    expect(found).toBe(false);
    expect(_resumeFileFields.length).toBe(0);
  });

  it('skips a newly-reachable field that unambiguously looks like a cover-letter upload', async () => {
    document.body.innerHTML = `
      <h3 id="jv-resume-header">Add Resume*</h3>
      <button id="jv-select" type="button" aria-labelledby="jv-resume-header">Select</button>
      <label for="cl-input">Cover Letter</label>
      <input id="cl-input" type="file">
    `;
    const clInput = document.getElementById('cl-input');
    const reachable = { value: false };
    mockOffsetParent(clInput, reachable);
    document.getElementById('jv-select').addEventListener('click', () => { reachable.value = true; });

    const { revealAndCollectHiddenResumeInput, _resumeFileFields } = buildHarness();
    const found = await revealAndCollectHiddenResumeInput();

    expect(found).toBe(false);
    expect(_resumeFileFields.length).toBe(0);
  });
});
