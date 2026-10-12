// Paylocity (recruiting.paylocity.com/Recruiting/Jobs/Apply/4569564):
// "Will you now or in the future require visa sponsorship?" was answered
// Yes although the saved Q&A says No. Its question is a <p> INSIDE the
// radios' own .form-group, beside the options — the group-label resolver
// only read <label>/<legend> there (just "Yes"/"No") and siblings outside,
// so it fell back to the first option's label and matched on "Yes".
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIRECT_FILL_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'directFill.js');

beforeAll(async () => {
  await import('../../lib/qaMatch.js');
  await import('../../lib/radioGroupLabel.js');
  await import('../../lib/fieldFilter.js');
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(DIRECT_FILL_PATH, 'utf8'));
});

// Verbatim from the page — "Yes" carries the checked attribute.
const SPONSORSHIP = `
<div class="col-xs-12 editable-interior" style="padding-left: 0px; padding-right: 0px;"><div class="row-float-fill"><div class="col-fluid"><div class="form-group drag-edit toggle toggle-inline padding-bottom-none multi-question"><p><span class="type-semibold">Will you now or in the future require visa sponsorship?
</span> (required)</p><div class="drag-edit-radios"><input id="multiQuestionAnswer1875969_0" name="multiQuestionAnswer1875969" type="radio" checked=""><label class="" for="multiQuestionAnswer1875969_0">Yes</label></div><div class="drag-edit-radios"><input id="multiQuestionAnswer1875969_1" name="multiQuestionAnswer1875969" type="radio"><label class="margin-bottom-22" for="multiQuestionAnswer1875969_1">No</label></div></div></div></div></div>`;

describe('Paylocity screener radio question', () => {
  it('resolves the question from the <p> beside the options', () => {
    document.body.innerHTML = SPONSORSHIP;
    const radios = Array.from(document.getElementsByName('multiQuestionAnswer1875969'));
    expect(globalThis.JMRadioGroupLabel.getRadioGroupLabel(radios, () => 'FALLBACK'))
      .toBe('Will you now or in the future require visa sponsorship?');
  });

  it('picks the saved answer "No", even though "Yes" is pre-checked', async () => {
    document.body.innerHTML = SPONSORSHIP;
    const qaList = [
      { question: 'Are you authorized to work in the United States?', answer: 'Yes' },
      { question: 'Will you now or in the future require visa sponsorship?', answer: 'No' },
    ];
    await window.__jobMatchDirectFill(qaList, {});
    expect(document.getElementById('multiQuestionAnswer1875969_1').checked).toBe(true);
    expect(document.getElementById('multiQuestionAnswer1875969_0').checked).toBe(false);
  });
});
