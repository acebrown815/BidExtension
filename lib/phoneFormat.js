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

  // ── Date fields ──────────────────────────────────────────────────────
  // A date box takes ONE format — its own — and erases anything else on
  // blur. Confirmed on Paylocity's "Available to Start"
  // (<div format="MM/dd/yyyy"> around <input placeholder="MM/DD/YYYY">):
  // answers written in another shape ("2 weeks", "2026-10-16") were erased
  // and the field stayed empty and required.

  const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  /**
   * The date format a field expects, as tokens (yyyy, yy, MM, M, dd, d),
   * or null when it isn't a date field: type="date" → "yyyy-MM-dd"; else a
   * format attribute on the field or a wrapper (format, data-format,
   * data-date-format); else a placeholder like "MM/DD/YYYY".
   * @param {Element} el
   * @returns {string|null}
   */
  function dateFormatForField(el) {
    if (!el || el.tagName !== 'INPUT') return null;
    if ((el.type || '').toLowerCase() === 'date') return 'yyyy-MM-dd';
    const isDateFormat = (f) => !!f && /y/i.test(f) && /d/i.test(f) && /m/i.test(f) && /^[ymd\/.\- ]+$/i.test(f.trim());
    let node = el;
    for (let i = 0; i < 5 && node && node.getAttribute; i++, node = node.parentElement) {
      for (const attr of ['format', 'data-format', 'data-date-format']) {
        const f = node.getAttribute(attr);
        if (isDateFormat(f)) return f.trim().replace(/Y/g, 'y').replace(/D/g, 'd');
      }
    }
    const ph = (el.getAttribute('placeholder') || '').trim();
    if (/^(mm|dd|yyyy|m|d|yy)([\/.\- ])(mm|dd|m|d)\2(yyyy|yy|mm|dd)$/i.test(ph) || /^yyyy([\/.\- ])mm\1dd$/i.test(ph)) {
      return ph.replace(/y/gi, 'y').replace(/d/gi, 'd').replace(/m/gi, 'M');
    }
    return null;
  }

  /**
   * Reads a date out of an answer: ISO "2026-10-16"; "10/16/2026" (or
   * "16/10/2026" for a day-first format, or when the first number can't be
   * a month); "October 16, 2026" / "16 Oct 2026"; or a relative answer —
   * "immediately", "ASAP", "2 weeks", "10 days", "1 month" — from today.
   * @param {string} text
   * @param {boolean} dayFirst
   * @param {Date} [today]
   * @returns {Date|null}
   */
  function parseDateAnswer(text, dayFirst, today) {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return null;
    const now = today ? new Date(today.getTime()) : new Date();
    const make = (y, m, d) => {
      if (y < 100) y += 2000;
      const date = new Date(y, m - 1, d);
      return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? date : null;
    };
    let m = t.match(/^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})$/);
    if (m) return make(+m[1], +m[2], +m[3]);
    m = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/);
    if (m) {
      let [a, b] = [+m[1], +m[2]];
      if (dayFirst ? b <= 12 : a <= 12) return dayFirst ? make(+m[3], b, a) : make(+m[3], a, b);
      return dayFirst ? make(+m[3], a, b) : make(+m[3], b, a);
    }
    m = t.match(/^([a-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/) || null;
    if (m && MONTH_NAMES.indexOf(m[1].slice(0, 3)) >= 0) return make(+m[3], MONTH_NAMES.indexOf(m[1].slice(0, 3)) + 1, +m[2]);
    m = t.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,})\.?,?\s+(\d{4})$/);
    if (m && MONTH_NAMES.indexOf(m[2].slice(0, 3)) >= 0) return make(+m[3], MONTH_NAMES.indexOf(m[2].slice(0, 3)) + 1, +m[1]);
    if (/^(immediately|asap|as soon as possible|now|today|right away)\b/.test(t)) return now;
    m = t.match(/\b(\d+|one|two|three|four|six)\s*(day|week|month)s?\b/);
    if (m) {
      const words = { one: 1, two: 2, three: 3, four: 4, six: 6 };
      const n = words[m[1]] || +m[1];
      if (m[2] === 'month') now.setMonth(now.getMonth() + n);
      else now.setDate(now.getDate() + n * (m[2] === 'week' ? 7 : 1));
      return now;
    }
    return null;
  }

  /** `date` in a token format ("MM/dd/yyyy" → "10/16/2026"). */
  function formatDate(date, format) {
    const pad = (n) => String(n).padStart(2, '0');
    return format.replace(/yyyy|yy|MM|M|dd|d/g, (tok) => ({
      yyyy: String(date.getFullYear()),
      yy: String(date.getFullYear()).slice(-2),
      MM: pad(date.getMonth() + 1),
      M: String(date.getMonth() + 1),
      dd: pad(date.getDate()),
      d: String(date.getDate()),
    })[tok]);
  }

  /**
   * A date field gets its answer in its own format; an answer with no date
   * in it gives '' (left empty rather than written and erased). Other
   * fields: unchanged.
   * @param {Element} el
   * @param {string} value
   * @returns {string}
   */
  function adjustDateValueForField(el, value) {
    const format = dateFormatForField(el);
    if (!format || typeof value !== 'string' || !value.trim()) return value;
    const date = parseDateAnswer(value, /^d/i.test(format));
    return date ? formatDate(date, format) : '';
  }

  /** All write-time adjustments (phone country code, number fields, dates). */
  function adjustValueForField(el, value) {
    return adjustDateValueForField(el, adjustNumberValueForField(el, adjustPhoneValueForField(el, value)));
  }

  const api = {
    adjustPhoneValueForField, adjustNumberValueForField, adjustDateValueForField, adjustValueForField,
    isPhoneNumberInput, dateFormatForField, parseDateAnswer, formatDate,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.JMPhoneFormat = api;
  }
})();
