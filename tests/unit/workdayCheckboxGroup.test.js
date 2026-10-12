// Workday (unisys.wd5.myworkdayjobs.com), Voluntary Self-Identification of
// Disability: "Please check one of the boxes below:" stayed unticked despite
// a saved "Disability status: No, I don't have a disability" answer. The
// three boxes share no name (so they were never one question); ticking one
// disables the others. Markup trimmed verbatim from the live page.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../../lib/fieldFilter.js';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js'), 'utf8').replace(/\r\n/g, '\n');
const slice = (a, b) => {
  const start = SRC.indexOf(a);
  const end = SRC.indexOf(b, start);
  if (start === -1 || end === -1) throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  return SRC.slice(start, end);
};

const OPTIONS = [
  ['64cbff5f364f10000ae7a421cf210000', 'Yes, I have a disability, or have had one in the past'],
  ['64cbff5f364f10000aeec521b4ec0000', 'No, I do not have a disability and have not had one in the past'],
  ['64cbff5f364f10000af3af293a050000', 'I do not want to answer'],
];
const GROUP = (checkedIndex = -1) => `
  <div data-automation-id="formField-disabilityStatus" data-fkit-id="selfIdentifiedDisabilityData--disabilityStatus"><fieldset>
    <legend><label id="label338"><span>Please check one of the boxes below:<abbr aria-hidden="true">*</abbr></span></label></legend>
    <div><span data-automation-id="409600224-rows_3"><fieldset data-automation-id="disabilityStatus-CheckboxGroup" id="selfIdentifiedDisabilityData--disabilityStatus" aria-required="true" aria-describedby="error1-selfIdentifiedDisabilityData--disabilityStatus" ${checkedIndex < 0 ? 'aria-invalid="true"' : ''}>
      <div role="grid">${OPTIONS.map(([id, text], i) => `
        <div role="row"><div role="cell"><div><input id="${id}-disabilityStatus" type="checkbox" aria-checked="${i === checkedIndex}" aria-required="true"${i === checkedIndex ? ' checked' : ''}><span></span></div>
          <label for="${id}-disabilityStatus">${text}</label></div></div>`).join('')}
      </div></fieldset></span></div>
    ${checkedIndex < 0 ? '<div><p id="error1-selfIdentifiedDisabilityData--disabilityStatus" data-automation-id="inputAlert">Error: The field Please check one of the boxes below: is required and must have a value.</p></div>' : ''}
  </fieldset></div>`;

let build;
beforeAll(() => {
  const code = slice('  async function fillWorkdayCheckboxGroups() {', '  /**\n   * Workday "My Experience" step');
  build = (env) => new Function('env', ` // eslint-disable-line no-new-func
    const _activeResumeId = 'r1';
    const CHOICE_CLICK_PACE_MS = 0;
    const sleep = () => Promise.resolve();
    const console = { info: () => {}, warn: () => {} };
    const isWorkdayHost = () => true;
    const fieldShowsError = (el) => globalThis.JMFieldFilter.fieldShowsError(el);
    const getWorkdayFieldLabel = () => '';
    function showAutofillBadge() {}
    async function sendMessage(msg) { env.asked.push(msg); return env.pick(msg); }
    function clickNatively(el) {
      // Workday: ticking one box disables the others.
      el.checked = true; el.setAttribute('aria-checked', 'true');
      el.closest('fieldset').querySelectorAll('input[type="checkbox"]').forEach(b => { if (b !== el) b.disabled = true; });
    }
    ${code}
    return fillWorkdayCheckboxGroups;
  `)(env);
});

let env;
let rectSpy;
beforeEach(() => {
  env = { asked: [], pick: (msg) => msg.options.find(o => /^No,/.test(o)) };
  rectSpy = Element.prototype.getClientRects;
  Element.prototype.getClientRects = () => [{ width: 1, height: 1 }];
});
afterEach(() => { Element.prototype.getClientRects = rectSpy; document.body.innerHTML = ''; });

const box = (i) => document.getElementById(OPTIONS[i][0] + '-disabilityStatus');

describe('fillWorkdayCheckboxGroups', () => {
  it('asks once with the question and all three labels, and ticks only "No"', async () => {
    document.body.innerHTML = GROUP();
    expect(await build(env)()).toBe(1);
    expect(env.asked).toHaveLength(1);
    expect(env.asked[0].questionText).toBe('Please check one of the boxes below: (disability status)');
    expect(env.asked[0].options).toEqual(OPTIONS.map(o => o[1]));
    expect([0, 1, 2].map(i => box(i).checked)).toEqual([false, true, false]);
  });

  it('marks the group so the generic passes leave its boxes alone', async () => {
    document.body.innerHTML = GROUP();
    await build(env)();
    expect(globalThis.JMFieldFilter.isFieldEligible(box(0))).toBe(false);
  });

  it('leaves a group that already has a box ticked', async () => {
    document.body.innerHTML = GROUP(2);
    expect(await build(env)()).toBe(0);
    expect(env.asked).toHaveLength(0);
    expect(box(1).checked).toBe(false);
  });

  it('ticks nothing when the matcher has no answer', async () => {
    document.body.innerHTML = GROUP();
    env.pick = () => null;
    expect(await build(env)()).toBe(0);
    expect([0, 1, 2].some(i => box(i).checked)).toBe(false);
  });
});
