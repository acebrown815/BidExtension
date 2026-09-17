/**
 * Makes every page believe it is always visible/focused, regardless of
 * whether its actual browser tab is backgrounded (chrome.tabs.create with
 * active: false) or the window itself is unfocused.
 *
 * Why this exists: background.js's Auto-Bid feature opens up to 10 pending
 * job postings in background tabs (active: false, so batching them doesn't
 * repeatedly steal the user's window focus). Some ATS platforms (confirmed
 * on Dover, app.dover.com) defer their own job-description data fetch
 * until the page believes it's actually visible — a common, otherwise
 * reasonable performance optimization ("don't do expensive work for a tab
 * nobody is looking at") that happens to defeat any automated flow relying
 * on a background tab ever finishing that fetch. Without this, the JD
 * never renders in the background tab, scanResumeMatch()/analyzeJob()'s
 * resume ranking gets nothing to score against, and the multi-resume
 * compare silently never triggers — while the AI analysis itself still
 * "succeeds" via a last-resort body-text fallback, just against a much
 * lower-quality result.
 *
 * A content script's `document` is the SAME live DOM object the page's own
 * scripts read — isolated worlds separate global variables/functions, not
 * the DOM itself — so overriding these accessors here is visible to the
 * page's own JS too, not just this extension's code.
 *
 * Registered in manifest.json as its own "document_start" content script
 * (ahead of content.js, which runs at "document_idle") so the override is
 * in place before the page's own bundle ever gets a chance to check
 * visibility, even once at initial load.
 */
(function () {
  'use strict';

  function fakeVisible(doc) {
    try {
      Object.defineProperty(doc, 'hidden', { get: () => false, configurable: true });
      Object.defineProperty(doc, 'visibilityState', { get: () => 'visible', configurable: true });
      // Older/vendor-prefixed variants some libraries still check.
      Object.defineProperty(doc, 'webkitHidden', { get: () => false, configurable: true });
      Object.defineProperty(doc, 'webkitVisibilityState', { get: () => 'visible', configurable: true });
    } catch (_) {
      // Best-effort — a page that already froze these properties (rare)
      // just doesn't get the override; nothing else here depends on it.
    }

    // Some libraries react to the visibilitychange EVENT rather than
    // (or in addition to) polling the properties above. The real event
    // would tell them the opposite of what those overridden properties
    // now claim, so stop it from reaching any listener the page adds.
    // Capture phase + stopImmediatePropagation: runs before, and instead
    // of, every other listener on this event, including ones added later.
    const suppressRealEvent = (e) => { e.stopImmediatePropagation(); };
    doc.addEventListener('visibilitychange', suppressRealEvent, true);
    doc.addEventListener('webkitvisibilitychange', suppressRealEvent, true);
  }

  fakeVisible(document);
})();
