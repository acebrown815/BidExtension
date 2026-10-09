/**
 * Field-name allowlist for the autofill pipeline (C3b).
 *
 * Two threats this defends against:
 *  1. A page (or AI prompt-injection) coaxes the autofill loop into writing
 *     into a CSRF / token / tracking field, leaking session data or
 *     stamping the form with attacker-chosen identifiers.
 *  2. A page exposes a field whose name suggests it stores something
 *     sensitive (honeypot, _internal, etc.) — we don't want to send it
 *     to the AI either, which means it never appears as a candidate.
 *
 * Loaded as a content script before content.js — hangs the API on
 * globalThis so content scripts in the same isolated world can use it,
 * and tests can `import './lib/fieldFilter.js'` and read globalThis.
 *
 * Mirrored at lib/fieldFilter.mjs for the service worker / tests; a
 * parity test keeps the two copies in sync.
 */
(function () {
  'use strict';

  // Substrings that disqualify a field (case-insensitive). Matched against
  // the field's id, name, and any data-testid.
  const SENSITIVE_PATTERNS = [
    'csrf', 'xsrf', 'nonce', 'antiforgery', 'authenticity',
    '_token', 'csrftoken', 'csrfmiddlewaretoken', 'authtoken',
    'session_id', 'sessionid', 'sessiontoken',
    'tracking', 'utm_', 'gclid', 'fbclid',
    'honeypot', 'leave_blank', 'do_not_fill',
    'recaptcha', 'g-recaptcha', 'h-captcha', 'hcaptcha', 'turnstile',
  ];

  // Exact name/id matches that disqualify a field. Some frameworks use
  // these for internal bookkeeping (e.g. Django/Rails CSRF token name).
  const SENSITIVE_EXACT = new Set([
    '_csrf', '__csrf', '__rvt', '__viewstate', '__eventvalidation',
    'authenticity_token', 'csrf_token', 'csrftoken',
    'utf8', '_method',
  ]);

  /**
   * @param {string} name - The field's id, name, or data-testid.
   * @returns {boolean} true if this field should never be autofilled.
   */
  function isSensitiveFieldName(name) {
    if (!name || typeof name !== 'string') return false;
    const lower = name.toLowerCase();
    if (SENSITIVE_EXACT.has(lower)) return true;
    // Known ATS "system field" naming conventions are legitimate, core
    // application fields even though they happen to start with an
    // underscore — never treat these as internal/CSRF-y. Seen on Ashby,
    // whose apply forms name every built-in field `_systemfield_*`
    // (`_systemfield_name`, `_systemfield_email`, `_systemfield_resume`,
    // `_systemfield_eeoc_gender`, ...). Without this carve-out the generic
    // underscore-prefix heuristic below excludes every field on the form,
    // including Name/Email/Resume, and autofill silently finds nothing.
    if (/^_systemfield_/.test(lower)) return false;
    // React 19's useId() generates ids like `_R_12jav5ubtb_` (server) or
    // `_r_1a_` (client), which form libraries (shadcn/ui, react-hook-form)
    // then suffix — `_R_12jav5ubtb_-form-item`. Every field on such a form
    // carries one, so without this the underscore heuristic below excluded
    // the whole form (seen on xyzai.io: "No form fields found on this page").
    // Still subject to the substring patterns below.
    if (/^_r_[a-z0-9]+_/.test(lower)) return SENSITIVE_PATTERNS.some(p => lower.includes(p));
    // Names beginning with one or more underscores are usually internal.
    if (/^_+[a-z]/.test(lower)) return true;
    return SENSITIVE_PATTERNS.some(p => lower.includes(p));
  }

  /**
   * Returns true if the field is safe to consider for autofill. Currently a
   * thin wrapper over isSensitiveFieldName but kept separate so callers
   * read naturally and we have one place to add future heuristics.
   *
   * @param {Element} el - DOM element (input, textarea, select).
   * @returns {boolean}
   */
  function isFieldEligible(el) {
    if (!el) return false;
    // Never a Q&A/AI answer: account passwords are only ever filled by the
    // dedicated Workday account-step handler in content.js.
    if (el.type === 'password') return false;
    if (isHoneypotField(el)) return false;
    // Filled by a dedicated handler (content.js — e.g. Workday's Work
    // Experience / Education panels); the generic Q&A/AI passes must not
    // overwrite it (they put the answer "No" into a job's Location).
    if (el.closest && el.closest('[data-jm-managed]')) return false;
    const probes = [el.id, el.name, el.getAttribute && el.getAttribute('data-testid')];
    for (const probe of probes) {
      if (isSensitiveFieldName(probe)) return false;
    }
    return true;
  }

  /**
   * A field the form itself says a person must leave empty. Workday's
   * create-account step carries <input data-automation-id="beecatcher"
   * name="website"> labelled "Enter website. This input is for robots only,
   * do not enter if you're human." — its innocuous `name` passes the
   * name-based checks above, and the profile/AI passes would happily put
   * the candidate's website URL in it, flagging the application.
   * @param {Element} el
   * @returns {boolean}
   */
  function isHoneypotField(el) {
    if (el.getAttribute && el.getAttribute('data-automation-id') === 'beecatcher') return true;
    if (!el.id || typeof document === 'undefined') return false;
    const label = document.querySelector('label[for="' + String(el.id).replace(/["\\]/g, '\\$&') + '"]');
    return !!(label && /for robots only|if you(?:'|’)?re (?:a )?human|leave (?:this )?(?:field )?(?:blank|empty)/i.test(label.textContent || ''));
  }

  const PLACEHOLDER_TEXT_RE = /^(select|choose|pick|please select|--|—)/i;

  /** @param {Element} el */
  function isVisible(el) {
    return !!el && el.offsetParent !== null;
  }

  /**
   * Is this field currently flagged as wrong by the page? `aria-invalid`
   * on the field (or a wrapping group/fieldset — how radio groups are
   * flagged), a visible error message it points to via aria-describedby,
   * or Workday's visible inputAlert in the same formField.
   * @param {Element} el
   * @returns {boolean}
   */
  function fieldShowsError(el) {
    if (!el || typeof document === 'undefined') return false;
    if (el.getAttribute('aria-invalid') === 'true') return true;
    if (el.closest && el.closest('[aria-invalid="true"]')) return true;
    const ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    for (const id of ids) {
      const d = document.getElementById(id);
      if (d && isVisible(d) && /error|required|invalid|must|enter a valid/i.test(d.textContent || '')) return true;
    }
    const wdField = el.closest && el.closest('[data-automation-id^="formField-"]');
    const alert = wdField && wdField.querySelector('[data-automation-id="inputAlert"]');
    return !!(alert && isVisible(alert));
  }

  /**
   * Does this field already hold an answer (typed or chosen by the user, or
   * by an earlier AutoFill pass)?
   * @param {Element} el
   * @returns {boolean}
   */
  function hasAnswer(el) {
    if (!el) return false;
    const tag = el.tagName;
    const type = (el.type || '').toLowerCase();
    if (tag === 'SELECT') {
      const opt = el.options[el.selectedIndex];
      if (!opt) return false;
      const value = (opt.value || '').trim();
      return !!value && value !== '-1' && !PLACEHOLDER_TEXT_RE.test((opt.textContent || '').trim());
    }
    // A tick/selection only counts as an answer when it isn't just the
    // page's own default (the HTML `checked` attribute, e.g. a pre-ticked
    // newsletter opt-in): a default may still be changed to match a saved
    // answer, a box/option the user picked never is.
    const chosen = (r) => r.checked && !(r.defaultChecked || r.hasAttribute('checked'));
    if (type === 'radio') {
      if (!el.name || typeof document === 'undefined') return chosen(el);
      return Array.from(document.getElementsByName(el.name)).some(chosen);
    }
    if (type === 'checkbox') return chosen(el);
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      if ((el.value || '').trim()) return true;
      // react-select style comboboxes show the chosen value in a sibling of
      // their (empty) search input.
      const control = el.closest && el.closest('[class*="__control"], [class*="-control"]');
      if (control && control.querySelector('[class*="singleValue"], [class*="single-value"], [class*="multiValue"], [class*="multi-value"]')) return true;
      // A select whose input stays empty and shows its choice in a
      // single-value element a level or two up — which also shows the
      // placeholder until something is chosen (Paylocity's
      // pcty-input-select: "Select a state" → "IN").
      let node = el.parentElement;
      for (let i = 0; i < 3 && node; i++, node = node.parentElement) {
        const shown = node.querySelector('[class*="single-value"], [class*="singleValue"]');
        if (shown) {
          const text = (shown.textContent || '').trim();
          return !!text && !PLACEHOLDER_TEXT_RE.test(text);
        }
      }
      return false;
    }
    // Dropdown trigger buttons/divs (Workday, Radix/shadcn, Rippling).
    if (el.getAttribute('aria-haspopup') === 'listbox' || el.getAttribute('role') === 'combobox') {
      if (el.hasAttribute('value')) return !!(el.getAttribute('value') || '').trim();
      if (el.hasAttribute('data-placeholder') || el.querySelector('[data-placeholder]')) return false;
      const text = (el.textContent || '').trim();
      return !!text && !PLACEHOLDER_TEXT_RE.test(text);
    }
    return false;
  }

  /**
   * AutoFill should leave this field alone: it already has an answer and
   * the page isn't flagging it. Re-running AutoFill ("Resume Auto Mode",
   * the next Auto-Bid pass, a second AutoFill click) used to re-fill EVERY
   * field — overwriting what the user had just typed or picked to fix a
   * step, and bringing the step's errors back. Only empty fields and
   * fields showing an error get (re)filled now.
   * @param {Element} el
   * @returns {boolean}
   */
  function shouldKeepExistingAnswer(el) {
    return hasAnswer(el) && !fieldShowsError(el);
  }

  const api = { isSensitiveFieldName, isFieldEligible, shouldKeepExistingAnswer, hasAnswer, fieldShowsError, SENSITIVE_PATTERNS, SENSITIVE_EXACT };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.JMFieldFilter = api;
  }
})();
