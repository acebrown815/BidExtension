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

describe('getFieldLabel — walks up ancestors for the "label card" fallback (Gem-hosted forms)', () => {
  // Trimmed but structurally faithful reproduction of jobs.gem.com's real
  // form fields: NONE of firstname/lastname/email/resume have an id,
  // name, aria-label, or aria-labelledby, and there's no <label> element
  // anywhere at all — the field's actual name ("First name", "Resume")
  // sits as a sibling of a GRANDPARENT wrapper, 3 layout-only <div> levels
  // above the input itself, not as the input's own direct previous
  // sibling (which is what the original Dice-motivated fallback only
  // checked). Before walking up, getFieldLabel() returned '' for every
  // field on this entire form.
  it('resolves "First name" from 3 levels up for a bare, unlabeled text input', () => {
    document.body.innerHTML = `
      <div class="flex-30">
        <span class="bodyImportant-47">First name<span class="requiredAsterisk-76"> *</span></span>
        <div class="textField-77">
          <div class="inputWrapper-80">
            <div class="inputElementAndIconWrapper-81">
              <input class="input-84" type="text" value="">
            </div>
          </div>
        </div>
      </div>
    `;
    const label = getFieldLabel(document.querySelector('input'));
    expect(label).toContain('First name');
  });

  it('resolves "Resume" from 3 levels up for a permanently-hidden drop-zone file input', () => {
    document.body.innerHTML = `
      <span class="bodyImportant-47">Resume<span class="requiredAsterisk-76"> *</span></span>
      <div>
        <div>
          <div class="container-105" role="presentation" tabindex="0">
            <input type="file" style="display: none;">
            <div class="promptContainer-107"><span>Click to upload or drag and drop here</span></div>
          </div>
        </div>
      </div>
    `;
    const fileInput = document.querySelector('input[type="file"]');
    const label = getFieldLabel(fileInput);
    expect(label).toContain('Resume');
    expect(looksLikeResumeUpload(fileInput, label)).toBe(true);
  });

  it('does not wander further than the capped depth into unrelated content', () => {
    document.body.innerHTML = `
      <div>Unrelated heading far above</div>
      <div><div><div><div><div><div>
        <input id="too-deep" type="text">
      </div></div></div></div></div></div>
    `;
    // 6 layout levels deep, all with no siblings until the very top — past
    // the 5-level cap, so this must NOT resolve to "Unrelated heading...".
    expect(getFieldLabel(document.getElementById('too-deep'))).toBe('');
  });

  it('does not misattribute a heading to a sibling field in a shared two-column row (confirmed by code review)', () => {
    // fieldB has no id/label/aria-* of its own, so only Strategy 7's
    // ancestor walk could resolve it at all. The walk reaches a "row"
    // container shared with fieldA (a DIFFERENT field) before it would
    // reach the "Resume" heading above the whole row — that shared
    // container's own preceding-sibling text must not be handed to
    // fieldB (or fieldA) individually, since it describes the row as a
    // whole, not specifically either field.
    document.body.innerHTML = `
      <span>Resume</span>
      <div class="row">
        <div class="field"><input id="fieldA" type="file"></div>
        <div class="field"><input id="fieldB" type="text"></div>
      </div>
    `;
    expect(getFieldLabel(document.getElementById('fieldB'))).toBe('');
    expect(getFieldLabel(document.getElementById('fieldA'))).toBe('');
  });

  it('still resolves correctly when each field in a multi-field row has its own real label (no regression)', () => {
    document.body.innerHTML = `
      <div class="row">
        <div class="field"><label for="a">City</label><input id="a" type="text"></div>
        <div class="field"><label for="b">State</label><input id="b" type="text"></div>
      </div>
    `;
    expect(getFieldLabel(document.getElementById('a'))).toBe('City');
    expect(getFieldLabel(document.getElementById('b'))).toBe('State');
  });
});

describe('getFieldLabel — strips a wrapping label\'s listbox content (Workable intl-tel-input)', () => {
  // Trimmed but structurally faithful reproduction of Workable's phone
  // field (confirmed on https://apply.workable.com/.../apply/): the
  // <input> itself has no id and no aria-labelledby, so only the
  // "wrapping <label>" strategy can resolve it at all — but that label
  // wraps the ENTIRE intl-tel-input widget, including its country-code
  // dropdown (role="listbox" with one role="option" per country). Before
  // the fix, none of that survived the input/textarea/select-only removal,
  // so the resolved "label" was "Phone" followed by every country name
  // concatenated together — long enough to swamp the AI's actual question
  // for this field, so it silently never got a phone value while every
  // other field on the same form filled normally.
  function makeWorkablePhoneField() {
    document.body.innerHTML = `
      <label class="styles--3aPac">
        <span><span id="phone_label"><strong>Phone</strong></span></span>
        <div data-ui="phone">
          <div class="iti iti--allow-dropdown">
            <div class="iti__flag-container">
              <div class="iti__selected-flag" title="United States">
                <div class="iti__selected-dial-code">+1</div>
              </div>
              <div class="iti__dropdown-content iti__hide">
                <ul class="iti__country-list" role="listbox" aria-label="List of countries">
                  <li role="option" data-country-code="us"><span class="iti__country-name">United States</span><span class="iti__dial-code">+1</span></li>
                  <li role="option" data-country-code="gb"><span class="iti__country-name">United Kingdom</span><span class="iti__dial-code">+44</span></li>
                  <li role="option" data-country-code="ca"><span class="iti__country-name">Canada</span><span class="iti__dial-code">+1</span></li>
                </ul>
              </div>
            </div>
            <input name="phone" type="tel" class="iti__tel-input">
          </div>
        </div>
      </label>
    `;
    return document.querySelector('input[name="phone"]');
  }

  it('resolves to just "Phone" (plus the visible dial code), not the full country list', () => {
    const phoneInput = makeWorkablePhoneField();
    const label = getFieldLabel(phoneInput);
    const collapsed = label.replace(/\s+/g, ' ').trim();
    expect(collapsed).toBe('Phone +1');
    expect(label).not.toContain('United Kingdom');
    expect(label).not.toContain('Canada');
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
