// Regression test for a live bug on Workday (bcbsla.wd1.myworkdayjobs.com,
// "My Information" step): the saved profile phone "+1 720 310 5861" was
// written into "Phone Number" as-is, and Workday rejected it — "Error: Enter a
// valid format for Phone Number." — because the country code is already
// chosen in its own "Country Phone Code" selector right above it.
//
// Markup below is trimmed verbatim from the live page.
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { adjustPhoneValueForField, isPhoneNumberInput } = require(path.join(ROOT, 'lib', 'phoneFormat.js'));

const WORKDAY_PHONE_GROUP = `
  <div role="group" aria-labelledby="Phone-section"><h4 id="Phone-section">Phone</h4>
    <div data-automation-id="formField-phoneType"><label for="phoneNumber--phoneType">Phone Device Type</label>
      <button aria-haspopup="listbox" type="button" value="c705db17b0571036dfffebec73ba929b" name="phoneType" id="phoneNumber--phoneType">Landline</button>
      <input type="text" class="css-77hcv" value="c705db17b0571036dfffebec73ba929b"></div>
    <div data-automation-id="formField-countryPhoneCode"><label for="phoneNumber--countryPhoneCode">Country Phone Code</label>
      <input placeholder="Search" id="phoneNumber--countryPhoneCode" value="United States">
      <div data-automation-id="promptAriaInstruction">1 item selected, United States of America (+1)</div>
      <ul role="listbox" data-automation-id="selectedItemList"><li role="presentation"><div role="option" data-automation-id="selectedItem">
        <p data-automation-id="promptOption" data-automation-label="United States of America (+1)">United States of America (+1)</p></div></li></ul></div>
    <div data-automation-id="formField-phoneNumber"><label for="phoneNumber--phoneNumber">Phone Number</label>
      <input type="text" id="phoneNumber--phoneNumber" name="phoneNumber" aria-required="true" value=""></div>
    <div data-automation-id="formField-extension"><label for="phoneNumber--extension">Phone Extension</label>
      <input type="text" id="phoneNumber--extension" name="extension" value=""></div>
  </div>
`;

describe('adjustPhoneValueForField — Workday with a separate Country Phone Code', () => {
  let phone;
  beforeEach(() => {
    document.body.innerHTML = WORKDAY_PHONE_GROUP;
    phone = document.getElementById('phoneNumber--phoneNumber');
  });

  it('drops the +1 country code from the profile phone (the live failure)', () => {
    expect(adjustPhoneValueForField(phone, '+1 720 310 5861')).toBe('720 310 5861');
  });

  it('handles other common +1 spellings', () => {
    expect(adjustPhoneValueForField(phone, '+1-720-310-5861')).toBe('720-310-5861');
    expect(adjustPhoneValueForField(phone, '+1 (720) 310-5861')).toBe('(720) 310-5861');
    expect(adjustPhoneValueForField(phone, '+17203105861')).toBe('7203105861');
    expect(adjustPhoneValueForField(phone, '1 720 310 5861')).toBe('720 310 5861');
  });

  it('leaves an already-national number alone', () => {
    expect(adjustPhoneValueForField(phone, '720 310 5861')).toBe('720 310 5861');
    expect(adjustPhoneValueForField(phone, '(720) 310-5861')).toBe('(720) 310-5861');
  });

  it('never touches the extension or country-code inputs of the same group', () => {
    expect(isPhoneNumberInput(phone)).toBe(true);
    expect(isPhoneNumberInput(document.getElementById('phoneNumber--extension'))).toBe(false);
    expect(isPhoneNumberInput(document.getElementById('phoneNumber--countryPhoneCode'))).toBe(false);
    expect(adjustPhoneValueForField(document.getElementById('phoneNumber--extension'), '+1 22')).toBe('+1 22');
  });
});

describe('adjustPhoneValueForField — forms without a separate country code', () => {
  it('keeps the full international number', () => {
    document.body.innerHTML = '<label for="tel">Phone</label><input type="tel" id="tel" name="phone">';
    expect(adjustPhoneValueForField(document.getElementById('tel'), '+1 720 310 5861')).toBe('+1 720 310 5861');
  });

  it('ignores non-phone fields entirely', () => {
    document.body.innerHTML = WORKDAY_PHONE_GROUP + '<input type="text" id="city" name="city">';
    expect(adjustPhoneValueForField(document.getElementById('city'), '+1 Main St')).toBe('+1 Main St');
  });
});
