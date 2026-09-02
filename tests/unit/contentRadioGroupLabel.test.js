// content.js is a large content script (chrome.runtime listeners, shadow
// DOM panel creation, etc. run at load time) that isn't practical to load
// wholesale under happy-dom, so this test extracts just getFieldLabel()
// and the new getRadioGroupLabel() by source range and evals them in
// isolation — the same bug and the same fix as
// tests/unit/directFillRadioGroupLabel.test.js, but for content.js's own,
// independent radio-group label resolution used when building the
// AI-facing `question_text` for a <fieldset> radio group.
//
// Root cause: content.js's detectFormFields() built a radio group's
// question_text by calling getFieldLabel() on one radio in the group.
// getFieldLabel's `label[for]` strategy, on an ATS (seen on Ashby) that
// gives each radio OPTION its own <label for="optionId"> for the option's
// visible text ("Man"), always found that option's own label first,
// mislabeling the whole group's question as "Man" instead of "What is
// your gender identity?" — garbage context for the AI, and (per the
// destructive-clobber bug fixed in the same commit) capable of silently
// un-selecting whatever Pass 1 (direct Q&A fill) had already correctly
// chosen, since checking a different radio in the same name-group
// natively unchecks the first.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');

// The user's real, live Ashby "Diversity Survey" gender-identity fieldset
// (data-field-entry-id prefix differs from the job-application-section
// copy of the same question, but the structure — and the bug — is
// identical), verbatim from a "Copy outerHTML" of the actual page.
const GENDER_IDENTITY_HTML = `
<div data-field-path="8d7dcc65-3a0b-476a-b679-574b869780bb" data-field-entry-id="d9a9fa1d-b382-4611-9b65-83ef449df4ea_8d7dcc65-3a0b-476a-b679-574b869780bb">
  <fieldset class="_container_1258i_28 _fieldEntry_1e3gg_28 ashby-application-form-input-radio-group">
    <label class="_heading_f7cvd_52  _label_1e3gg_42 ashby-application-form-question-title" for="8d7dcc65-3a0b-476a-b679-574b869780bb">What is your gender identity?</label>
    <div class="_option_1258i_34 false ashby-application-form-input-radio-group-option">
      <span class="_container_132c8_28" data-disabled="false"><span class="_circle_132c8_77"></span>
        <input type="radio" id="d9a9fa1d-b382-4611-9b65-83ef449df4ea_8d7dcc65-3a0b-476a-b679-574b869780bb-labeled-radio-0" name="d9a9fa1d-b382-4611-9b65-83ef449df4ea_8d7dcc65-3a0b-476a-b679-574b869780bb" class="ashby-application-form-input-radio-group-option-radio">
      </span>
      <label for="d9a9fa1d-b382-4611-9b65-83ef449df4ea_8d7dcc65-3a0b-476a-b679-574b869780bb-labeled-radio-0" class="_label_1258i_42  ashby-application-form-input-radio-group-option-label">Man</label>
    </div>
    <div class="_option_1258i_34 false ashby-application-form-input-radio-group-option">
      <span class="_container_132c8_28" data-disabled="false"><span class="_circle_132c8_77"></span>
        <input type="radio" id="d9a9fa1d-b382-4611-9b65-83ef449df4ea_8d7dcc65-3a0b-476a-b679-574b869780bb-labeled-radio-1" name="d9a9fa1d-b382-4611-9b65-83ef449df4ea_8d7dcc65-3a0b-476a-b679-574b869780bb" class="ashby-application-form-input-radio-group-option-radio">
      </span>
      <label for="d9a9fa1d-b382-4611-9b65-83ef449df4ea_8d7dcc65-3a0b-476a-b679-574b869780bb-labeled-radio-1" class="_label_1258i_42  ashby-application-form-input-radio-group-option-label">Woman</label>
    </div>
    <div class="_option_1258i_34 false ashby-application-form-input-radio-group-option">
      <span class="_container_132c8_28" data-disabled="false"><span class="_circle_132c8_77"></span>
        <input type="radio" id="d9a9fa1d-b382-4611-9b65-83ef449df4ea_8d7dcc65-3a0b-476a-b679-574b869780bb-labeled-radio-2" name="d9a9fa1d-b382-4611-9b65-83ef449df4ea_8d7dcc65-3a0b-476a-b679-574b869780bb" class="ashby-application-form-input-radio-group-option-radio">
      </span>
      <label for="d9a9fa1d-b382-4611-9b65-83ef449df4ea_8d7dcc65-3a0b-476a-b679-574b869780bb-labeled-radio-2" class="_label_1258i_42  ashby-application-form-input-radio-group-option-label">Non-Binary</label>
    </div>
  </fieldset>
</div>
`;

let getFieldLabel, getRadioGroupLabel;

beforeAll(() => {
  const src = fs.readFileSync(CONTENT_JS_PATH, 'utf8');
  const startMarker = 'function getFieldLabel(input) {';
  const endMarker = '// ─── Form filling (uses _fieldMap from detection) ────────────';
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  }
  const extracted = src.slice(start, end);
  // eslint-disable-next-line no-eval
  const factory = (0, eval)(`(function () { ${extracted} return { getFieldLabel, getRadioGroupLabel }; })`);
  ({ getFieldLabel, getRadioGroupLabel } = factory());
});

describe('content.js getRadioGroupLabel (AI-facing question_text for radio groups)', () => {
  it('resolves the fieldset question, not the first radio\'s own option label', () => {
    document.body.innerHTML = GENDER_IDENTITY_HTML;
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));

    // The bug: calling the plain single-element resolver on one radio.
    expect(getFieldLabel(radios[0])).toBe('Man');

    // The fix: the group-aware resolver finds the real question instead.
    expect(getRadioGroupLabel(radios)).toBe('What is your gender identity?');
  });

  it('still resolves correctly regardless of which radio in the group is passed first', () => {
    document.body.innerHTML = GENDER_IDENTITY_HTML;
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    expect(getRadioGroupLabel([radios[2], radios[0], radios[1]])).toBe('What is your gender identity?');
  });

  it('falls back to the generic resolver for a radio group with no fieldset/legend structure', () => {
    document.body.innerHTML = `
      <label for="r">Are you willing to relocate?</label>
      <div id="r">
        <input type="radio" name="relocate" value="Yes">
        <input type="radio" name="relocate" value="No">
      </div>
    `;
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    // No fieldset ancestor and no id on the radios — getRadioGroupLabel
    // finds no group container at all, so it falls through to
    // getFieldLabel(radios[0]), which humanizes the shared `name`
    // attribute (its own strategy 6) rather than finding the sibling
    // <label for="r"> (the radios' id-less <div id="r"> wrapper isn't
    // itself a <label>, so no earlier strategy matches it either).
    expect(getRadioGroupLabel(radios)).toBe('relocate');
  });
});
