/**
 * Reads the validation message a form shows under a field and, where the
 * message says plainly what's wrong, rewrites the field's value to satisfy
 * it — what a person does after clicking Next and reading the red text.
 *
 * Confirmed on Paylocity (recruiting.paylocity.com): "Next Step" rejected
 * the profile's "linkedin.com/in/…" with no aria-invalid and no
 * role="alert" — only a `form-error` class on the field's .form-group and a
 * visible footnote: "Must be a valid LinkedIn URL. Example:
 * https://www.linkedin.com/in/yourname". The fix is in the message itself:
 * add the scheme and the "www." its example shows.
 *
 * suggestFixFromErrorMessage() covers the messages that state their rule
 * (URL format, digits only, a length limit, stray spaces in an email);
 * content.js asks the AI for anything else.
 */
(function () {
  'use strict';

  // A class token marking a field's wrapper as failed validation:
  // form-error, has-error, is-invalid, field--error, error, invalid…
  const ERROR_CLASS_TOKEN_RE = /^(?:[\w]*[-_])?(?:error|errors|invalid)(?:[-_][\w-]*)?$/i;
  // The message element inside that wrapper (Paylocity: .type-footnote).
  const MESSAGE_CLASS_RE = /footnote|error|invalid|feedback|help|hint|message|validation/i;
  const FIELD_SELECTOR = 'input:not([type="hidden"]), select, textarea';
  // How far up from the field to look for its error-marked wrapper.
  const MAX_WRAPPER_DEPTH = 4;

  function isVisible(el) {
    return !!el && el.offsetParent !== null;
  }

  function textOf(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function hasErrorClass(el) {
    return Array.from(el.classList || []).some(c => ERROR_CLASS_TOKEN_RE.test(c));
  }

  /**
   * The visible validation message the page shows for this field, or ''.
   * Reads aria-errormessage / aria-describedby, Workday's inputAlert, and
   * — for forms that mark nothing on the field itself — a message inside
   * the field's own error-classed wrapper (one holding no other field).
   * @param {Element} el
   * @returns {string}
   */
  function fieldErrorMessage(el) {
    if (!el || typeof document === 'undefined') return '';
    const ids = [el.getAttribute('aria-errormessage'), el.getAttribute('aria-describedby')]
      .join(' ').split(/\s+/).filter(Boolean);
    for (const id of ids) {
      const d = document.getElementById(id);
      if (d && isVisible(d) && /error|required|invalid|must|enter a valid/i.test(d.textContent || '')) return textOf(d);
    }
    const wdField = el.closest && el.closest('[data-automation-id^="formField-"]');
    const wdAlert = wdField && wdField.querySelector('[data-automation-id="inputAlert"]');
    if (wdAlert && isVisible(wdAlert)) return textOf(wdAlert);

    let node = el.parentElement;
    for (let depth = 0; node && node !== document.body && depth < MAX_WRAPPER_DEPTH; depth++, node = node.parentElement) {
      const fields = Array.from(node.querySelectorAll(FIELD_SELECTOR));
      // A wrapper around several fields is a section, not this field's group.
      if (fields.some(f => f !== el && f.type !== 'radio' && f.type !== 'checkbox')) return '';
      if (!hasErrorClass(node)) continue;
      for (const m of node.querySelectorAll('*')) {
        if (m === el || m.contains(el) || m.tagName === 'LABEL' || m.closest('label')) continue;
        const cls = typeof m.className === 'string' ? m.className : '';
        if (!MESSAGE_CLASS_RE.test(cls) && m.getAttribute('role') !== 'alert') continue;
        if (!isVisible(m)) continue;
        const text = textOf(m);
        if (text) return text;
      }
      return '';
    }
    return '';
  }

  function withExampleUrlShape(candidate, example) {
    let cand, ex;
    try { cand = new URL(candidate); ex = new URL(example); } catch (_) { return candidate; }
    if (ex.hostname === 'www.' + cand.hostname) cand.hostname = ex.hostname;
    if (ex.protocol === 'https:' && cand.protocol === 'http:') cand.protocol = 'https:';
    let out = cand.toString();
    // URL() adds a trailing "/" to a bare host; keep the user's shape.
    if (!/\/$/.test(candidate) && cand.pathname === '/' && !cand.search && !cand.hash) out = out.replace(/\/$/, '');
    return out;
  }

  /**
   * A corrected value when the message spells out the rule the value broke,
   * else null (unknown message, or nothing to change).
   * @param {string} value - what the field holds now
   * @param {string} message - the page's validation message for it
   * @returns {string|null}
   */
  function suggestFixFromErrorMessage(value, message) {
    const original = String(value || '');
    let v = original.trim();
    const msg = String(message || '');
    if (!v || !msg) return null;

    const exampleUrl = (msg.match(/https?:\/\/[^\s"'<>)]+/i) || [])[0];
    const aboutUrl = !!exampleUrl || /\b(url|link|web\s?site|web address)\b|https?:/i.test(msg);
    const aboutEmail = /e-?mail/i.test(msg);
    if (aboutUrl && !aboutEmail) {
      v = v.replace(/\s+/g, '');
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = 'https://' + v.replace(/^\/+/, '');
      if (exampleUrl) v = withExampleUrlShape(v, exampleUrl.replace(/[.,;]+$/, ''));
    } else if (aboutEmail) {
      v = v.replace(/^mailto:/i, '').replace(/\s+/g, '');
    } else if (/\b(only|just)\s+(digits|numbers|numeric)|\bnumeric (characters|values) only|\bmust be (a )?(whole )?number|\bdigits only\b|\bnumbers only\b/i.test(msg)) {
      v = v.replace(/\D/g, '');
      const n = (msg.match(/\b(\d{1,2})\s+digits?\b/i) || [])[1];
      if (n && v.length > +n) v = v.slice(-n);
    }

    const max = (msg.match(/\b(?:maximum|max\.?|no more than|up to|at most|cannot exceed|must not exceed|limit(?:ed)? to)\s+(?:of\s+)?(\d+)\s+char/i)
      || msg.match(/\b(\d+)\s+char(?:acter)?s?\s+or\s+(?:fewer|less)\b/i) || [])[1];
    if (max && v.length > +max) v = v.slice(0, +max).trim();

    return v && v !== original ? v : null;
  }

  const api = { fieldErrorMessage, suggestFixFromErrorMessage };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.JMFieldErrorFix = api;
  }
})();
