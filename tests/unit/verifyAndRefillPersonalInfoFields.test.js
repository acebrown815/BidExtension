// Regression test for a real, only-partially-diagnosed bug found live on
// a Hireology-hosted careers form: "First name"/"Email address"/"Phone
// number" fields stayed empty across repeated AutoFill runs, while
// sibling fields (city/zip) were inconsistent — filled on one run, empty
// on the next, on the SAME page. That inconsistency is consistent with a
// common ATS pattern: uploading a resume triggers the site's OWN async
// resume-parse-and-autofill feature, which can clear a field back to
// empty (or fail to repopulate it) well after our own fill already ran.
//
// verifyAndRefillPersonalInfoFields() is a safety net: run after a short
// delay, re-fill a small, deliberately narrow set of known personal-info
// fields if they're STILL empty despite matching the profile, and log
// clearly so a live run's console shows whether this is actually what's
// happening.
//
// content.js is too large to load wholesale under happy-dom, so this
// extracts just this function by source range and evals it with small
// stand-ins for its dependencies.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');
const SRC = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

const START_MARKER = 'async function verifyAndRefillPersonalInfoFields() {';
const END_MARKER = '\n  /**\n   * Fills every fillable field on the CURRENT step';
const START = SRC.indexOf(START_MARKER);
const END = SRC.indexOf(END_MARKER);
if (START === -1 || END === -1 || END <= START) {
  throw new Error('content.js source anchors moved — update this test\'s extraction markers');
}
const FN_SRC = SRC.slice(START, END);

function buildHarness({ profile, getFieldLabelImpl, onSleep } = {}) {
  const filledCalls = [];
  const badgedEls = [];
  const factory = new Function( // eslint-disable-line no-new-func
    'profile', 'filledCalls', 'badgedEls', 'getFieldLabelImpl', 'onSleep',
    `
    const _activeResumeId = 'r1';
    let _sleepCallCount = 0;
    async function sleep() { if (onSleep) onSleep(++_sleepCallCount); } // resolves immediately — no real delay in tests
    async function sendMessage(msg) {
      if (msg.type === 'GET_PROFILE') return profile;
      return null;
    }
    function getFieldLabel(el) { return getFieldLabelImpl(el); }
    function fillInput(el, value) { el.value = value; filledCalls.push({ id: el.id, value }); }
    function showAutofillBadge(el) { badgedEls.push(el.id); }
    ${FN_SRC}
    return verifyAndRefillPersonalInfoFields;
    `,
  );
  return { run: factory(profile, filledCalls, badgedEls, getFieldLabelImpl, onSleep), filledCalls, badgedEls };
}

// Labels come straight from each input's own <label for="...">, exactly
// like the real Hireology form's markup.
function getFieldLabelViaDom(el) {
  const label = document.querySelector(`label[for="${el.id}"]`);
  return label ? label.textContent : '';
}

