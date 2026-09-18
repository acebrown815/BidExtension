// Regression test for a live bug on a Dover (MUI-based) job application
// form: the group's question text ("Will you need sponsorship?") is a
// plain sibling <div> OUTSIDE the role="radiogroup" container entirely —
//
//   <div class="css-l5c1s3">
//     <div class="...FormLabel...">Will you need sponsorship? *</div>
//     <div class="MuiFormControl-root ...">
//       <div class="MuiFormGroup-root ..." role="radiogroup">
//         <label><input type="radio" value="Yes">...Yes</label>
//         <label><input type="radio" value="No">...No</label>
//       </div>
//     </div>
//   </div>
//
// Neither <label> here has a `for` attribute, and both wrap their own
// radio directly, so getRadioGroupLabel()'s search for a label/legend
// INSIDE the radiogroup correctly finds nothing usable — but there's no
// group-level <label>/<legend> anywhere in that subtree either. Before this
// fix, that fell through to a single-element resolver whose "closest
// wrapping <label>" strategy picked up the FIRST OPTION's own label
// ("Yes") as if it were the whole group's question — confirmed live: the
// AI-facing question_text sent to OpenAI was literally the string "Yes",
// with no way for the AI (or Pass 1's Q&A matcher) to know the field was
// about sponsorship at all, making a correct answer impossible regardless
// of Q&A matching quality.
import { describe, it, expect, beforeAll } from 'vitest';

let getRadioGroupLabel;
beforeAll(async () => {
  await import('../../lib/radioGroupLabel.js');
  getRadioGroupLabel = globalThis.JMRadioGroupLabel.getRadioGroupLabel;
});

const dummyFallback = () => 'FALLBACK_SHOULD_NOT_BE_USED';

function radiosFromDom() {
  return Array.from(document.querySelectorAll('input[type="radio"]'));
}

describe('getRadioGroupLabel — MUI-style sibling-heading structure (the real Dover bug)', () => {
  it('resolves the sibling heading div, not the first option\'s own "Yes" label', () => {
    document.body.innerHTML = `
      <div class="css-l5c1s3">
        <div class="typography__FormLabel">Will you need sponsorship? *</div>
        <div class="MuiFormControl-root">
          <div class="MuiFormGroup-root" role="radiogroup">
            <label class="MuiFormControlLabel-root"><span class="MuiButtonBase-root"><input type="radio" name="sponsorship" value="Yes"></span><span>Yes</span></label>
            <label class="MuiFormControlLabel-root"><span class="MuiButtonBase-root"><input type="radio" name="sponsorship" value="No"></span><span>No</span></label>
          </div>
        </div>
      </div>
    `;
    const label = getRadioGroupLabel(radiosFromDom(), dummyFallback);
    expect(label).toBe('Will you need sponsorship? *');
    expect(label).not.toBe('Yes');
  });

  it('works the same regardless of which radio in the group is passed first', () => {
    document.body.innerHTML = `
      <div class="css-l5c1s3">
        <div class="typography__FormLabel">Have you used Portfolio ++ to track your work effort? *</div>
        <div class="MuiFormControl-root">
          <div class="MuiFormGroup-root" role="radiogroup">
            <label class="MuiFormControlLabel-root"><span class="MuiButtonBase-root"><input type="radio" name="portfolio" value="Yes"></span><span>Yes</span></label>
            <label class="MuiFormControlLabel-root"><span class="MuiButtonBase-root"><input type="radio" name="portfolio" value="No"></span><span>No</span></label>
          </div>
        </div>
      </div>
    `;
    const radios = radiosFromDom().reverse(); // "No" radio first this time
    expect(getRadioGroupLabel(radios, dummyFallback)).toBe('Have you used Portfolio ++ to track your work effort? *');
  });

  it('does not wander past 3 ancestor levels into unrelated page content', () => {
    document.body.innerHTML = `
      <div>Unrelated page heading far above</div>
      <div><div><div><div>
        <div class="MuiFormControl-root">
          <div class="MuiFormGroup-root" role="radiogroup">
            <label><input type="radio" name="deep" value="Yes"><span>Yes</span></label>
            <label><input type="radio" name="deep" value="No"><span>No</span></label>
          </div>
        </div>
      </div></div></div></div>
    `;
    // No heading within 3 levels of the radiogroup — falls back rather
    // than reaching all the way up to the unrelated top-level heading.
    expect(getRadioGroupLabel(radiosFromDom(), dummyFallback)).toBe('FALLBACK_SHOULD_NOT_BE_USED');
  });
});

describe('getRadioGroupLabel — Ashby-style label/legend inside the container (regression check)', () => {
  it('still resolves the fieldset\'s own question label, unaffected by the new sibling-walk step', () => {
    document.body.innerHTML = `
      <fieldset class="ashby-application-form-input-radio-group">
        <label for="q1">What is your gender identity?</label>
        <div class="ashby-application-form-input-radio-group-option">
          <input type="radio" id="opt-a" name="gender">
          <label for="opt-a">Man</label>
        </div>
        <div class="ashby-application-form-input-radio-group-option">
          <input type="radio" id="opt-b" name="gender">
          <label for="opt-b">Woman</label>
        </div>
      </fieldset>
    `;
    expect(getRadioGroupLabel(radiosFromDom(), dummyFallback)).toBe('What is your gender identity?');
  });
});

describe('getRadioGroupLabel — no group structure at all', () => {
  it('falls back to the provided single-element resolver', () => {
    document.body.innerHTML = `<input type="radio" name="lone" aria-label="Lone radio, no group markup">`;
    expect(getRadioGroupLabel(radiosFromDom(), dummyFallback)).toBe('FALLBACK_SHOULD_NOT_BE_USED');
  });
});
