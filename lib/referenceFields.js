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

  // What a one-box reference question asks for, in the order it lists them
  // ("…your first professional reference: Name, Job Title, Company,
  // Professional Relationship, Phone Number, Email Address").
  const KIND_PATTERNS = [
    ['email', /e-?mail/],
    ['phone', /phone|mobile|telephone|\bcell\b/],
    ['company', /compan|employer|organi[sz]ation/],
    ['yearsKnown', /years?\s+known|how long/],
    ['relationship', /relationship/],
    ['title', /\btitle\b|position/],
    ['name', /\bname\b/],
  ];
  const EMAIL_RE = /[^\s|,;<>()]+@[^\s|,;<>()]+\.[a-z]{2,}/i;
  const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/;

  /** The kinds of reference detail `label` asks for, in its own order. */
  function askedKinds(label) {
    const t = String(label || '').toLowerCase().replace(/references?/g, ' ');
    return KIND_PATTERNS
      .map(([kind, re]) => { const m = t.match(re); return m ? { kind, at: m.index } : null; })
      .filter(Boolean)
      .sort((a, b) => a.at - b.at)
      .map(k => k.kind);
  }

  /**
   * One reference written as a block of lines in a single saved answer:
   * "yang.pulse@reconnect.io / Yang Pulse / Full Stack Developer at
   * Reconnect.io", or "Name: …" / "Phone: …" lines.
   * @param {string} text
   * @returns {Object<string,string>}
   */
  function parseReferenceBlock(text) {
    const rec = {};
    for (const raw of String(text || '').split(/\n|\s\|\s/)) {
      // A list marker ("1.", "-", "•") — not a phone number's leading digits.
      const line = raw.replace(/^\s*(?:[-•*]|\d{1,2}[.)])\s+/, '').trim();
      if (!line) continue;
      const kv = line.match(/^([^:]{2,30}):\s*(.+)$/);
      const kvKind = kv && !/^https?$/i.test(kv[1]) && referenceFieldKind(kv[1]);
      if (kvKind) { rec[kvKind === 'firstName' || kvKind === 'lastName' ? 'name' : kvKind] ||= kv[2].trim(); continue; }
      const email = line.match(EMAIL_RE);
      if (email) { rec.email ||= email[0]; continue; }
      if (PHONE_RE.test(line) && !/[a-z]{3}/i.test(line.replace(/ext\.?/i, ''))) { rec.phone ||= line; continue; }
      const at = line.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
      if (at && rec.name) { rec.title ||= at[1].trim(); rec.company ||= at[2].trim(); continue; }
      if (!rec.name) rec.name = line;
      else if (!rec.title) rec.title = line;
      else if (!rec.company) rec.company = line;
    }
    return rec;
  }

  /**
   * The answer for one box that asks for a whole reference at once (Workday
   * "Please provide the following information for your first professional
   * reference: Name, Job Title, Company, … Phone Number, Email Address").
   * Built only from the saved reference Q&A — per-field entries
   * ("Reference 1 Email") or a block answer listing the references one
   * after another, separated by a blank line — and never from the
   * applicant's own details: a part with no saved answer is left out.
   * @param {Array<{question: string, answer: string}>} qaList
   * @param {string} label
   * @returns {{answer: string|null}|null} null when the label is not such a question
   */
  function combinedReferenceAnswer(qaList, label) {
    if (!/\breferences?\b/i.test(label || '')) return null;
    const kinds = askedKinds(label);
    if (kinds.length < 2) return null;
    const index = referenceIndexOf(label) || 1;

    const rec = {};
    for (const kind of kinds) {
      const v = referenceAnswer(qaList, index, kind === 'yearsKnown' ? 'years known' : kind);
      if (v) rec[kind] = v;
    }
    // Saved answers holding whole references ("Professional Reference" →
    // one block per reference).
    let savedType = '';
    for (const qa of qaList || []) {
      if (!qa || !qa.answer || !/reference/i.test(qa.question || '') || referenceFieldKind(qa.question)) continue;
      const blocks = String(qa.answer).split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
      const qi = referenceIndexOf(qa.question);
      const block = qi ? (qi === index && blocks.length === 1 ? blocks[0] : null) : blocks[index - 1];
      if (!block) continue;
      const parsed = parseReferenceBlock(block);
      for (const k of Object.keys(parsed)) rec[k] ||= parsed[k];
      const type = (qa.question.match(/\b(professional|personal|work)\b/i) || [])[1];
      if (type && !savedType) savedType = type;
      break;
    }
    if (!rec.relationship && (rec.name || rec.email)) {
      const type = savedType || (String(label).match(/\b(professional|personal|work)\s+reference/i) || [])[1];
      if (type) rec.relationship = `${type[0].toUpperCase()}${type.slice(1).toLowerCase()} reference`;
    }

    const parts = kinds.map(k => rec[k]).filter(Boolean);
    return { answer: rec.name || rec.email || rec.phone ? parts.join(' | ') : null };
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

  const api = { referenceContext, referenceFieldKind, referenceIndexOf, referenceAnswer, combinedReferenceAnswer, withReferencePrefix };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.JMReferenceFields = api;
  }
})();
