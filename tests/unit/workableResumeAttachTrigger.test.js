// Regression test for a real bug: on Workable-hosted application forms
// (confirmed on https://apply.workable.com/.../apply/), the resume
// section's trigger button reads "Import resume from" — e.g.:
//   <button aria-haspopup="true" aria-expanded="false" data-ui="autofill-button">
//     <span>Import resume from</span>
//   </button>
// Clicking it reveals a drop-zone ("Choose file or drag and drop here")
// whose "Choose file" control opens the OS file picker for a real
// <input type="file"> that only becomes reachable once the drop-zone is
// shown.
//
// findResumeAttachTrigger()'s action-word regex — built for Jobvite's
// "Select" button — didn't include "import", so this button was never
// found at all, and the resume was silently never attached (0 fields
// found isn't treated as a failure).
//
// Fix: the action-word regex now also matches "import".
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom (see contentRadioGroupLabel.test.js), so this
// extracts getFieldLabel()/looksLikeResumeUpload()/
// looksLikeCoverLetterUpload()/findResumeAttachTrigger()/
// revealAndCollectHiddenResumeInput() by source range (all real
// implementations) and evals them together — same harness as
// jobviteResumeAttachTrigger.test.js, just against Workable's markup.
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
  const triggerEnd = src.indexOf("/**\n   * Attaches a freshly AI-generated cover letter to every detected");
  const legacyTriggerEnd = src.indexOf("/**\n   * Attaches the active resume's raw file to every detected resume-upload");
  const actualEnd = triggerEnd !== -1 ? triggerEnd : legacyTriggerEnd;
  if (triggerStart === -1 || actualEnd === -1 || actualEnd <= triggerStart) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers (findResumeAttachTrigger..revealAndCollectHiddenResumeInput)');
  }

  combinedSrc = [
    src.slice(labelStart, labelEnd),
    src.slice(uploadStart, uploadEnd),
    src.slice(triggerStart, actualEnd),
  ].join('\n');
});

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

function mockOffsetParent(el, reachableRef) {
  Object.defineProperty(el, 'offsetParent', {
    configurable: true,
    get: () => (reachableRef.value ? document.body : null),
  });
}

describe('findResumeAttachTrigger — Workable "Import resume from" button', () => {
  it('finds the button even though its text starts with "Import", not "Select"', () => {
    document.body.innerHTML = `
      <form data-ui="application-form">
        <p>Save time by importing your resume in one of the following formats: .pdf, .doc, .docx, .odt, or .rtf.</p>
        <div data-ui="autofill-button">
          <button aria-haspopup="true" aria-expanded="false" type="button">
            <div><span>Import resume from</span></div>
          </button>
        </div>
      </form>
    `;
    const { findResumeAttachTrigger } = buildHarness();
    const trigger = findResumeAttachTrigger();
    expect(trigger).not.toBeNull();
    expect(trigger.textContent.trim()).toBe('Import resume from');
  });
});

describe('revealAndCollectHiddenResumeInput — Workable-shaped: portal-mounted dialog with a PERMANENTLY hidden input', () => {
  // Verbatim (trimmed) structure from Workable's actual "Import resume
  // from" dropdown, captured live: the entire <dialog> doesn't exist in
  // the DOM at all until the trigger is clicked (a portal-mounted menu,
  // not a pre-existing-but-invisible one like Jobvite's), and the file
  // input inside it carries the HTML `hidden` attribute — it NEVER
  // becomes offsetParent-reachable, by design; `<label for="file-upload">
  // My computer</label>` is the only visible/clickable affordance. This
  // is the opposite recognition signal from Jobvite's pattern (which
  // needs "already existed, now reachable") — here it has to be "didn't
  // exist in the DOM before this click at all", regardless of the fact
  // that it's still offsetParent-null afterward too.
  function makeWorkableImportDialog() {
    document.body.innerHTML = `
      <form data-ui="application-form">
        <p>Import your resume</p>
        <button id="wk-import" aria-haspopup="true" type="button"><span>Import resume from</span></button>
      </form>
    `;
    document.getElementById('wk-import').addEventListener('click', () => {
      const dialog = document.createElement('dialog');
      dialog.id = 'wk-dropdown';
      dialog.setAttribute('open', '');
      dialog.innerHTML = `
        <ul role="listbox">
          <li role="option">
            <label for="file-upload">My computer</label>
            <input id="file-upload" data-ui="autofill-computer" multiple type="file" hidden
                   accept="application/pdf,.pdf,application/msword,.doc,.docx,.odt,.rtf">
          </li>
          <li role="option"><span>Dropbox</span></li>
          <li role="option"><span>Google Drive</span></li>
        </ul>
      `;
      document.body.appendChild(dialog);
    });
  }

  it('collects the freshly-mounted, permanently-hidden file input behind "My computer"', async () => {
    makeWorkableImportDialog();

    const { revealAndCollectHiddenResumeInput, _resumeFileFields } = buildHarness();
    const found = await revealAndCollectHiddenResumeInput();

    expect(found).toBe(true);
    expect(_resumeFileFields.length).toBe(1);
    expect(_resumeFileFields[0].el.id).toBe('file-upload');
    // Confirms this is genuinely testing the "stays hidden forever" case:
    // the `hidden` attribute is still on the element, and happy-dom (which
    // never computes real layout — offsetParent is always `undefined`,
    // never a real element) never made it artificially reachable either.
    expect(_resumeFileFields[0].el.hasAttribute('hidden')).toBe(true);
  });

  it('never clicks "My computer" or the file input itself (would open a native OS dialog)', async () => {
    makeWorkableImportDialog();
    const clicked = { label: false, input: false };
    // Attached AFTER makeWorkableImportDialog's own listener, so by the
    // time this one runs (same synchronous click dispatch) the dialog
    // has already been mounted and these elements exist to wire up.
    document.getElementById('wk-import').addEventListener('click', () => {
      document.querySelector('label[for="file-upload"]').addEventListener('click', () => { clicked.label = true; });
      document.getElementById('file-upload').addEventListener('click', () => { clicked.input = true; });
    });

    const { revealAndCollectHiddenResumeInput } = buildHarness();
    await revealAndCollectHiddenResumeInput();

    expect(clicked.label).toBe(false);
    expect(clicked.input).toBe(false);
  });

  it('does not mistake a pre-existing, unrelated file input for a freshly-mounted one', async () => {
    document.body.innerHTML = `
      <form data-ui="application-form">
        <p>Import your resume</p>
        <button id="wk-import" aria-haspopup="true" type="button"><span>Import resume from</span></button>
        <input id="unrelated-existing" type="file" hidden>
      </form>
    `;
    document.getElementById('wk-import').addEventListener('click', () => {}); // opens nothing new

    const { revealAndCollectHiddenResumeInput, _resumeFileFields } = buildHarness();
    const found = await revealAndCollectHiddenResumeInput();

    expect(found).toBe(false);
    expect(_resumeFileFields.length).toBe(0);
  });
});
