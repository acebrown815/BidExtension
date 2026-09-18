// Regression test for a real bug: on Dice's application wizard
// (https://www.dice.com/job-applications/<id>/wizard), the "Resume &
// Cover Letter" step's two <input type="file"> fields have no id, name,
// aria-label, or aria-labelledby of their own — the only ARIA attribute
// present is aria-describedby, which points at a generic "File types
// supported .pdf, .doc, .docx, .txt, .rtf up to 2MB" description, not the
// field's actual name. The real name ("Resume" / "Cover letter") lives in
// a sibling <div> "label card" placed BEFORE the bare <input>, not
// wrapping it and not referenced by any attribute at all.
//
// getFieldLabel() had no fallback for this layout, so it returned '' for
// both fields — which meant looksLikeResumeUpload()/
// looksLikeCoverLetterUpload() (which both bail out immediately on an
// empty probe) never matched, and neither field was ever picked up by
// AutoFill's automatic resume/cover-letter attachment.
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom (see contentRadioGroupLabel.test.js), so this
// extracts getFieldLabel()/looksLikeResumeUpload()/
// looksLikeCoverLetterUpload() by source range and evals them in
// isolation.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');

let getFieldLabel;
let looksLikeResumeUpload;
let looksLikeCoverLetterUpload;

beforeAll(() => {
  const src = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

  const labelStart = src.indexOf('function getFieldLabel(input) {');
  const labelEnd = src.indexOf('/**\n   * Like getFieldLabel, but for an entire radio GROUP');
  if (labelStart === -1 || labelEnd === -1 || labelEnd <= labelStart) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers (getFieldLabel)');
  }
  const getFieldLabelSrc = src.slice(labelStart, labelEnd);

  const uploadStart = src.indexOf('function looksLikeResumeUpload(el, label) {');
  const uploadEnd = src.indexOf('/**\n   * Re-affirms (or updates) the active resume');
  if (uploadStart === -1 || uploadEnd === -1 || uploadEnd <= uploadStart) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers (looksLike*Upload)');
  }
  const uploadSrc = src.slice(uploadStart, uploadEnd);

  // eslint-disable-next-line no-eval
  const factory = (0, eval)(`(function () {
    ${getFieldLabelSrc}
    ${uploadSrc}
    return { getFieldLabel, looksLikeResumeUpload, looksLikeCoverLetterUpload };
  })`);
  ({ getFieldLabel, looksLikeResumeUpload, looksLikeCoverLetterUpload } = factory());
});

// Verbatim (trimmed) structure from Dice's actual wizard page.
function makeDiceResumeCoverLetterStep() {
  document.body.innerHTML = `
    <form>
      <div class="my-2 rounded-lg border p-5 mb-6">
        <div class="mb-2 inline-flex min-h-7 w-full items-start justify-start gap-1">
          <span class="inline font-medium text-base">Resume <span class="text-danger">*</span></span>
        </div>
        <button type="button">Upload your resume</button>
        <div id="resume-description" class="mt-2 text-sm">File types supported .pdf, .doc, .docx, .txt, .rtf up to 2MB</div>
      </div>
      <input id="resumeFile" class="sr-only" accept=".pdf, .doc, .docx, .txt, .rtf" aria-describedby="resume-description" type="file">
      <div class="my-2 rounded-lg border p-5 mb-6">
        <div class="mb-2 inline-flex min-h-7 w-full items-start justify-start gap-1">
          <span class="inline font-medium text-base">Cover letter </span>
          <div class="ml-auto text-right text-xs"><i>Optional</i></div>
        </div>
        <button type="button">Upload your cover letter</button>
        <div id="cover letter-description" class="mt-2 text-sm">File types supported .pdf, .doc, .docx, .txt, .rtf up to 2MB</div>
      </div>
      <input id="coverLetterFile" class="sr-only" accept=".pdf, .doc, .docx, .txt, .rtf" aria-describedby="cover letter-description" type="file">
    </form>
  `;
  return {
    resumeInput: document.getElementById('resumeFile'),
    coverLetterInput: document.getElementById('coverLetterFile'),
  };
}

describe('getFieldLabel — sibling "label card" fallback (Dice wizard)', () => {
  it('resolves a label for a file input from its preceding sibling card when no id/name/aria-label exists', () => {
    const { resumeInput, coverLetterInput } = makeDiceResumeCoverLetterStep();
    expect(getFieldLabel(resumeInput)).toContain('Resume');
    expect(getFieldLabel(coverLetterInput)).toContain('Cover letter');
  });

  it('does not use the fallback when a real label already resolves', () => {
    document.body.innerHTML = `
      <div>Some unrelated preceding text</div>
      <label for="email">Email</label>
      <input id="email" type="text">
    `;
    expect(getFieldLabel(document.getElementById('email'))).toBe('Email');
  });

  it('returns empty when there is no preceding sibling at all', () => {
    document.body.innerHTML = `<div><input id="lonely" type="text"></div>`;
    expect(getFieldLabel(document.getElementById('lonely'))).toBe('');
  });
});

describe('looksLikeResumeUpload / looksLikeCoverLetterUpload — Dice wizard classification', () => {
  it('classifies the resume field as a resume upload, not a cover-letter upload', () => {
    const { resumeInput } = makeDiceResumeCoverLetterStep();
    const label = getFieldLabel(resumeInput);
    expect(looksLikeResumeUpload(resumeInput, label)).toBe(true);
    expect(looksLikeCoverLetterUpload(resumeInput, label)).toBe(false);
  });

  it('classifies the cover-letter field as a cover-letter upload, not a resume upload', () => {
    const { coverLetterInput } = makeDiceResumeCoverLetterStep();
    const label = getFieldLabel(coverLetterInput);
    expect(looksLikeCoverLetterUpload(coverLetterInput, label)).toBe(true);
    expect(looksLikeResumeUpload(coverLetterInput, label)).toBe(false);
  });

  it('skips a combined "Resume/Cover Letter" uploader for both (too ambiguous to guess)', () => {
    document.body.innerHTML = '<label for="f">Resume/Cover Letter</label><input id="f" type="file">';
    const el = document.getElementById('f');
    const label = getFieldLabel(el);
    expect(looksLikeResumeUpload(el, label)).toBe(false);
    expect(looksLikeCoverLetterUpload(el, label)).toBe(false);
  });
});
