/**
 * Direct Q&A Fill — fills form fields by matching labels to Q&A answers.
 * No AI needed. Runs as Pass 1 before the AI autofill.
 *
 * Strategy:
 * 1. Scan ALL interactive elements (inputs, selects, textareas, React Selects,
 *    and custom Yes/No button-toggle widgets like Ashby's)
 * 2. For each, extract its label using multiple strategies
 * 3. Match label to Q&A or profile data
 * 4. Fill directly with proper event simulation — real clicks for
 *    button-driven widgets (React Select, Yes/No toggles) rather than
 *    setting hidden DOM state those widgets don't actually listen to
 */

(function () {
  'use strict';

  // Logs leak Q&A answer content (gender/race/salary/etc) into the page's
  // DevTools console — never enable in shipped builds.
  const DEBUG = false;
  const dbg = (...args) => { if (DEBUG) console.log('[JobMatch AI]', ...args); };

  // C3b — skip CSRF/tracking/honeypot fields. Fallback no-op if the helper
  // failed to load so we don't break direct-fill silently.
  const isFieldEligible = (globalThis.JMFieldFilter && globalThis.JMFieldFilter.isFieldEligible) || (() => true);

  // ─── Label extraction (tries multiple strategies) ───────────────

  function getElementLabel(el) {
    // 1. <label for="id">
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return cleanLabel(label.textContent);
    }

    // 2. Wrapping <label>
    const parentLabel = el.closest('label');
    if (parentLabel) return cleanLabel(parentLabel.textContent);

    // 3. aria-label
    if (el.getAttribute('aria-label')) return cleanLabel(el.getAttribute('aria-label'));

    // 4. aria-labelledby
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) return cleanLabel(labelEl.textContent);
    }

    // 5. placeholder
    if (el.placeholder) return cleanLabel(el.placeholder);

    // 6. Previous sibling label or nearby label
    const container = el.closest('.field, .form-group, .form-field, [class*="field"], [class*="form-group"]');
    if (container) {
      const label = container.querySelector('label, [class*="label"], [class*="Label"]');
      if (label && !label.contains(el)) return cleanLabel(label.textContent);
    }

    // 7. Previous sibling text
    let prev = el.previousElementSibling;
    if (prev && prev.tagName === 'LABEL') return cleanLabel(prev.textContent);

    // 8. Walk up DOM looking for a label, but ONLY accept it if the ancestor
    //    contains exactly one labelable form element. Otherwise we'd attribute
    //    the same label to every input inside a shared wrapper — which on
    //    Workday/Greenhouse forms causes the AI to fill the wrong field
    //    (e.g. typing the gender answer into the field next to gender).
    let parent = el.parentElement;
    for (let i = 0; i < 5 && parent; i++) {
      const label = parent.querySelector('label');
      if (label && !label.contains(el)) {
        const labelables = parent.querySelectorAll('input:not([type=hidden]):not([type=button]):not([type=submit]), textarea, select');
        if (labelables.length === 1) return cleanLabel(label.textContent);
      }
      parent = parent.parentElement;
    }

    // 9. name attribute as fallback
    if (el.name) return cleanLabel(el.name.replace(/_/g, ' ').replace(/\[.*\]/, ''));

    return '';
  }

  // Real bug found live on a Hireology-hosted careers form: its labels are
  // literally written as "First name (required)", "Email address
  // (required)", "City (optional)", etc. — the requirement annotation is
  // part of the label's own visible text, not a separate element. matchQA
  // below does an EXACT (non-fuzzy) match against a short profileMap key
  // like "first name" for these common personal-info fields, specifically
  // so it never mismatches an unrelated field — but that exactness means
  // "first name (required)" doesn't match "first name" at all, silently
  // skipping the field here and leaving it for the AI-driven Pass 2 (which
  // costs an extra round trip, and isn't guaranteed to fill it the same
  // way). Stripping a trailing "(required)"/"(optional)" annotation before
  // the exact-match lookup fixes this for any ATS using this common
  // labeling convention, not just Hireology.
  function cleanLabel(text) {
    return (text || '')
      .replace(/\*/g, '')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\s*\((?:required|optional)\)\s*$/i, '')
      .trim();
  }

  /**
   * Resolves the QUESTION label for a radio group — e.g. "What is your
   * gender identity?" — as distinct from any individual option's own
   * label. See lib/radioGroupLabel.js for the full rationale (shared with
   * content.js, which needs the exact same resolution for the AI-facing
   * question_text it sends).
   * @param {HTMLInputElement[]} radios all radios in one group (same name)
   * @returns {string}
   */
  function getRadioGroupLabel(radios) {
    const shared = globalThis.JMRadioGroupLabel;
    if (shared) return cleanLabel(shared.getRadioGroupLabel(radios, getElementLabel));
    // Defensive only — lib/radioGroupLabel.js is always loaded ahead of
    // directFill.js per manifest.json; this never runs in practice.
    return getElementLabel(radios[0]);
  }

  // ─── Event simulation ──────────────────────────────────────────

  function fireEvents(el) {
    el.dispatchEvent(new Event('focus', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function setNativeInputValue(el, value) {
    // React overrides the value setter, so we need to use the native one
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set || Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, value);
    } else {
      el.value = value;
    }
    fireEvents(el);
  }

  // ─── Q&A matching ─────────────────────────────────────────────

  function matchQA(label, qaList, profile) {
    if (!label) return null;
    const l = label.toLowerCase().trim();

    // ── Profile field mapping (only for very specific short labels) ──
    const profileMap = {
      'first name': profile?.name?.split(/\s+/)[0] || '',
      'preferred first name': profile?.name?.split(/\s+/)[0] || '',
      'last name': profile?.name?.split(/\s+/).slice(1).join(' ') || '',
      'full name': profile?.name || '',
      'email': profile?.email || '',
      'email address': profile?.email || '',
      'phone': profile?.phone || '',
      'phone number': profile?.phone || '',
      'linkedin profile url': profile?.linkedin || '',
      'github profile url': profile?.github || '',
      'portfolio / personal website url': profile?.website || '',
      'location (city)': (profile?.location || '').split(',')[0]?.trim() || '',
      'city': (profile?.location || '').split(',')[0]?.trim() || '',
    };

    // Profile match: ONLY exact label match (no fuzzy)
    if (profileMap[l] !== undefined && profileMap[l]) {
      return profileMap[l];
    }

    // ── Q&A matching (strict — see lib/qaMatch.js for the algorithm and
    // why it's shared with aiService.js's hint-matcher) ──
    if (!qaList || qaList.length === 0) return null;
    const matchesLabel = (globalThis.JMQaMatch && globalThis.JMQaMatch.qaQuestionMatchesLabel) || (() => false);
    const match = qaList.find(qa => qa.answer && matchesLabel(qa.question, l));
    if (match) return match.answer;

    return null;
  }

  // Shared by the checkbox handler (section 4) and the custom yes/no
  // button-toggle handler (section 5): whether a Q&A answer reads as a
  // yes/no-shaped answer at all, and if so, which side it lands on.
  const YES_NO_ANSWER_RE = /^(yes|no|true|false|i am|i do|i have|i don't|i am not)/i;
  const AFFIRMATIVE_ANSWER_RE = /^(yes|true|1|checked|agree|accept|i am|i do|i have)/i;

  // ─── Option matching for dropdowns ────────────────────────────

  function findBestOption(options, answer) {
    const a = answer.toLowerCase().trim();
    // Exact match
    const exact = options.find(o => o.toLowerCase().trim() === a);
    if (exact) return exact;
    // Option contains answer
    const contains = options.find(o => o.toLowerCase().includes(a));
    if (contains) return contains;
    // Answer contains option
    const contained = options.find(o => a.includes(o.toLowerCase().trim()) && o.trim().length > 2);
    if (contained) return contained;
    // Common swaps
    const swaps = { 'male': ['man'], 'man': ['male'], 'female': ['woman'], 'woman': ['female'],
      'yes': ['i am', 'authorized', 'i do', 'i have'], 'no': ['i am not', 'i do not'] };
    const alts = swaps[a] || [];
    for (const alt of alts) {
      const sw = options.find(o => o.toLowerCase().includes(alt));
      if (sw) return sw;
    }
    return null;
  }

  // ─── Custom Yes/No button-toggle handler (Ashby-style) ────────
  //
  // Some ATSs (seen on Ashby) render a Yes/No question as two <button>
  // elements carrying aria-pressed/data-option, plus a hidden,
  // tabindex="-1" checkbox that mirrors the answer for form semantics —
  // but that checkbox has no listener of its own; it's only ever written
  // to by the page's own click handler on the buttons, never read from.
  // So the checkbox handler above (section 4) can find the label and the
  // right answer, but setting `.checked` and firing a change event never
  // reaches the page's real state. The fix is the same one fillReactSelect
  // (below) already uses for React Select: click the real interactive
  // element instead of poking at hidden DOM.

  /**
   * Given the two <button> children of a yes/no toggle group, figures out
   * which is "Yes" and which is "No". Returns null (skip, don't guess) if
   * that can't be determined confidently.
   */
  function classifyToggleButtons(buttons) {
    const byOption = {};
    buttons.forEach(b => {
      const opt = (b.getAttribute('data-option') || '').toLowerCase().trim();
      if (opt) byOption[opt] = b;
    });
    if (byOption.yes && byOption.no) return { yesBtn: byOption.yes, noBtn: byOption.no };

    // Fall back to the buttons' own text for widgets that skip data-option.
    const byText = {};
    buttons.forEach(b => {
      const t = cleanLabel(b.textContent).toLowerCase();
      if (/^(yes|true|agree|accept)$/.test(t)) byText.yes = b;
      else if (/^(no|false|disagree|decline)$/.test(t)) byText.no = b;
    });
    if (byText.yes && byText.no) return { yesBtn: byText.yes, noBtn: byText.no };
    return null;
  }

  /**
   * Resolves the question text for a toggle group. Scoped to the nearest
   * ancestor that demarcates a single form field (Ashby marks these with
   * data-field-path; other ATSs typically use a "field"/"form-group"
   * class) so a neighboring question's label is never pulled in.
   */
  function getToggleGroupLabel(group) {
    const fieldEntry = group.closest('[data-field-path], .field, .form-group, .form-field, [class*="field"], [class*="Field"]');
    const scope = fieldEntry || group.parentElement || group;
    const label = scope.querySelector('label, [class*="label"], [class*="Label"]');
    if (label && !label.contains(group)) return cleanLabel(label.textContent);
    return '';
  }

  // Clicks an element the same defensive way fillReactSelect clicks
  // options: a real `.click()` (preceded by a `mousedown`) instead of
  // programmatic property assignment.
  //
  // React overrides the `checked` property setter the same way it
  // overrides `value` (see setNativeInputValue above) to track whether a
  // change came from a real user interaction vs. programmatic JS.
  // Assigning `el.checked = ...` (for a radio/checkbox) or toggling
  // `aria-pressed` directly (for a custom toggle button) and firing
  // synthetic input/change events doesn't reliably register with that
  // tracking on a React-controlled element — the visual/DOM change can be
  // silently reverted on the component's next re-render, leaving the
  // field looking blank even though this code "filled" it. A genuine
  // `.click()` goes through the browser's native activation behavior
  // instead, which correctly flips `checked` (for inputs) and dispatches
  // real input/change events as part of that spec-defined behavior — the
  // element's own click handler (for buttons) takes it from there.
  //
  // Shared by the Yes/No button-toggle handler (section 5) and the
  // radio/checkbox handlers (sections 3-4) below.
  function clickNatively(el) {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.click();
  }

  // ─── React Select handler ────────────────────────────────────

  async function fillReactSelect(container, answer) {
    // Find the control element to click
    const control = container.querySelector('[class*="control"], [class*="Control"]')
      || container.querySelector('[class*="css-"][class*="-"]');
    if (!control) return false;

    // Click to open
    control.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    control.click();

    // Wait for options
    await new Promise(r => setTimeout(r, 400));

    // Find options
    const options = document.querySelectorAll('[role="option"]');
    const optTexts = Array.from(options).map(o => o.textContent.trim());
    const best = findBestOption(optTexts, answer);

    if (best) {
      const optEl = Array.from(options).find(o => o.textContent.trim() === best);
      if (optEl) {
        optEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        optEl.click();
        await new Promise(r => setTimeout(r, 200));
        return true;
      }
    }

    // Close if no match
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return false;
  }

  // ─── Main: Direct fill all fields ─────────────────────────────

  /**
   * Scans the page and fills all matching fields directly from Q&A and profile.
   * Returns { filled, unfilled } where unfilled is a list of field labels that
   * couldn't be matched (these get sent to AI in Pass 2).
   */
  async function directFillFromQA(qaList, profile) {
    let filled = 0;
    const filledIds = new Set();
    const filledLabels = new Set();
    const unfilled = [];

    // Store filled labels globally so Pass 2 can skip them
    window.__jobMatchFilledLabels = filledLabels;

    dbg(`Direct fill: scanning page with ${qaList?.length || 0} Q&A entries`);

    // ── 1. Native inputs and textareas ──
    const inputs = document.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]), textarea'
    );

    for (const input of inputs) {
      if (input.offsetParent === null) continue; // hidden
      if (input.value && input.value.trim().length > 0) continue; // already has value
      // Skip inputs that are part of React Select (combobox search inputs)
      if (input.getAttribute('role') === 'combobox') continue;
      if (input.getAttribute('aria-autocomplete')) continue;
      // Skip hidden inputs inside React Select containers
      if (input.closest('[class*="css-"][class*="-container"]') || input.closest('[class*="select__"]')) continue;
      if (input.type === 'hidden') continue;
      // C3b: never touch CSRF/tracking/honeypot fields, even if their label
      // happens to match a Q&A entry.
      if (!isFieldEligible(input)) continue;

      const label = getElementLabel(input);
      if (!label) continue;

      const answer = matchQA(label, qaList, profile);
      if (answer) {
        // Sanity check: don't put long answers in short text inputs
        if (input.type !== 'textarea' && input.tagName !== 'TEXTAREA' && answer.length > 200) continue;
        dbg(`Direct fill: "${label}" (${answer.length} chars)`);
        setNativeInputValue(input, answer);
        filledIds.add(input.id || input.name);
        filledLabels.add(label);
        filled++;
      }
    }

    // ── 2. Native <select> elements ──
    const selects = document.querySelectorAll('select');
    for (const sel of selects) {
      if (!isFieldEligible(sel)) continue; // C3b
      const label = getElementLabel(sel);
      if (!label) continue;

      const answer = matchQA(label, qaList, profile);
      if (!answer) continue;

      const optTexts = Array.from(sel.options).map(o => o.text.trim());
      const best = findBestOption(optTexts, answer);
      if (best) {
        const opt = Array.from(sel.options).find(o => o.text.trim() === best);
        if (opt) {
          dbg(`Direct fill <select>: "${label}" matched`);
          sel.value = opt.value;
          fireEvents(sel);
          filledIds.add(sel.id || sel.name);
          filledLabels.add(label);
          filled++;
        }
      }
    }

    // ── 3. Radio buttons ──
    const radioGroups = {};
    document.querySelectorAll('input[type="radio"]').forEach(r => {
      const name = r.name;
      if (!name) return;
      if (!isFieldEligible(r)) return; // C3b
      if (!radioGroups[name]) radioGroups[name] = [];
      radioGroups[name].push(r);
    });

    for (const [name, radios] of Object.entries(radioGroups)) {
      const label = getRadioGroupLabel(radios) || name.replace(/_/g, ' ');
      const answer = matchQA(label, qaList, profile);
      if (!answer) continue;

      const radioLabels = radios.map(r => ({
        el: r,
        text: (r.labels?.[0]?.textContent || r.value || '').trim()
      }));
      const best = findBestOption(radioLabels.map(r => r.text), answer);
      if (best) {
        const radio = radioLabels.find(r => r.text === best);
        if (radio) {
          dbg(`Direct fill radio: "${label}" matched`);
          // Clicking an already-checked radio is a safe no-op (radios can't
          // be deselected by clicking themselves), so only click when it's
          // actually necessary to change state.
          if (!radio.el.checked) clickNatively(radio.el);
          filledLabels.add(label);
          filled++;
        }
      }
    }

    // ── 4. Checkboxes (only for Yes/No type questions, not multi-select) ──
    // Skip checkboxes that look like multi-select options (city names, skills, etc.)
    document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      // Decoy checkbox for a custom Yes/No button-toggle widget (Ashby-
      // style) — section 5 below owns this field and clicks the real
      // button; setting .checked here wouldn't reach the page's state
      // anyway (see section 5's comment), so don't double-report it filled.
      if (cb.parentElement && cb.parentElement.querySelector('button[aria-pressed]')) return;
      if (!isFieldEligible(cb)) return; // C3b
      const label = getElementLabel(cb);
      if (!label) return;

      // Skip multi-select checkboxes (city names, office locations, skills)
      // Only fill checkboxes that are clearly Yes/No questions
      const answer = matchQA(label, qaList, profile);
      if (!answer) return;

      // Only fill if the Q&A answer is clearly a yes/no type
      if (!YES_NO_ANSWER_RE.test(answer)) return;

      const shouldCheck = AFFIRMATIVE_ANSWER_RE.test(answer);
      if (cb.checked !== shouldCheck) {
        dbg(`Direct fill checkbox: "${label}" matched`);
        // A single click toggles the checkbox; we only get here when the
        // current state differs from the desired one, so one click lands
        // exactly on shouldCheck.
        clickNatively(cb);
        filledLabels.add(label);
        filled++;
      }
    });

    // ── 5. Custom Yes/No button-toggle widgets (Ashby-style) ──
    // See the classifyToggleButtons/getToggleGroupLabel/clickNatively
    // helpers above for why this can't be handled by the checkbox branch.
    const processedToggleGroups = new Set();
    document.querySelectorAll('button[aria-pressed]').forEach(btn => {
      const group = btn.parentElement;
      if (!group || processedToggleGroups.has(group)) return;
      processedToggleGroups.add(group);

      const buttons = Array.from(group.children).filter(el => el.tagName === 'BUTTON' && el.hasAttribute('aria-pressed'));
      if (buttons.length !== 2) return; // only handle unambiguous yes/no pairs

      // Already answered (by the user or an earlier run) — never override.
      if (buttons.some(b => b.getAttribute('aria-pressed') === 'true')) return;

      const toggle = classifyToggleButtons(buttons);
      if (!toggle) return; // can't confidently tell yes from no — skip rather than guess

      // C3b — probe whatever real form field backs this widget, if any.
      const hiddenInput = group.querySelector('input[type="checkbox"], input[type="radio"], input[type="hidden"]');
      if (!isFieldEligible(hiddenInput || group)) return;

      const label = getToggleGroupLabel(group);
      if (!label) return;

      const answer = matchQA(label, qaList, profile);
      if (!answer || !YES_NO_ANSWER_RE.test(answer)) return;

      const wantsYes = AFFIRMATIVE_ANSWER_RE.test(answer);
      const target = wantsYes ? toggle.yesBtn : toggle.noBtn;
      dbg(`Direct fill yes/no toggle: "${label}" -> ${wantsYes ? 'Yes' : 'No'}`);
      clickNatively(target);
      filledLabels.add(label);
      filled++;
    });

    // ── 6. React Select dropdowns ──
    // Find all React Select containers by looking for the input[role="combobox"] inside them
    const reactInputs = document.querySelectorAll('input[role="combobox"]');
    const processedContainers = new Set();
    dbg(`Direct fill: found ${reactInputs.length} React Select inputs`);

    for (const input of reactInputs) {
      // Walk up to find the React Select container
      let container = input.closest('[class*="css-"]');
      // Go up a few levels to find the full container with the label
      let fieldWrapper = container;
      for (let i = 0; i < 6 && fieldWrapper; i++) {
        fieldWrapper = fieldWrapper.parentElement;
        if (!fieldWrapper) break;
        if (fieldWrapper.querySelector('label')) break;
      }

      if (!fieldWrapper || processedContainers.has(fieldWrapper)) continue;
      processedContainers.add(fieldWrapper);

      // Find label
      const labelEl = fieldWrapper.querySelector('label');
      const label = labelEl ? cleanLabel(labelEl.textContent) : '';
      if (!label) continue;

      // Get current selected value
      const singleValue = fieldWrapper.querySelector('[class*="single-value"], [class*="singleValue"]');
      const currentText = singleValue?.textContent?.trim() || '';

      const answer = matchQA(label, qaList, profile);
      if (!answer) continue;

      // Check if already correct
      if (currentText && currentText.toLowerCase() === answer.toLowerCase()) continue;

      // Find the inner React Select container for clicking
      const selectContainer = input.closest('[class*="css-"]')?.parentElement
        || input.closest('[class*="select"], [class*="Select"]');
      if (!selectContainer) continue;

      dbg(`Direct fill React Select: "${label}" matched (${answer.length} chars)`);
      const success = await fillReactSelect(selectContainer, answer);
      if (success) {
        filledLabels.add(label);
        filled++;
      }
    }

    dbg(`Direct fill complete: ${filled} fields filled`);
    return { filled, filledIds };
  }

  // Export for use by content.js
  window.__jobMatchDirectFill = directFillFromQA;
})();
