// directFill.js has no .mjs mirror or module exports (classic-script
// content script) — loaded via eval, same as content.js relies on the IIFE
// hanging its API on globalThis. Covers getRadioGroupLabel: many ATSs
// (seen on Ashby) give each radio OPTION its own <label for="optionId">
// for the option's visible text (e.g. "Man"), inside a <fieldset> whose
// own <label>/<legend> carries the actual question ("What is your gender
// identity?"). getElementLabel's `label[for]` strategy, called on any one
// radio, always finds that radio's own option label first — so before this
// fix, EVERY radio group with per-option labels (gender, race, veteran
// status, disability, and other EEO-style questions) silently failed to
// match its Q&A entry and was never filled at all.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIRECT_FILL_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'directFill.js');

// The user's real Ashby "What is your gender identity?" field, verbatim.
const GENDER_IDENTITY_HTML = `
<div data-field-path="8d7dcc65-3a0b-476a-b679-574b869780bb" data-field-entry-id="904d23d0-3a50-4c58-829c-741f45e0cf39_8d7dcc65-3a0b-476a-b679-574b869780bb">
  <fieldset class="_container_1258i_28 _fieldEntry_1e3gg_28 ashby-application-form-input-radio-group">
    <label class="_heading_f7cvd_52  _label_1e3gg_42 ashby-application-form-question-title" for="8d7dcc65-3a0b-476a-b679-574b869780bb">What is your gender identity?</label>
    <div class="_option_1258i_34 false ashby-application-form-input-radio-group-option">
      <span class="_container_132c8_28" data-disabled="false"><span class="_circle_132c8_77"></span>
        <input type="radio" id="904d23d0-3a50-4c58-829c-741f45e0cf39_8d7dcc65-3a0b-476a-b679-574b869780bb-labeled-radio-0" name="904d23d0-3a50-4c58-829c-741f45e0cf39_8d7dcc65-3a0b-476a-b679-574b869780bb" class="ashby-application-form-input-radio-group-option-radio">
      </span>
      <label for="904d23d0-3a50-4c58-829c-741f45e0cf39_8d7dcc65-3a0b-476a-b679-574b869780bb-labeled-radio-0" class="_label_1258i_42  ashby-application-form-input-radio-group-option-label">Man</label>
    </div>
    <div class="_option_1258i_34 false ashby-application-form-input-radio-group-option">
      <span class="_container_132c8_28" data-disabled="false"><span class="_circle_132c8_77"></span>
        <input type="radio" id="904d23d0-3a50-4c58-829c-741f45e0cf39_8d7dcc65-3a0b-476a-b679-574b869780bb-labeled-radio-1" name="904d23d0-3a50-4c58-829c-741f45e0cf39_8d7dcc65-3a0b-476a-b679-574b869780bb" class="ashby-application-form-input-radio-group-option-radio">
      </span>
      <label for="904d23d0-3a50-4c58-829c-741f45e0cf39_8d7dcc65-3a0b-476a-b679-574b869780bb-labeled-radio-1" class="_label_1258i_42  ashby-application-form-input-radio-group-option-label">Woman</label>
    </div>
    <div class="_option_1258i_34 false ashby-application-form-input-radio-group-option">
      <span class="_container_132c8_28" data-disabled="false"><span class="_circle_132c8_77"></span>
        <input type="radio" id="904d23d0-3a50-4c58-829c-741f45e0cf39_8d7dcc65-3a0b-476a-b679-574b869780bb-labeled-radio-2" name="904d23d0-3a50-4c58-829c-741f45e0cf39_8d7dcc65-3a0b-476a-b679-574b869780bb" class="ashby-application-form-input-radio-group-option-radio">
      </span>
      <label for="904d23d0-3a50-4c58-829c-741f45e0cf39_8d7dcc65-3a0b-476a-b679-574b869780bb-labeled-radio-2" class="_label_1258i_42  ashby-application-form-input-radio-group-option-label">Non-Binary</label>
    </div>
    <div class="_option_1258i_34 false ashby-application-form-input-radio-group-option">
      <span class="_container_132c8_28" data-disabled="false"><span class="_circle_132c8_77"></span>
        <input type="radio" id="904d23d0-3a50-4c58-829c-741f45e0cf39_8d7dcc65-3a0b-476a-b679-574b869780bb-labeled-radio-3" name="904d23d0-3a50-4c58-829c-741f45e0cf39_8d7dcc65-3a0b-476a-b679-574b869780bb" class="ashby-application-form-input-radio-group-option-radio">
      </span>
      <label for="904d23d0-3a50-4c58-829c-741f45e0cf39_8d7dcc65-3a0b-476a-b679-574b869780bb-labeled-radio-3" class="_label_1258i_42  ashby-application-form-input-radio-group-option-label">Another Gender Identity</label>
    </div>
    <div class="_option_1258i_34 false ashby-application-form-input-radio-group-option">
      <span class="_container_132c8_28" data-disabled="false"><span class="_circle_132c8_77"></span>
        <input type="radio" id="904d23d0-3a50-4c58-829c-741f45e0cf39_8d7dcc65-3a0b-476a-b679-574b869780bb-labeled-radio-4" name="904d23d0-3a50-4c58-829c-741f45e0cf39_8d7dcc65-3a0b-476a-b679-574b869780bb" class="ashby-application-form-input-radio-group-option-radio">
      </span>
      <label for="904d23d0-3a50-4c58-829c-741f45e0cf39_8d7dcc65-3a0b-476a-b679-574b869780bb-labeled-radio-4" class="_label_1258i_42  ashby-application-form-input-radio-group-option-label">I prefer not to answer</label>
    </div>
  </fieldset>
</div>
`;