describe('verifyAndRefillPersonalInfoFields — the actual bug (fields cleared after the main fill)', () => {
  const profile = { name: 'Randolph Lee Brown', email: 'brownrandolph07@gmail.com', phone: '+1(720)310-5861' };

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('re-fills first name, last name, email, and phone when still empty, despite "(required)" suffixes', async () => {
    document.body.innerHTML = `
      <input id="first_name-0" type="text" value="">
      <label for="first_name-0">First name (required)</label>
      <input id="last_name-0" type="text" value="">
      <label for="last_name-0">Last name (required)</label>
      <input id="email_address-0" type="email" value="">
      <label for="email_address-0">Email address (required)</label>
      <input id="home_phone-0" type="tel" value="">
      <label for="home_phone-0">Phone number (required)</label>
    `;
    const { run, filledCalls } = buildHarness({ profile, getFieldLabelImpl: getFieldLabelViaDom });
    const recovered = await run();

    expect(recovered).toBe(4);
    expect(document.getElementById('first_name-0').value).toBe('Randolph');
    expect(document.getElementById('last_name-0').value).toBe('Lee Brown');
    expect(document.getElementById('email_address-0').value).toBe('brownrandolph07@gmail.com');
    expect(document.getElementById('home_phone-0').value).toBe('+1(720)310-5861');
    expect(filledCalls).toHaveLength(4);
  });

  it('logs a warning identifying which field was recovered', async () => {
    document.body.innerHTML = '<input id="fn" type="text" value=""><label for="fn">First name</label>';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { run } = buildHarness({ profile, getFieldLabelImpl: getFieldLabelViaDom });
    await run();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('still empty'), 'first name');
    warnSpy.mockRestore();
  });

  it('never overwrites a field that already has a value (no clobbering a user edit)', async () => {
    document.body.innerHTML = `
      <input id="first_name-0" type="text" value="SomeoneElse">
      <label for="first_name-0">First name (required)</label>
    `;
    const { run, filledCalls } = buildHarness({ profile, getFieldLabelImpl: getFieldLabelViaDom });
    const recovered = await run();
    expect(recovered).toBe(0);
    expect(document.getElementById('first_name-0').value).toBe('SomeoneElse');
    expect(filledCalls).toHaveLength(0);
  });

  it('ignores a hidden (offsetParent === null) field', async () => {
    document.body.innerHTML = `
      <input id="first_name-0" type="text" value="">
      <label for="first_name-0">First name (required)</label>
    `;
    // happy-dom doesn't compute layout, so display:none alone doesn't
    // affect offsetParent here the way a real browser would — override
    // it directly to exercise the visibility guard itself.
    Object.defineProperty(document.getElementById('first_name-0'), 'offsetParent', { value: null });
    const { run, filledCalls } = buildHarness({ profile, getFieldLabelImpl: getFieldLabelViaDom });
    const recovered = await run();
    expect(recovered).toBe(0);
    expect(filledCalls).toHaveLength(0);
  });

  it('does nothing for a label that is not one of the known personal-info fields', async () => {
    document.body.innerHTML = `
      <input id="referral_source-0" type="text" value="">
      <label for="referral_source-0">How did you hear about us? (optional)</label>
    `;
    const { run, filledCalls } = buildHarness({ profile, getFieldLabelImpl: getFieldLabelViaDom });
    const recovered = await run();
    expect(recovered).toBe(0);
    expect(filledCalls).toHaveLength(0);
  });

  // Regression for a real bug found live on an Ashby-hosted application
  // form (its own "Autofill from resume" feature clears/re-writes fields
  // asynchronously, well after a single fixed-delay check can catch it —
  // see this function's own doc comment). A single check at 1500ms can
  // itself land mid-clear: it "recovers" the field, but the page's own
  // slower cycle then wipes it out again shortly after. This simulates
  // exactly that — the field gets cleared again between the two checks —
  // and verifies the SECOND pass catches it.
  it('catches a field that gets cleared again between the first and second check', async () => {
    document.body.innerHTML = `
      <input id="first_name-0" type="text" value="">
      <label for="first_name-0">First name</label>
    `;
    const onSleep = (callCount) => {
      if (callCount === 2) {
        // Simulate the page's own slower async cycle wiping out the value
        // our FIRST pass just recovered, right before the second check runs.
        document.getElementById('first_name-0').value = '';
      }
    };
    const { run, filledCalls } = buildHarness({ profile, getFieldLabelImpl: getFieldLabelViaDom, onSleep });
    const recovered = await run();
    expect(recovered).toBe(2); // once per pass
    expect(document.getElementById('first_name-0').value).toBe('Randolph'); // left filled by the second pass
    expect(filledCalls).toHaveLength(2);
  });

  it('does only one pass worth of work when nothing gets cleared again (no regression)', async () => {
    document.body.innerHTML = `
      <input id="first_name-0" type="text" value="">
      <label for="first_name-0">First name</label>
    `;
    const { run, filledCalls } = buildHarness({ profile, getFieldLabelImpl: getFieldLabelViaDom });
    const recovered = await run();
    expect(recovered).toBe(1); // first pass recovers it, second pass sees it's already filled
    expect(filledCalls).toHaveLength(1);
  });

  it('does nothing when the profile itself has no usable value for a field', async () => {
    document.body.innerHTML = `
      <input id="email_address-0" type="email" value="">
      <label for="email_address-0">Email address (required)</label>
    `;
    const { run, filledCalls } = buildHarness({ profile: { name: 'Randolph Lee Brown' }, getFieldLabelImpl: getFieldLabelViaDom });
    const recovered = await run();
    expect(recovered).toBe(0);
    expect(filledCalls).toHaveLength(0);
  });

  it('returns 0 without throwing when there is no profile at all', async () => {
    document.body.innerHTML = '<input id="fn" type="text" value=""><label for="fn">First name</label>';
    const { run, filledCalls } = buildHarness({ profile: null, getFieldLabelImpl: getFieldLabelViaDom });
    const recovered = await run();
    expect(recovered).toBe(0);
    expect(filledCalls).toHaveLength(0);
  });
});
