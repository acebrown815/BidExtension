/**
 * Shared radio-GROUP label resolution — resolves a radio group's own
 * question label (e.g. "Will you need sponsorship?"), not any single
 * option's own label (e.g. "Yes"). Used by both content.js (feeds the
 * question_text sent to the AI for the bulk autofill pass) and
 * directFill.js (Pass 1's instant, no-AI Q&A matching) — these used to be
 * two separate, drifting copies of the same logic; unified here the same
 * way lib/qaMatch.js unified the Q&A-matching duplicate.
 *
 * Root cause this exists to fix, confirmed live on a Dover/MUI-based job
 * application form: MUI's <RadioGroup> renders the group's own question as
 * a plain sibling element OUTSIDE the radiogroup/fieldset entirely —
 *   <div>Will you need sponsorship? *</div>
 *   <div role="radiogroup">
 *     <label><input type="radio" value="Yes">...Yes</label>
 *     <label><input type="radio" value="No">...No</label>
 *   </div>
 * Neither <label> here has a `for` attribute, and both wrap their own
 * radio directly — so a search for label/legend text INSIDE the
 * radiogroup container correctly finds nothing usable (it correctly
 * rejects "Yes"/"No" as option-level labels), but there's no
 * <label>/<legend> holding the real question anywhere in that subtree
 * either. Without this fix, that fell through to a single-element label
 * resolver whose "closest wrapping <label>" strategy then picked up the
 * FIRST OPTION's own label ("Yes") as if it were the whole group's
 * question — so the AI (or Pass 1's Q&A matcher) never saw the real
 * question text at all, just the literal string "Yes", making a correct
 * answer impossible regardless of how good the Q&A matching is.
 *
 * Loaded as a content script — hangs the API on globalThis so other
 * content scripts in the same isolated world (content.js, directFill.js)
 * can use it, and tests can `import './lib/radioGroupLabel.js'` and read
 * globalThis.
 */
(function () {
  'use strict';

  /**
   * Walks up from the radio's PARENT, not the radio itself — a naive
   * `.closest('fieldset, [role="radiogroup"], [class*="radio-group"]')`
   * called on the radio matches the radio's own class (or its immediate
   * per-option wrapper div's class) before ever reaching the real group
   * container, because ATS markup (seen on Ashby) names those
   * "...-radio-group-option-radio" / "...-radio-group-option" — both
   * contain "radio-group" as a literal substring. Skips any ancestor
   * whose own class marks it as an option-level wrapper instead of the
   * group container itself.
   * @param {HTMLInputElement[]} radios
   * @returns {Element|null}
   */
  function findRadioGroupContainer(radios) {
    let node = radios[0].parentElement;
    while (node) {
      const tag = node.tagName;
      const cls = typeof node.className === 'string' ? node.className : '';
      const role = node.getAttribute && node.getAttribute('role');
      const isOptionWrapper = /-option(-|$)/i.test(cls) || /\boption\b/i.test(cls);
      if (!isOptionWrapper && (tag === 'FIELDSET' || role === 'radiogroup' || /radio-?group/i.test(cls))) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  /**
   * @param {HTMLInputElement[]} radios - all radios in one group (same name)
   * @param {(el: HTMLInputElement) => string} fallbackLabel - single-element
   *   label resolver (e.g. content.js's getFieldLabel, or directFill.js's
   *   getElementLabel) used only if no group-level label/legend/heading is
   *   found at all.
   * @returns {string}
   */
  function getRadioGroupLabel(radios, fallbackLabel) {
    const container = findRadioGroupContainer(radios);
    if (container) {
      const radioIds = new Set(radios.map(r => r.id).filter(Boolean));
      for (const cand of container.querySelectorAll('label, legend')) {
        const forId = cand.getAttribute('for');
        if (forId && radioIds.has(forId)) continue; // an option's own label, not the question
        if (radios.some(r => cand.contains(r))) continue; // wraps a radio directly — also an option label
        const text = cand.textContent.trim();
        if (text) return text;
      }

      // No usable <label>/<legend> INSIDE the group container — see this
      // file's doc comment for the concrete MUI structure that requires
      // this. Walk up from the container looking at each ancestor's
      // immediately preceding sibling for non-form-control text, capped at
      // a few levels so this can't wander into unrelated page content.
      let node = container;
      for (let depth = 0; depth < 3 && node; depth++) {
        let sib = node.previousElementSibling;
        while (sib) {
          if (!/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(sib.tagName)) {
            const text = sib.textContent.trim();
            if (text && text.length < 300) return text;
          }
          sib = sib.previousElementSibling;
        }
        node = node.parentElement;
      }
    }
    // No fieldset/legend/sibling-heading structure found — fall back to
    // the generic single-element resolver (covers radio groups with only a
    // group-level aria-label/wrapper and no per-option labels to get
    // confused by).
    return fallbackLabel(radios[0]);
  }

  const api = { findRadioGroupContainer, getRadioGroupLabel };

  // CommonJS / vitest
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  // Content script / browser
  if (typeof globalThis !== 'undefined') {
    globalThis.JMRadioGroupLabel = api;
  }
})();