function loadDirectFill() {
  const src = fs.readFileSync(DIRECT_FILL_PATH, 'utf8');
  // eslint-disable-next-line no-eval
  (0, eval)(src);
}

// Direct access to getRadioGroupLabel (not reachable from outside
// directFill.js's IIFE) via the same source-slice-and-eval technique used
// in contentRadioGroupLabel.test.js — this is what proves the fix works
// via its intended container-detection branch and not merely because the
// end-to-end fill happens to land on the right option anyway.
function loadDirectFillLabelHelpers() {
  const src = fs.readFileSync(DIRECT_FILL_PATH, 'utf8');
  const startMarker = 'function getElementLabel(el) {';
  const endMarker = '// ─── Event simulation';
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('directFill.js source anchors moved — update this test\'s extraction markers');
  }
  const extracted = src.slice(start, end);
  // eslint-disable-next-line no-eval
  const factory = (0, eval)(`(function () { ${extracted} return { getElementLabel, getRadioGroupLabel }; })`);
  return factory();
}

describe('Radio group label resolution (per-option <label for> vs. the group question)', () => {
  beforeEach(() => {
    delete window.__jobMatchDirectFill;
    delete globalThis.JMFieldFilter;
    loadDirectFill();
  });

  it('selects the matching option on a real Ashby gender-identity fieldset', async () => {
    document.body.innerHTML = GENDER_IDENTITY_HTML;
    const qaList = [{ question: 'What is your gender identity?', answer: 'Woman' }];
    const result = await window.__jobMatchDirectFill(qaList, {});

    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    const checked = radios.find(r => r.checked);

    expect(result.filled).toBe(1);
    expect(checked?.labels?.[0]?.textContent).toBe('Woman');
  });

  it('picks "I prefer not to answer" without confusing it for an unmatched field', async () => {
    document.body.innerHTML = GENDER_IDENTITY_HTML;
    const qaList = [{ question: 'What is your gender identity?', answer: 'I prefer not to answer' }];
    await window.__jobMatchDirectFill(qaList, {});

    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    const checked = radios.find(r => r.checked);
    expect(checked?.labels?.[0]?.textContent).toBe('I prefer not to answer');
  });

  it('leaves the group untouched when there is no matching Q&A entry', async () => {
    document.body.innerHTML = GENDER_IDENTITY_HTML;
    const result = await window.__jobMatchDirectFill([{ question: 'Unrelated question', answer: 'Yes' }], {});
    expect(result.filled).toBe(0);
    expect(document.querySelectorAll('input[type="radio"]:checked').length).toBe(0);
  });

  it('still works for a plain radio group with no per-option <label for> (regression check)', async () => {
    document.body.innerHTML = `
      <label for="r">Are you willing to relocate?</label>
      <div id="r">
        <input type="radio" name="relocate" value="Yes"><span>Yes</span>
        <input type="radio" name="relocate" value="No"><span>No</span>
      </div>
    `;
    const qaList = [{ question: 'Are you willing to relocate?', answer: 'Yes' }];
    const result = await window.__jobMatchDirectFill(qaList, {});

    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    expect(result.filled).toBe(1);
    expect(radios.find(r => r.checked)?.value).toBe('Yes');
  });
});

