// Regression test for a real bug found live on an Ashby-hosted application
// form (jobs.ashbyhq.com/.../application): attachResumeFile() reported
// success (attached > 0, the panel's own "Attached to this form" indicator
// showed a resume name) yet submitting the form produced "Missing entry
// for required field: Resume" — confirmed by the user resubmitting minutes
// later with no other change, ruling out a simple timing race with our own
// fill. The suspected mechanism: Ashby's own "Autofill from resume"
// feature runs an async parse-and-populate cycle off of a resume upload
// that can clear a file input's `.files` back to empty well after our own
// attach already ran — the same general class of "the page's own JS
// clears what we just filled" bug verifyAndRefillPersonalInfoFields
// already exists for on text fields, just never checked for the file
// input itself before now.
//
// content.js is too large to load wholesale under happy-dom, so this
// extracts just verifyAndReattachResumeFile() by source range and evals it
// with small stand-ins for its dependencies.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');
const SRC = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

const START_MARKER = 'async function verifyAndReattachResumeFile(previouslyAttached) {';
const END_MARKER = '\n  /**\n   * Returns the human-facing name for whichever resume is currently';
const START = SRC.indexOf(START_MARKER);
const END = SRC.indexOf(END_MARKER);
if (START === -1 || END === -1 || END <= START) {
  throw new Error('content.js source anchors moved — update this test\'s extraction markers');
}
const FN_SRC = SRC.slice(START, END);

// A minimal DataTransfer/File stand-in — happy-dom's real DataTransfer
// support is inconsistent across versions, and this function only ever
// touches `.items.add(file)` and reads `dt.files` to assign onto the
// input, so a tiny fake covering exactly that surface is more reliable
// than depending on the real browser API under test.
class FakeDataTransfer {
  constructor() { this._files = []; this.items = { add: (f) => this._files.push(f) }; }
  get files() { return this._files; }
}

function buildHarness({ resumeFileFields, builtResume, onSleep }) {
  const showAutofillBadgeCalls = [];
  const factory = new Function( // eslint-disable-line no-new-func
    '_resumeFileFields', 'builtResume', 'DataTransfer', 'showAutofillBadgeCalls', 'onSleep',
    `
    let _sleepCallCount = 0;
    async function sleep() { if (onSleep) onSleep(++_sleepCallCount); }
    async function buildActiveResumeFile() { return builtResume; }
    function fileAcceptsType() { return true; }
    function showAutofillBadge(el) { showAutofillBadgeCalls.push(el.id); }
    ${FN_SRC}
    return verifyAndReattachResumeFile;
    `,
  );
  return {
    run: factory(resumeFileFields, builtResume, FakeDataTransfer, showAutofillBadgeCalls, onSleep),
    showAutofillBadgeCalls,
  };
}

function makeFileInput(id, filesAtStart) {
  const el = document.createElement('input');
  el.type = 'file';
  el.id = id;
  document.body.appendChild(el);
  // happy-dom's <input type="file">.files is normally read-only; tests
  // simulate both "still has its file" and "the page cleared it" states by
  // overriding the property directly, exactly like the production code's
  // own `el.files = dt.files` assignment further down does.
  Object.defineProperty(el, 'files', { value: filesAtStart, writable: true, configurable: true });
  return el;
}

const BUILT = { file: { name: 'resume.docx' }, fileName: 'Resume_Randolph.docx', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

describe('verifyAndReattachResumeFile — the actual Ashby bug (resume file cleared after our fill)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does nothing if attachResumeFile never attached anything in the first place', async () => {
    const el = makeFileInput('resume-0', []);
    const { run, showAutofillBadgeCalls } = buildHarness({ resumeFileFields: [{ el }], builtResume: BUILT });
    const reattached = await run(0); // previouslyAttached = 0
    expect(reattached).toBe(0);
    expect(showAutofillBadgeCalls).toHaveLength(0);
  });

  it('does nothing if the file is still attached (no regression — the common case)', async () => {
    const el = makeFileInput('resume-0', [{ name: 'resume.docx' }]);
    const { run, showAutofillBadgeCalls } = buildHarness({ resumeFileFields: [{ el }], builtResume: BUILT });
    const reattached = await run(1);
    expect(reattached).toBe(0);
    expect(showAutofillBadgeCalls).toHaveLength(0);
  });

  it('re-attaches the file when it was cleared out after our own fill — the real bug', async () => {
    const el = makeFileInput('resume-0', []); // cleared by the page's own JS, per the live report
    const { run, showAutofillBadgeCalls } = buildHarness({ resumeFileFields: [{ el }], builtResume: BUILT });
    const reattached = await run(1); // attachResumeFile previously reported 1 attached
    expect(reattached).toBe(1);
    expect(el.files.length).toBe(1);
    expect(showAutofillBadgeCalls).toEqual(['resume-0']);
  });

  it('does not touch a field that is no longer connected to the DOM', async () => {
    const el = makeFileInput('resume-0', []);
    el.remove();
    const { run, showAutofillBadgeCalls } = buildHarness({ resumeFileFields: [{ el }], builtResume: BUILT });
    const reattached = await run(1);
    expect(reattached).toBe(0);
    expect(showAutofillBadgeCalls).toHaveLength(0);
  });

  it('gives up quietly if the active resume can no longer be built', async () => {
    const el = makeFileInput('resume-0', []);
    const { run, showAutofillBadgeCalls } = buildHarness({ resumeFileFields: [{ el }], builtResume: null });
    const reattached = await run(1);
    expect(reattached).toBe(0);
    expect(showAutofillBadgeCalls).toHaveLength(0);
  });
});
