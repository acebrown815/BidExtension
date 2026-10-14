/**
 * Reference sections of an application ("Reference 1": Name, Email
 * Address, Phone Number, Personal or Work Reference?, Years Known) — the
 * people who can vouch for the applicant, not the applicant.
 *
 * Confirmed on Paylocity (recruiting.paylocity.com): each "Reference N"
 * block's fields are labelled just "Name" / "Email Address" / "Phone
 * Number", so every pass treated them as the applicant's own and filled the
 * user's name, email and phone into all three references. The answers are
 * in the user's saved Q&A instead ("Reference 1 Name", "First reference –
 * phone"…), matched here by reference number and kind of field rather than
 * wording.
 *
 * Loaded as a content script before directFill.js and content.js; hangs
 * its API on globalThis.JMReferenceFields.
 */
(function () {
  'use strict';

  // "Reference 1", "Reference #2", "Professional Reference 3" — not the
  // section title "References".
  const HEADING_RE = /^\s*(?:professional\s+|personal\s+|work\s+)?reference\s*#?\s*(\d+)?\b/i;
  const HEADING_SELECTOR = '.section-heading, h1, h2, h3, h4, h5, h6, legend';
  const ORDINALS = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5 };

  /**
   * Is this field part of a "Reference N" block — and which one?
   * By the nearest "Reference N" heading above it, else by its own id/name
   * ("references.name.0" → Reference 1).
   * @param {Element} el
   * @returns {{index: number, label: string}|null}
   */
  function referenceContext(el) {
    if (!el || !el.closest || typeof document === 'undefined') return null;
    let index = null;
    let found = false;
    let node = el.parentElement;
    for (let depth = 0; node && node !== document.body && depth < 8 && !found; depth++, node = node.parentElement) {
      // The last matching heading that comes before the field.
      for (const h of node.querySelectorAll(HEADING_SELECTOR)) {
        if (h.contains(el) || !(h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        const text = (h.textContent || '').trim();
        const m = text.length < 40 && text.match(HEADING_RE);
        if (m) { found = true; index = m[1] ? +m[1] : index; }
      }
    }
    const attrs = [el.id, el.getAttribute('name'), el.getAttribute('data-automation-id')].filter(Boolean).join(' ');
    if (!found && /reference/i.test(attrs)) {
      found = true;
      const n = attrs.match(/(\d+)\D*$/);
      if (n) index = +n[1] + 1; // ids count from 0
    }
    if (!found) return null;
    if (!index) index = 1;
    return { index, label: `Reference ${index}` };
  }

  /**
   * What a reference field (or a saved question about one) asks for.
   * @param {string} text
   * @returns {string|null}
   */
  function referenceFieldKind(text) {
    const t = String(text || '').toLowerCase().replace(/references?/g, ' ');
    if (/e-?mail/.test(t)) return 'email';
    if (/phone|mobile|telephone|\bcell\b/.test(t)) return 'phone';
    if (/compan|employer|organi[sz]ation|business/.test(t)) return 'company';
    if (/years?\s+known|how long|\byears\b/.test(t)) return 'yearsKnown';
    if (/relationship|personal or (?:work|professional)|\btype\b|how do you know/.test(t)) return 'relationship';
    if (/\btitle\b|position|\bjob\b|\brole\b/.test(t)) return 'title';
    if (/first\s*name/.test(t)) return 'firstName';
    if (/last\s*name|surname/.test(t)) return 'lastName';
    if (/\bname\b/.test(t)) return 'name';
    return null;
  }

  /** "Reference 2 …" / "Second reference …" → 2; no number → null. */
  function referenceIndexOf(text) {
    const s = String(text || '').toLowerCase();
    const n = s.match(/reference\s*#?\s*(\d+)/) || s.match(/(\d+)\s*(?:st|nd|rd|th)?\s+reference/);
    if (n) return +n[1];
    const o = s.match(/\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th)\b/);
    return o ? ORDINALS[o[1]] : null;
  }

  /**
   * The saved answer for reference `index`'s field `label` — an entry for
   * that reference number first, else one with no number (used for any
   * reference). A first/last name field falls back to the saved full name.
   * @param {Array<{question: string, answer: string}>} qaList
   * @param {number} index
   * @param {string} label - the field's own label ("Name", "Phone Number")
   * @returns {string|null}
   */
  function referenceAnswer(qaList, index, label) {
    const kind = referenceFieldKind(label);
    if (!kind) return null;
    const find = (k) => {
      let unnumbered = null;
      for (const qa of qaList || []) {
        if (!qa || !qa.answer || !String(qa.answer).trim() || !/reference/i.test(qa.question || '')) continue;
        if (referenceFieldKind(qa.question) !== k) continue;
        const qi = referenceIndexOf(qa.question);
        if (qi === index) return String(qa.answer).trim();
        if (qi == null && unnumbered == null) unnumbered = String(qa.answer).trim();
      }
      return unnumbered;
    };
    const direct = find(kind);
    if (direct) return direct;
    if (kind === 'firstName' || kind === 'lastName') {
      const full = find('name');
      if (full) {
        const parts = full.split(/\s+/);
        return kind === 'firstName' ? parts[0] : parts.slice(1).join(' ') || null;
      }
    }
    return null;
  }

  /**
   * A field's label with its reference block in front ("Reference 1 Name"),
   * when it is in one and the label doesn't already say so.
   * @param {Element} el
   * @param {string} label
   * @returns {string}
   */
  function withReferencePrefix(el, label) {
    if (!label || /reference/i.test(label)) return label;
    const ctx = referenceContext(el);
    return ctx ? `${ctx.label} ${label}` : label;
  }

  const api = { referenceContext, referenceFieldKind, referenceIndexOf, referenceAnswer, withReferencePrefix };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.JMReferenceFields = api;
  }
})();