// A fieldset/option-group structure equivalent to GENDER_IDENTITY_HTML but
// with non-numeric option ids and a container class that (deliberately)
// does not contain "field" as a substring. This sidesteps two environment
// quirks that would otherwise muddy a direct test of getRadioGroupLabel:
// (1) happy-dom's querySelector fails to match the CSS.escape()-escaped
// `label[for="\39 04d23d0-..."]` selector getElementLabel's strategy 1
// produces for ids that start with a digit — confirmed directly against
// happy-dom's CSS.escape output — even though real Chrome parses that
// escape correctly and *would* find "Man" there; and (2) getElementLabel's
// strategy 6 (ancestor `[class*="field"]` + first-label-in-DOM-order) can
// accidentally land on the right answer for unrelated reasons when a
// fieldset's class happens to contain "field" (as Ashby's real
// `_fieldEntry_1e3gg_28` class does). Avoiding both means a passing
// assertion here can only be explained by getRadioGroupLabel's own
// container-detection branch actually working.
const CLEAN_FIELDSET_HTML = `
<fieldset class="ashby-application-form-input-radio-group">
  <label for="q1">What is your gender identity?</label>
  <div class="ashby-application-form-input-radio-group-option">
    <input type="radio" id="opt-a" name="grp1">
    <label for="opt-a">Man</label>
  </div>
  <div class="ashby-application-form-input-radio-group-option">
    <input type="radio" id="opt-b" name="grp1">
    <label for="opt-b">Woman</label>
  </div>
  <div class="ashby-application-form-input-radio-group-option">
    <input type="radio" id="opt-c" name="grp1">
    <label for="opt-c">Non-Binary</label>
  </div>
</fieldset>
`;

describe('getRadioGroupLabel (direct access — proves the container-detection branch, not an accidental fallback)', () => {
  it('resolves the fieldset question, not the first radio\'s own option label', () => {
    document.body.innerHTML = CLEAN_FIELDSET_HTML;
    const { getElementLabel, getRadioGroupLabel } = loadDirectFillLabelHelpers();
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));

    // The bug: the plain single-element resolver finds the radio's own
    // per-option label first (label[for="opt-a"] → "Man").
    expect(getElementLabel(radios[0])).toBe('Man');

    // The fix: the group-aware resolver walks up past the per-option
    // wrapper div (skipped because its class ends in "-option") to the
    // real <fieldset> and finds the question label there instead —
    // proven here directly rather than only inferred from end-to-end
    // fill behavior, since a broken container branch that silently falls
    // back to getElementLabel could coincidentally produce the same
    // right answer for other reasons (as it did before this fixture was
    // written to rule that out).
    expect(getRadioGroupLabel(radios)).toBe('What is your gender identity?');
  });

  it('still resolves correctly regardless of which radio in the group is passed first', () => {
    document.body.innerHTML = CLEAN_FIELDSET_HTML;
    const { getRadioGroupLabel } = loadDirectFillLabelHelpers();
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    expect(getRadioGroupLabel([radios[2], radios[0], radios[1]])).toBe('What is your gender identity?');
  });

  it('resolves the real Ashby gender-identity fieldset end-to-end (digit-leading ids included)', () => {
    document.body.innerHTML = GENDER_IDENTITY_HTML;
    const { getRadioGroupLabel } = loadDirectFillLabelHelpers();
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    expect(getRadioGroupLabel(radios)).toBe('What is your gender identity?');
  });

  it('falls back to the generic resolver for a radio group with no fieldset/legend structure', () => {
    document.body.innerHTML = `
      <label for="r">Are you willing to relocate?</label>
      <div id="r">
        <input type="radio" name="relocate" value="Yes">
        <input type="radio" name="relocate" value="No">
      </div>
    `;
    const { getRadioGroupLabel } = loadDirectFillLabelHelpers();
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    // No fieldset ancestor is found at all, so this legitimately falls
    // through to getElementLabel(radios[0]), which humanizes the shared
    // `name` attribute.
    expect(getRadioGroupLabel(radios)).toBe('relocate');
  });
});
