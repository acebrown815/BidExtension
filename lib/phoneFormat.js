/**
 * Phone-number adjustments applied right before a value is written into a
 * form field — shared by content.js's fillInput() and directFill.js's
 * setNativeInputValue(), so every fill path (saved Q&A/profile, AI answer,
 * the post-fill refill safety net) behaves the same.
 *
 * Workday (*.myworkdayjobs.com) asks for the country code in its own
 * "Country Phone Code" selector right above "Phone Number", and rejects a
 * number that repeats it: a saved profile phone of "+1 720 310 5861" gave
 * "Error: Enter a valid format for Phone Number." When that selector is on
 * the page, the leading country code is dropped from the number.
 */
(function () {
  'use strict';

  /**
   * Is this the main phone-number input (not the extension, device type or
   * country-code part of a phone group)?
   * @param {Element} el
   * @returns {boolean}
   */
  function isPhoneNumberInput(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    const probe = [el.id, el.name, el.getAttribute('data-automation-id'), el.getAttribute('autocomplete'), el.type]
      .filter(Boolean).join(' ');
    if (!/phone|tel/i.test(probe)) return false;
    return !/extension|\bext\b|type|countryphonecode|country.?code|tel-country-code/i.test(probe);
  }

  /**
   * The page's own separate country-code control, if any — Workday's
   * formField-countryPhoneCode multiselect.
   * @returns {Element|null}
   */
  function findCountryCodeField() {
    if (typeof document === 'undefined') return null;
    return document.querySelector('[data-automation-id="formField-countryPhoneCode"]');
  }

  /**
   * The dialing code currently chosen in that control, e.g. "1" from
   * "United States of America (+1)", or '' if none is shown.
   * @param {Element} field
   * @returns {string}
   */
  function selectedDialCode(field) {
    const m = (field.textContent || '').match(/\(\+(\d{1,4})\)/);
    return m ? m[1] : '';
  }

  /**
   * Removes a leading country code from `value` when the form collects the
   * country code separately. "+1 720 310 5861" → "720 310 5861"; also
   * "1-720-310-5861" when the selected code is +1 and the number is one
   * digit too long to be national. A different "+NN" than the selected
   * code is still stripped (the field never accepts a "+"), since the
   * country selector — not this field — carries that information.
   * @param {Element} el
   * @param {string} value
   * @returns {string}
   */
  function adjustPhoneValueForField(el, value) {
    if (typeof value !== 'string' || !value.trim() || !isPhoneNumberInput(el)) return value;
    const field = findCountryCodeField();
    if (!field) return value;
    const trimmed = value.trim();
    const code = selectedDialCode(field);

    const plus = trimmed.match(/^(?:\+|00)\s*\(?(\d{1,4})\)?[\s.-]*(.*)$/);
    if (plus) {
      // "+1 720…" with a known selected code: only strip exactly that code
      // (so "+17203105861" → "7203105861", not "203105861").
      if (code && plus[1].startsWith(code) && plus[1] !== code) {
        return (plus[1].slice(code.length) + plus[2]).trim();
      }
      return plus[2].trim();
    }

    const digits = trimmed.replace(/\D/g, '');
    if (code && digits.startsWith(code) && digits.length > 10) {
      return trimmed.replace(new RegExp('^\\(?' + code + '\\)?[\\s.-]*'), '').trim();
    }
    return value;
  }

  /**
   * A plain number for an <input type="number">, which rejects anything else
   * — confirmed on Ashby ("What is your target compensation?"): the saved
   * answer "140k" was written into it and the field ended up showing "NaN".
   * "140k" → "140000", "$140,000" → "140000", "1.5M" → "1500000", a range
   * "140k – 160k" → its first figure. Returns '' when there's no number in
   * the answer at all (better left empty than NaN). Other inputs: unchanged.
   * @param {Element} el
   * @param {string} value
   * @returns {string}
   */
  function adjustNumberValueForField(el, value) {
    if (!el || (el.type || '').toLowerCase() !== 'number' || typeof value !== 'string') return value;
    const m = value.replace(/,/g, '').match(/(-?\d+(?:\.\d+)?)\s*([kKmM])?\b/);
    if (!m) return '';
    let n = parseFloat(m[1]);
    if (/k/i.test(m[2] || '')) n *= 1000;
    if (/m/i.test(m[2] || '')) n *= 1000000;
    return String(Math.round(n * 100) / 100);
  }

  /** All write-time adjustments (phone country code, number fields). */
  function adjustValueForField(el, value) {
    return adjustNumberValueForField(el, adjustPhoneValueForField(el, value));
  }

  const api = { adjustPhoneValueForField, adjustNumberValueForField, adjustValueForField, isPhoneNumberInput };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.JMPhoneFormat = api;
  }
})();
