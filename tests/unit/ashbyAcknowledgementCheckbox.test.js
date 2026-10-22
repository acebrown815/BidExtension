// Ashby (jobs.ashbyhq.com/1password): a required one-option checkbox group
// — heading "I understand that 1Password offers of employment are
// conditional on satisfactory completion of a background check.", box
// labelled "I understand" — was never ticked. The AI was asked only "I
// understand", not required (Ashby marks it required with a class on the
// heading), and the consent-box tick didn't know "understand".
//
// content.js isn't practical to load wholesale under happy-dom, so the
// pieces are extracted by source range (see ashbyYesNoToggleAiPath.test.js).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js'), 'utf8').replace(/\r\n/g, '\n');
function sliceBetween(startMarker, endMarker) {
  const start = SRC.indexOf(startMarker);
  const end = SRC.indexOf(endMarker, start);
  if (start === -1 || end === -1) throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  return SRC.slice(start, end);
}

let api;
beforeAll(() => {
  const consent = sliceBetween('  const CONSENT_MESSAGE_RE', '  /**\n   * Ticks every visible');
  const pass4 = sliceBetween('// ── 4. Standalone checkboxes ──', '// ── 5. Resume');
  api = new Function( // eslint-disable-line no-new-func
    `
    const isFieldEligible = () => true;
    const shouldKeepExistingAnswer = (el) => el.checked;
    const labelTextWithoutBadges = (l) => l.textContent;
    const getFieldLabel = (el) => { const l = el.id && document.querySelector('label[for="' + el.id + '"]'); return l ? l.textContent.trim() : ''; };
    const getRadioLabel = () => '';
    ${consent}
    function detect() {
      const seen = new Set(); const questions = []; const _fieldMap = {}; let qIndex = 0;
      ${pass4}
      return questions;
    }
    return { detect, isRequiredConsentBox };
    `,
  )();
});

const FIELD = `
<div data-field-path="db191313-e0df-417f-90ac-25c894a92476"><fieldset class="_container_1258i_28 _fieldEntry_1e3gg_28 ashby-application-form-input-checkbox-group"><label class="_heading_f7cvd_52 _required_f7cvd_91 _label_1e3gg_42 ashby-application-form-question-title" for="db191313-e0df-417f-90ac-25c894a92476">I understand that 1Password offers of employment are conditional on satisfactory completion of a background check.</label><div class="_option_1258i_34 ashby-application-form-input-checkbox-group-option"><span class="ashby-application-form-input-checkbox-group-option-checkbox _container_1danv_28" data-disabled="false"><input type="checkbox" id="cb-ack-0" name="I understand"></span><label for="cb-ack-0" class="_label_1258i_42  ashby-application-form-input-checkbox-group-option-label">I understand</label></div></fieldset></div>
<div data-field-path="9fac80b8"><fieldset class="ashby-application-form-input-checkbox-group"><label class="_heading_f7cvd_52  _label_1e3gg_42 ashby-application-form-question-title" for="9fac80b8">Interested in learning more about exciting careers at 1Password? Check this box to sign up.</label><div><span><input type="checkbox" id="cb-news-0" name=" Yes"></span><label for="cb-news-0"> Yes</label></div></fieldset></div>`;

beforeEach(() => {
  document.body.innerHTML = FIELD;
  for (const cb of document.querySelectorAll('input')) Object.defineProperty(cb, 'offsetParent', { get: () => document.body });
});

describe('Ashby one-option acknowledgement checkbox', () => {
  it('asks the AI the heading\'s question, marked required', () => {
    const [ack, news] = api.detect();
    expect(ack).toMatchObject({
      question_id: 'cb-ack-0',
      question_text: 'I understand that 1Password offers of employment are conditional on satisfactory completion of a background check. — I understand',
      field_type: 'checkbox',
      required: true,
    });
    expect(news.required).toBe(false);
  });

  it('never takes another field\'s label in a shared fieldset as the box\'s question', () => {
    document.body.innerHTML = `<fieldset>
      <label class="required" for="fn">First name *</label><input id="fn">
      <input type="checkbox" id="sms"><label for="sms">I agree to receive SMS updates</label></fieldset>`;
    for (const el of document.querySelectorAll('input')) Object.defineProperty(el, 'offsetParent', { get: () => document.body });
    expect(api.detect()).toMatchObject([{ question_text: 'I agree to receive SMS updates', required: false }]);
    expect(api.isRequiredConsentBox(document.getElementById('sms'))).toBe(false);
  });

  it('is a required consent box (ticked before Auto-Bid submits) — the optional newsletter box is not', () => {
    expect(api.isRequiredConsentBox(document.getElementById('cb-ack-0'))).toBe(true);
    expect(api.isRequiredConsentBox(document.getElementById('cb-news-0'))).toBe(false);
  });
});
