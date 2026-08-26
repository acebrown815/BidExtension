/**
 * @file content.js
 * @description Main content script for JobMatch AI.
 *
 * ROLE IN EXTENSION ARCHITECTURE
 * --------------------------------
 * This file is injected into supported job-site pages (LinkedIn, Indeed,
 * Glassdoor, Greenhouse, Lever, Workday, etc.) by the manifest content_scripts
 * declaration.  It runs in the page's context (but is isolated from page JS)
 * and is responsible for ALL user-facing UI and interaction logic.
 *
 * Everything runs inside a single IIFE to avoid polluting the global namespace.
 * The panel and its toggle button each live inside their own Shadow DOM host so
 * the page's CSS can never bleed in and the extension's CSS can never bleed out.
 *
 * KEY RESPONSIBILITIES
 * ---------------------
 * 1. Shadow DOM side panel — renders the full analysis UI (score, skills, recs,
 *    insights, ATS keywords, cover letter, bullet rewriter, notes).
 * 2. Draggable floating ★ button — always-visible trigger that opens/closes panel.
 * 3. Job data extraction — scrapes title, company, location, salary, and the
 *    full job description from the host page using site-specific CSS selectors.
 * 4. Job analysis — sends extracted data to background.js for AI scoring and
 *    caches results in chrome.storage.local to avoid redundant API calls.
 * 5. AutoFill pipeline — detects form fields (text, select, radio, checkbox,
 *    custom dropdowns), sends them to the AI for answer generation, shows a
 *    preview for user review, then fills the form on confirmation.
 * 6. Cover letter & bullet rewriter — post-analysis AI writing tools.
 * 7. Job notes — per-URL free-text notes saved to chrome.storage.local.
 * 8. SPA navigation detection — resets state when LinkedIn/Indeed navigate to a
 *    new job posting without a full page reload.
 */

// Injected into job site pages by manifest.json content_scripts

(function() {
  'use strict';

  // Prevent double injection (e.g. if the content script fires twice on the same page)
  if (window.__jobmatchAILoaded) return;
  window.__jobmatchAILoaded = true;


  // URL normalizer is loaded as a content script before us (see manifest.json).
  // Strips UTM/click-id noise so the analysis cache + applied-job dedupe work.
  // Defensive fallback if the helper failed to load for some reason.
  const normalizeUrl = (globalThis.JMUrlKey && globalThis.JMUrlKey.normalizeUrlForCache) || (u => u);

  // Field-name allowlist (C3b). Drops CSRF/tracking/honeypot inputs from
  // the autofill pipeline so prompt-injection or buggy label extraction
  // can't trick us into writing into them.
  const isFieldEligible = (globalThis.JMFieldFilter && globalThis.JMFieldFilter.isFieldEligible) || (() => true);

  // Local (no-AI) resume-vs-JD ATS-keyword ranker. Lets the panel highlight
  // which of the user's saved resumes is the strongest ATS-keyword match
  // (skills, certifications, project technologies — lib/resumeKeywords.js)
  // for the current posting, without an AI call per resume. Defensive
  // fallback so a missing helper never breaks the panel.
  const rankResumes = (globalThis.JMResumeRanker && globalThis.JMResumeRanker.rankResumes)
    || (() => []);

  // ─── State ──────────────────────────────────────────────────────
  // Module-level variables shared across functions within this IIFE.

  let panelOpen = false;        // Whether the side panel is currently visible
  let currentAnalysis = null;   // The most recent analysis result for the current page
  let panelRoot = null;         // The host DOM element that contains the Shadow DOM panel
  let shadowRoot = null;        // The closed Shadow DOM root — panel elements are queried from here
  let toggleBtnRef = null;      // Reference to the floating toggle button (inside closed Shadow DOM)
  let toggleHostRef = null;     // The host DOM element that wraps the toggle button — needed for self-healing

  // Generation counter for analyze runs. Bumped when SPA navigation is
  // detected so an in-flight analysis can detect "the page changed under me"
  // and bail instead of caching/rendering against the wrong URL (I3).
  let _analyzeGen = 0;

  // AutoFill state
  let _fieldMap        = {};   // Map of question_id → { el, type, ... } built during field detection
  // Resume-upload <input type="file"> fields found by the most recent
  // detectFormFields() call. Kept separate from _fieldMap/questions because
  // these are filled locally from the active resume's raw file bytes — no
  // AI call, so they never go through GENERATE_AUTOFILL. See attachResumeFile().
  let _resumeFileFields = []; // [{ el: HTMLInputElement, label: string }, ...]

  // Autofill badges — fixed-position pills that don't affect page layout
  let _badges            = [];        // [{ badgeEl, fieldEl, place }] for repositioning + cleanup
  let _badgeScrollHandler = null;     // scroll listener for badge repositioning
  let _badgeResizeObs    = null;      // ResizeObserver for badge repositioning

  // Resume switcher state — mirrors chrome.storage.local resume data
  let _activeResumeId = null; // id of the currently active resume, or null if none
  // True once the user has explicitly picked a resume (pill click) for the
  // CURRENT job. While true, the auto-select-best-resume logic in
  // scanResumeMatch() and analyzeJob() leaves _activeResumeId alone instead
  // of silently switching it back to whichever resume scores highest by
  // local ATS-keyword overlap — otherwise a manual switch right before
  // clicking Analyze could get reverted before the cache lookup / AI call
  // even runs, making Analyze appear to "ignore" the switch. Reset to false
  // on a genuine job change (handleSpaUrlChanged) so a new posting still
  // gets a fresh auto-pick.
  let _manualResumeSelection = false;
  let _resumes = [];          // [{id, name, profile}, ...] — all saved resumes
  // Local (no-AI) ATS-keyword-match score per resume id, 0..1, for the
  // current JD (skills + certifications + project technologies — see
  // lib/resumeKeywords.js). Populated by scanResumeMatch() against every
  // saved resume in one pass — switchSlot() then just looks up the
  // newly-active id instead of re-ranking.
  let _resumeScores = {};

  // ─── Persistent analysis cache (chrome.storage.local) ──────────
  // Caching analysis results prevents redundant API calls when the user
  // closes and reopens the panel or navigates back to a job they already viewed.
  // Results are stored under a single 'jm_analysisCache' key as a
  // "url::resumeId"→data map — keying by resume as well as URL means a
  // score cached for one resume is never shown as if it belonged to a
  // different resume after an (auto or manual) resume switch.

  const CACHE_STORAGE_KEY = 'jm_analysisCache'; // Key used in chrome.storage.local
  const MAX_CACHE_ENTRIES = 50;                  // LRU eviction kicks in beyond this limit

  /**
   * Builds the composite cache key for a page URL + resume pairing.
   * @param {string} url      - The full URL of the job posting page.
   * @param {?string} resumeId - The resume the analysis was/would be run against.
   * @returns {string}
   */
  function cacheKeyFor(url, resumeId) {
    return normalizeUrl(url) + '::' + (resumeId || 'none');
  }

  /**
   * Retrieves a cached analysis result for the given page URL + resume.
   * @async
   * @param {string} url       - The full URL of the job posting page.
   * @param {?string} resumeId - The resume this analysis should have been run against.
   * @returns {Promise<Object|null>} Cached result or null if not found.
   */
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24-hour TTL for cache entries

  async function getCachedAnalysis(url, resumeId) {
    try {
      const key = cacheKeyFor(url, resumeId);
      const result = await chrome.storage.local.get(CACHE_STORAGE_KEY);
      const cache = result[CACHE_STORAGE_KEY] || {};
      const entry = cache[key];
      if (!entry) return null;
      // Expire entries older than 24 hours
      if (entry.timestamp && Date.now() - entry.timestamp > CACHE_TTL_MS) {
        delete cache[key];
        await chrome.storage.local.set({ [CACHE_STORAGE_KEY]: cache });
        return null;
      }
      return entry;
    } catch (e) {
      // chrome.storage.local throws synchronously if the extension was
      // reloaded/updated while this tab's content script is still the old
      // instance ("Extension context invalidated"). Treat that the same as
      // a cache miss rather than letting it bubble up as an uncaught error —
      // analyzeJob() will proceed to call the background via sendMessage(),
      // which already detects the same condition and surfaces the friendly
      // "Extension was updated — please refresh this page" message.
      return null;
    }
  }

  /**
   * Stores an analysis result for the given URL + resume, evicting the
   * oldest entries when the cache exceeds MAX_CACHE_ENTRIES.
   * @async
   * @param {string} url       - The full URL of the job posting page.
   * @param {?string} resumeId - The resume this analysis was run against.
   * @param {Object} data      - The analysis payload to cache.
   */
  async function setCachedAnalysis(url, resumeId, data) {
    try {
      const key = cacheKeyFor(url, resumeId);
      const result = await chrome.storage.local.get(CACHE_STORAGE_KEY);
      const cache = result[CACHE_STORAGE_KEY] || {};
      cache[key] = { ...data, timestamp: Date.now() };
      // Evict oldest entries (Object.keys preserves insertion order in V8)
      const keys = Object.keys(cache);
      if (keys.length > MAX_CACHE_ENTRIES) {
        keys.slice(0, keys.length - MAX_CACHE_ENTRIES).forEach(k => delete cache[k]);
      }
      await chrome.storage.local.set({ [CACHE_STORAGE_KEY]: cache });
    } catch (e) {
      // Best-effort — an invalidated extension context (see getCachedAnalysis)
      // or a storage quota hiccup shouldn't crash a flow whose real work
      // (the AI analysis) already succeeded. Worst case: this result isn't
      // cached and gets re-fetched next time.
    }
  }

  // ─── Theme management ────────────────────────────────────────────
  // Themes: 'blue' (default), 'dark', 'warm'

  const THEME_ORDER = ['blue', 'dark', 'warm'];
  const THEME_FAB_COLORS = {
    blue: { bg: '#3b82f6', shadow: 'rgba(59,130,246,0.4)' },
    dark: { bg: '#1e3a5f', shadow: 'rgba(30,58,95,0.4)' },
    warm: { bg: '#d97706', shadow: 'rgba(217,119,6,0.4)' }
  };
  // Next theme's primary color shown inside the toggle button
  const THEME_ICONS = { blue: '\u2600\uFE0F', dark: '\uD83C\uDF19', warm: '\uD83C\uDF3B' };
  let _currentTheme = 'blue';

  /**
   * Applies the given theme to the panel and FAB toggle button.
   * @param {string} theme - 'blue', 'dark', or 'warm'
   */
  function applyTheme(theme) {
    _currentTheme = theme;
    const panel = shadowRoot && shadowRoot.getElementById('jm-panel');
    if (panel) {
      panel.classList.remove('theme-dark', 'theme-warm');
      if (theme === 'dark') panel.classList.add('theme-dark');
      if (theme === 'warm') panel.classList.add('theme-warm');
    }
    // Update FAB toggle button colors
    if (toggleBtnRef) {
      const colors = THEME_FAB_COLORS[theme] || THEME_FAB_COLORS.blue;
      toggleBtnRef.style.background = colors.bg;
      toggleBtnRef.style.boxShadow = `0 4px 12px ${colors.shadow}`;
    }
    // Update the theme toggle button indicator
    if (shadowRoot) {
      const themeBtn = shadowRoot.getElementById('jmThemeToggle');
      if (themeBtn) {
        themeBtn.textContent = THEME_ICONS[theme] || THEME_ICONS.blue;
        const nextIdx = (THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length;
        const nextName = THEME_ORDER[nextIdx] === 'blue' ? 'Ocean Blue' : THEME_ORDER[nextIdx] === 'dark' ? 'Dark Mode' : 'Warm Amber';
        themeBtn.title = `Switch to ${nextName}`;
      }
    }
  }

  /**
   * Cycles to the next theme, saves it, and applies it.
   */
  async function cycleTheme() {
    const idx = THEME_ORDER.indexOf(_currentTheme);
    const nextTheme = THEME_ORDER[(idx + 1) % THEME_ORDER.length];
    _currentTheme = nextTheme;
    try {
      await chrome.storage.local.set({ jm_theme: nextTheme });
    } catch (e) { /* ignore */ }
    applyTheme(nextTheme);
  }

  /**
   * Loads the saved theme from storage and applies it.
   */
  async function loadTheme() {
    try {
      const result = await chrome.storage.local.get('jm_theme');
      const theme = result.jm_theme || 'blue';
      if (THEME_ORDER.includes(theme)) {
        applyTheme(theme);
      }
    } catch (e) { /* ignore */ }
  }

  // ─── Shadow DOM panel creation ──────────────────────────────────
  // The panel lives entirely inside a closed Shadow DOM so that:
  //   • The host page's CSS cannot override the panel's styles.
  //   • The panel's CSS cannot leak out and break the host page.
  //   • The panel's DOM is inaccessible to page scripts (mode: 'closed').

  /**
   * Creates the side panel Shadow DOM, injects styles and HTML, and wires events.
   * Called once on first use (lazy init — not on script inject).
   */
  function createPanel() {
    const host = document.createElement('div');
    host.id = 'jobmatch-ai-panel-host';
    // Same defensive inline styles as the toggle host — keep the panel
    // host alive against page CSS that broad-targets body's children.
    [
      ['display', 'block'], ['visibility', 'visible'], ['opacity', '1'],
      ['position', 'fixed'], ['top', '0'], ['left', '0'],
      ['width', '0'], ['height', '0'],
      ['z-index', '2147483647'],
      ['pointer-events', 'none'],
      ['transform', 'none'], ['filter', 'none'], ['clip', 'auto'],
      ['margin', '0'], ['padding', '0'], ['border', '0'],
    ].forEach(([k, v]) => host.style.setProperty(k, v, 'important'));
    document.body.appendChild(host);

    shadowRoot = host.attachShadow({ mode: 'closed' });
    panelRoot = host;

    const style = document.createElement('style');
    style.textContent = getPanelCSS();
    shadowRoot.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'jm-panel';
    panel.innerHTML = getPanelHTML();
    shadowRoot.appendChild(panel);

    // Wire up event listeners inside shadow DOM
    wireEvents(panel);

    // Load and apply saved theme
    loadTheme();

    return host;
  }

  /**
   * Returns the full CSS string for the side panel Shadow DOM.
   * All selectors are scoped inside the shadow root so they cannot
   * affect or be affected by the host page's stylesheet.
   * @returns {string} CSS text to inject into a <style> element.
   */
  function getPanelCSS() {
    return `
      * { margin: 0; padding: 0; box-sizing: border-box; }

      /* ── Theme CSS Variables ── */
      #jm-panel {
        --jm-primary: #3b82f6;
        --jm-primary-hover: #2563eb;
        --jm-bg: #ffffff;
        --jm-card-bg: #f8fafc;
        --jm-border: #e2e8f0;
        --jm-text: #1e293b;
        --jm-text-secondary: #64748b;
        --jm-text-muted: #94a3b8;
        --jm-tag-bg: #dbeafe;
        --jm-tag-text: #1e40af;
        --jm-hover-bg: #eff6ff;
        --jm-input-bg: #f8fafc;
        --jm-shadow: rgba(59,130,246,0.15);
        --jm-nav-inactive-bg: #f1f5f9;
        --jm-nav-inactive-text: #64748b;
      }

      #jm-panel.theme-dark {
        --jm-primary: #3b82f6;
        --jm-primary-hover: #2563eb;
        --jm-bg: #1e293b;
        --jm-card-bg: #0f172a;
        --jm-border: #334155;
        --jm-text: #f1f5f9;
        --jm-text-secondary: #cbd5e1;
        --jm-text-muted: #94a3b8;
        --jm-tag-bg: #1e3a5f;
        --jm-tag-text: #93c5fd;
        --jm-hover-bg: #334155;
        --jm-input-bg: #0f172a;
        --jm-shadow: rgba(0,0,0,0.3);
        --jm-nav-inactive-bg: #334155;
        --jm-nav-inactive-text: #94a3b8;
      }

      #jm-panel.theme-warm {
        --jm-primary: #d97706;
        --jm-primary-hover: #b45309;
        --jm-bg: #fffbf5;
        --jm-card-bg: #fefce8;
        --jm-border: #fde68a;
        --jm-text: #451a03;
        --jm-text-secondary: #92400e;
        --jm-text-muted: #a16207;
        --jm-tag-bg: #fef3c7;
        --jm-tag-text: #92400e;
        --jm-hover-bg: #fef9c3;
        --jm-input-bg: #fefce8;
        --jm-shadow: rgba(217,119,6,0.15);
        --jm-nav-inactive-bg: #fef3c7;
        --jm-nav-inactive-text: #92400e;
      }

      #jm-panel {
        position: fixed;
        top: 0;
        right: 0;
        width: 380px;
        height: 100vh;
        background: var(--jm-bg);
        box-shadow: none;
        display: flex;
        flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        color: var(--jm-text);
        overflow: hidden;
        transform: translateX(100%);
        transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        z-index: 2147483646;
        pointer-events: auto;
      }

      #jm-panel.open {
        transform: translateX(0);
        box-shadow: -4px 0 24px rgba(0,0,0,0.15);
      }

      .jm-header {
        background: var(--jm-primary);
        color: white;
        padding: 14px 16px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-shrink: 0;
        gap: 8px;
      }
      #jm-panel.theme-dark .jm-header { background: #1e3a5f !important; }
      #jm-panel.theme-warm .jm-header { background: #d97706 !important; }

      .jm-header h2 { font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px; margin: 0; flex: 1; min-width: 0; }
      .jm-header h2 > .jm-icon { font-size: 30px; line-height: 1; flex-shrink: 0; }
      .jm-header .jm-title-text { display: flex; flex-direction: column; min-width: 0; }
      .jm-header .jm-title-text .jm-main-title { font-size: 16px; font-weight: 700; line-height: 1.2; white-space: nowrap; }
      .jm-header .jm-title-text .jm-subtitle { font-size: 10px; font-weight: 400; opacity: 0.75; line-height: 1.2; white-space: nowrap; }

      /* Theme toggle button */
      .jm-theme-btn {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        border: 2px solid rgba(255,255,255,0.4);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(255,255,255,0.15);
        color: #fff;
        font-size: 14px;
        transition: background 0.15s;
        flex-shrink: 0;
        padding: 0;
      }
      .jm-theme-btn:hover {
        background: rgba(255,255,255,0.3);
      }
      /* subtitle is now styled via .jm-title-text .jm-subtitle */

      .jm-close {
        background: rgba(255,255,255,0.2);
        border: none;
        color: white;
        width: 28px;
        height: 28px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.2s;
      }
      .jm-close:hover { background: rgba(255,255,255,0.35); }

      .jm-nav {
        display: flex;
        background: var(--jm-bg);
        border-bottom: 1px solid var(--jm-border);
        flex-shrink: 0;
      }

      .jm-nav-btn {
        flex: 1;
        padding: 9px 0;
        border: none;
        background: none;
        font-size: 12px;
        font-weight: 500;
        color: var(--jm-nav-inactive-text);
        cursor: pointer;
        transition: color 0.2s, background 0.2s;
        font-family: inherit;
        text-align: center;
      }

      .jm-nav-btn:hover {
        color: var(--jm-primary);
        background: var(--jm-hover-bg);
      }

      .jm-nav-btn.active {
        color: var(--jm-primary);
        border-bottom: 2px solid var(--jm-primary);
        font-weight: 600;
      }

      .jm-body {
        flex: 1;
        overflow-y: auto;
        padding: 20px;
      }

      .jm-actions {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-bottom: 20px;
      }

      .jm-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 10px 14px;
        border: none;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s;
        font-family: inherit;
      }

      .jm-btn-primary {
        background: var(--jm-primary);
        color: white;
      }
      .jm-btn-primary:hover { background: var(--jm-primary-hover); }

      .jm-btn-secondary {
        background: var(--jm-border);
        color: var(--jm-text-secondary);
      }
      .jm-btn-secondary:hover { background: var(--jm-hover-bg); }

      .jm-btn-success {
        background: #d1fae5;
        color: #059669;
      }
      .jm-btn-success:hover { background: #a7f3d0; }

      .jm-btn-applied {
        background: var(--jm-primary);
        color: white;
      }
      .jm-btn-applied:hover { background: var(--jm-primary-hover); }

      .jm-btn-applied-done {
        background: #93c5fd;
        color: #581c87;
        cursor: default;
      }

      .jm-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      /* Autofill review warning */
      .jm-autofill-warning {
        position: relative;
        display: flex;
        align-items: flex-start;
        gap: 10px;
        background: #fef3c7;
        border: 1px solid #fcd34d;
        border-left: 4px solid #f59e0b;
        border-radius: 10px;
        padding: 12px 36px 12px 14px;
        margin-top: 10px;
        animation: jm-fade-in 0.2s ease;
      }
      #jm-panel.theme-dark .jm-autofill-warning {
        background: #2d2006;
        border-color: #92400e;
        border-left-color: #f59e0b;
      }
      .jm-autofill-warning-icon {
        font-size: 18px;
        line-height: 1;
        flex-shrink: 0;
        margin-top: 1px;
      }
      .jm-autofill-warning-text {
        display: flex;
        flex-direction: column;
        gap: 3px;
        font-size: 12px;
        color: #78350f;
        line-height: 1.5;
      }
      #jm-panel.theme-dark .jm-autofill-warning-text { color: #fcd34d; }
      .jm-autofill-warning-text strong { font-size: 13px; }
      .jm-autofill-warning-close {
        position: absolute;
        top: 8px;
        right: 8px;
        background: none;
        border: none;
        cursor: pointer;
        font-size: 12px;
        color: #92400e;
        padding: 2px 4px;
        border-radius: 4px;
        line-height: 1;
        opacity: 0.7;
      }
      .jm-autofill-warning-close:hover { opacity: 1; background: rgba(0,0,0,0.08); }

      /* Status bar */
      .jm-status {
        padding: 10px 14px;
        border-radius: 8px;
        font-size: 13px;
        margin-bottom: 16px;
        display: none;
      }
      .jm-status.info { display: block; background: var(--jm-tag-bg); color: var(--jm-tag-text); }
      .jm-status.error { display: block; background: #fee2e2; color: #dc2626; }
      .jm-status.success { display: block; background: #d1fae5; color: #059669; }

      /* Loading spinner */
      .jm-spinner {
        display: inline-block;
        width: 16px;
        height: 16px;
        border: 2px solid rgba(255,255,255,0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: jm-spin 0.6s linear infinite;
      }
      @keyframes jm-spin { to { transform: rotate(360deg); } }

      /* Score display */
      .jm-score-section {
        text-align: center;
        margin-bottom: 16px;
        padding: 16px 14px;
        display: none;
        background: var(--jm-card-bg);
        border-radius: 10px;
        border: 1px solid var(--jm-border);
      }

      .jm-score-circle {
        width: 80px;
        height: 80px;
        border-radius: 50%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 28px;
        font-weight: 700;
        color: white;
        margin-bottom: 6px;
      }

      .jm-score-label { font-size: 13px; color: var(--jm-text-secondary); }

      .score-green { background: linear-gradient(135deg, #10b981, #059669); }
      .score-amber { background: linear-gradient(135deg, #f59e0b, #d97706); }
      .score-red { background: linear-gradient(135deg, #ef4444, #dc2626); }

      /* Sections */
      .jm-section {
        margin-bottom: 20px;
        padding: 14px;
        display: none;
        overflow: hidden;
        background: var(--jm-card-bg);
        border-radius: 10px;
        border: 1px solid var(--jm-border);
      }
      /* Sections that contain card children (bullets, cover letter) — no card bg */
      #jmBulletSection, #jmCoverLetterSection {
        background: none;
        border: none;
        padding: 0;
        overflow: visible;
      }

      /* Tailored Resume Section */
      #jmTailoredResumeSection {
        background: none;
        border: none;
        padding: 0;
        overflow: visible;
      }
      .jm-resume-status-card {
        background: var(--jm-card-bg);
        border: 1px solid var(--jm-border);
        border-radius: 12px;
        padding: 14px 16px;
        font-size: 13px;
        line-height: 1.6;
        color: var(--jm-text);
      }
      .jm-resume-status-card.success { border-left: 3px solid var(--jm-success, #16a34a); }
      .jm-resume-status-card.error { border-left: 3px solid #dc2626; }
      .jm-resume-status-card .jm-resume-stat-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
        font-size: 13px;
      }
      .jm-resume-status-card .jm-resume-stat-row:last-child { margin-bottom: 0; }
      .jm-resume-status-card .jm-resume-warn {
        font-size: 11px;
        color: #b45309;
        background: #fef3c7;
        border-radius: 6px;
        padding: 6px 10px;
        margin-top: 8px;
        line-height: 1.5;
      }

      .jm-section h3 {
        font-size: 11px;
        font-weight: 700;
        color: var(--jm-text-secondary);
        margin-bottom: 12px;
        text-transform: uppercase;
        letter-spacing: 0.8px;
      }

      /* Skill tags */
      .jm-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .jm-tag {
        padding: 5px 10px;
        border-radius: 6px;
        font-size: 11px;
        font-weight: 500;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        line-height: 1.2;
      }

      .jm-tag-match { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; }
      .jm-tag-missing { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
      .jm-tag-keyword { background: var(--jm-tag-bg); color: var(--jm-tag-text); border: 1px solid var(--jm-border); }

      /* Recommendations */
      .jm-recs {
        list-style: none;
        padding: 0;
        margin: 0;
      }

      .jm-recs li {
        padding: 6px 0;
        border-bottom: 1px solid var(--jm-border);
        font-size: 12px;
        line-height: 1.5;
        color: var(--jm-text);
      }
      .jm-recs li:last-child { border-bottom: none; }

      .jm-recs li::before {
        content: '\\2192 ';
        color: var(--jm-primary);
        font-weight: 600;
      }

      /* Insights */
      .jm-insight-block {
        background: var(--jm-card-bg);
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 8px;
        border: 1px solid var(--jm-border);
      }

      .jm-insight-block h4 {
        font-size: 12px;
        font-weight: 600;
        color: var(--jm-primary);
        margin-bottom: 4px;
        text-transform: uppercase;
      }

      .jm-insight-block p {
        font-size: 13px;
        color: var(--jm-text-secondary);
        line-height: 1.5;
      }

      /* Job info card */
      .jm-job-info {
        background: var(--jm-card-bg);
        border-radius: 12px;
        padding: 14px;
        margin-bottom: 16px;
        border: 1px solid var(--jm-border);
        display: none;
      }

      .jm-job-info .jm-job-title {
        font-weight: 700;
        font-size: 14px;
        color: var(--jm-text);
        line-height: 1.35;
        word-wrap: break-word;
        overflow-wrap: break-word;
      }

      .jm-job-info .jm-job-company {
        font-size: 13px;
        font-weight: 500;
        color: var(--jm-primary);
        margin-top: 3px;
      }

      .jm-job-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 10px;
      }

      .jm-job-meta span {
        font-size: 10px;
        color: var(--jm-text-secondary);
        display: inline-flex;
        align-items: center;
        gap: 3px;
        line-height: 1;
        background: var(--jm-surface, rgba(128,128,128,0.08));
        padding: 4px 8px;
        border-radius: 5px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 100%;
      }

      /* Backdrop (transparent overlay to capture outside clicks) */
      .jm-backdrop {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: transparent;
        z-index: 2147483645;
        /* Host has pointer-events:none to never block page clicks on the
           rest of the viewport; backdrop opts back in so click-outside
           still closes the panel. */
        pointer-events: auto;
      }

      /* Toggle button (outside panel) */
      .jm-toggle {
        position: fixed;
        width: 42px;
        height: 42px;
        border-radius: 50%;
        background: var(--jm-fab-bg, #3b82f6);
        color: white;
        border: none;
        cursor: grab;
        box-shadow: 0 4px 12px var(--jm-fab-shadow, rgba(59,130,246,0.4));
        font-size: 30px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: box-shadow 0.2s, transform 0.2s;
        z-index: 2147483647;
        user-select: none;
        touch-action: none;
        /* Host element sets pointer-events:none so it never blocks page
           clicks on transparent areas; restore it here so the button
           itself stays clickable. */
        pointer-events: auto;
      }
      .jm-toggle:hover {
        transform: scale(1.1);
        box-shadow: 0 6px 16px var(--jm-fab-shadow, rgba(59,130,246,0.5));
      }
      .jm-toggle.dragging {
        cursor: grabbing;
        transform: scale(1.1);
        box-shadow: 0 8px 20px var(--jm-fab-shadow, rgba(59,130,246,0.6));
        transition: none;
      }

      /* Outline button */
      .jm-btn-outline {
        background: var(--jm-bg);
        border: 1.5px solid var(--jm-primary);
        color: var(--jm-primary);
      }
      .jm-btn-outline:hover { background: var(--jm-hover-bg); }

      /* Truncation notice */
      .jm-trunc-notice {
        font-size: 11px;
        color: #92400e;
        background: #fffbeb;
        border: 1px solid #fde68a;
        border-radius: 5px;
        padding: 6px 10px;
        margin-bottom: 10px;
        display: none;
      }

      /* Cover letter */
      .jm-cover-letter {
        background: var(--jm-card-bg);
        border: 1px solid var(--jm-border);
        border-radius: 8px;
        padding: 12px 14px;
        font-size: 12.5px;
        line-height: 1.7;
        color: var(--jm-text);
        white-space: pre-wrap;
        max-height: 260px;
        overflow-y: auto;
        margin-bottom: 8px;
      }
      /* Action button group inside a section head (Copy + Download dropdown) */
      .jm-section-head-actions {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      /* Download dropdown — sits to the right of the Copy button */
      .jm-download-wrap {
        position: relative;
        display: inline-block;
      }
      .jm-download-menu {
        position: absolute;
        top: 100%;
        right: 0;
        min-width: 120px;
        margin-top: 4px;
        background: var(--jm-bg);
        border: 1px solid var(--jm-border);
        border-radius: 4px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        z-index: 10;
        padding: 4px 0;
      }
      .jm-download-menu[hidden] {
        display: none;
      }
      .jm-download-item {
        display: block;
        width: 100%;
        padding: 8px 12px;
        text-align: left;
        background: none;
        border: none;
        color: var(--jm-text);
        cursor: pointer;
        font-size: 13px;
        font-family: inherit;
      }
      .jm-download-item:hover:not(:disabled) {
        background: var(--jm-hover-bg);
      }
      .jm-download-item:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .jm-copy-btn {
        font-size: 12px;
        padding: 5px 12px;
        float: right;
        margin-top: -2px;
      }
      .jm-section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
      }
      .jm-section-head h3 { margin-bottom: 0; }

      /* Bullet rewriter */
      .jm-bullet-item {
        background: var(--jm-card-bg);
        border: 1px solid var(--jm-border);
        border-radius: 12px;
        padding: 14px;
        margin-bottom: 12px;
      }
      .jm-bullet-item.jm-custom-bullet { border-left: 3px solid var(--jm-primary); }
      .jm-bullet-item.jm-excluded { opacity: 0.4; }
      .jm-bullet-item.jm-excluded .jm-bullet-after { text-decoration: line-through; }

      .jm-bullet-job {
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.3px;
        color: var(--jm-primary);
        white-space: normal;
        word-wrap: break-word;
        line-height: 1.3;
      }

      .jm-bullet-before {
        font-size: 11px;
        color: var(--jm-text-muted);
        text-decoration: line-through;
        margin: 10px 0 8px;
        line-height: 1.5;
        padding: 8px 10px;
        background: rgba(128,128,128,0.04);
        border-radius: 6px;
      }

      .jm-bullet-after {
        font-size: 12px;
        color: var(--jm-text);
        margin-bottom: 10px;
        line-height: 1.6;
        padding: 8px 10px;
        border-radius: 8px;
        border: 1px solid var(--jm-border);
        background: rgba(128,128,128,0.02);
        transition: border-color 0.15s, background 0.15s;
        outline: none;
      }
      .jm-bullet-after:hover {
        border-color: var(--jm-primary);
        background: rgba(128,128,128,0.04);
      }
      .jm-bullet-after:focus {
        border-color: var(--jm-primary);
        background: var(--jm-card-bg);
        box-shadow: 0 0 0 2px rgba(59,130,246,0.1);
      }

      /* Skills button & panel */
      .jm-bullet-skills-btn {
        font-size: 10px;
        padding: 3px 8px;
        cursor: pointer;
        background: none;
        border: 1px solid var(--jm-border);
        border-radius: 5px;
        color: var(--jm-text-secondary);
        transition: all 0.15s;
        margin-left: auto;
        white-space: nowrap;
      }
      .jm-bullet-skills-btn:hover {
        border-color: var(--jm-primary);
        color: var(--jm-primary);
      }
      .jm-bullet-skills-btn.jm-active {
        border-color: var(--jm-primary);
        color: var(--jm-primary);
        background: rgba(59,130,246,0.08);
      }

      .jm-bullet-skills-panel {
        display: none;
        margin: 8px 0 4px;
        padding: 10px 12px;
        background: rgba(128,128,128,0.03);
        border: 1px solid var(--jm-border);
        border-radius: 8px;
      }
      .jm-bullet-skills-panel.jm-open { display: block; }

      .jm-bullet-skills-label {
        font-size: 9px;
        font-weight: 700;
        color: var(--jm-text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.6px;
        margin-bottom: 8px;
      }

      .jm-bullet-skills-list {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .jm-skill-chip {
        font-size: 10px;
        padding: 4px 9px;
        border-radius: 6px;
        cursor: pointer;
        border: 1px solid rgba(59,130,246,0.3);
        color: var(--jm-primary);
        background: rgba(59,130,246,0.06);
        transition: all 0.15s;
        user-select: none;
        line-height: 1.2;
      }
      .jm-skill-chip:hover {
        border-color: var(--jm-primary);
        background: rgba(59,130,246,0.12);
      }
      .jm-skill-chip.jm-excluded-skill {
        border-color: var(--jm-border);
        color: var(--jm-text-muted);
        background: transparent;
        text-decoration: line-through;
        opacity: 0.45;
      }
      /* Add bullet area */
      .jm-add-bullet-area {
        margin-top: 14px;
        padding: 14px;
        border: 1px dashed var(--jm-border);
        border-radius: 10px;
        background: var(--jm-card-bg);
      }
      .jm-add-bullet-area.jm-open { border-style: solid; border-color: var(--jm-primary); }
      .jm-add-bullet-trigger {
        width: 100%;
        padding: 8px;
        border: none;
        background: none;
        color: var(--jm-primary);
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        text-align: center;
      }
      .jm-add-bullet-trigger:hover { text-decoration: underline; }
      .jm-add-bullet-form { display: none; }
      .jm-add-bullet-form.jm-open { display: block; }
      .jm-add-bullet-select {
        width: 100%;
        padding: 8px 10px;
        font-size: 12px;
        border: 1px solid var(--jm-border);
        border-radius: 8px;
        background: var(--jm-card-bg);
        color: var(--jm-text);
        margin-bottom: 8px;
      }
      .jm-add-bullet-input {
        width: 100%;
        padding: 10px;
        font-size: 12px;
        border: 1px solid var(--jm-border);
        border-radius: 8px;
        background: var(--jm-card-bg);
        color: var(--jm-text);
        resize: vertical;
        min-height: 60px;
        font-family: inherit;
        outline: none;
        line-height: 1.5;
      }
      .jm-add-bullet-input:focus { border-color: var(--jm-primary); }
      .jm-add-bullet-actions { display: flex; gap: 8px; margin-top: 10px; }

      /* "New" tag for custom bullets */
      .jm-bullet-custom-tag {
        font-size: 9px;
        background: var(--jm-primary);
        color: white;
        padding: 3px 8px;
        border-radius: 5px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        line-height: 1;
        flex-shrink: 0;
        margin-top: 1px;
      }

      /* Bullet action buttons (Copy, Refresh) */
      .jm-bullet-actions {
        display: flex;
        gap: 8px;
        align-items: center;
        padding-top: 4px;
      }
      .jm-bullet-copy {
        font-size: 10px;
        padding: 4px 10px;
        border-radius: 5px;
      }
      .jm-bullet-refresh {
        font-size: 12px;
        padding: 4px 8px;
        cursor: pointer;
        background: none;
        border: 1px solid var(--jm-border);
        border-radius: 5px;
        color: var(--jm-text-secondary);
        transition: all 0.15s;
      }
      .jm-bullet-refresh:hover {
        border-color: var(--jm-primary);
        color: var(--jm-primary);
        background: rgba(59,130,246,0.06);
      }
      .jm-bullet-refresh:disabled { opacity: 0.4; cursor: not-allowed; }
      @keyframes jm-spin-refresh { to { transform: rotate(360deg); } }
      .jm-bullet-refresh.jm-spinning { animation: jm-spin-refresh 0.8s linear infinite; }

      /* Bullet header row */
      .jm-bullet-header {
        display: flex;
        align-items: flex-start;
        gap: 8px;
      }
      .jm-bullet-toggle-wrap {
        position: relative;
        flex-shrink: 0;
      }
      .jm-bullet-toggle { width: 14px; height: 14px; accent-color: var(--jm-primary); cursor: pointer; }
      .jm-bullet-toggle-wrap::before {
        content: attr(data-tip);
        position: absolute;
        bottom: calc(100% + 8px);
        left: 0;
        background: #1e293b;
        color: #f1f5f9;
        font-size: 11px;
        font-weight: 500;
        line-height: 1.4;
        padding: 6px 10px;
        border-radius: 6px;
        white-space: nowrap;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.15s ease;
        z-index: 10;
      }
      .jm-bullet-toggle-wrap::after {
        content: '';
        position: absolute;
        bottom: calc(100% + 2px);
        left: 7px;
        border: 5px solid transparent;
        border-top-color: #1e293b;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.15s ease;
        z-index: 10;
      }
      .jm-bullet-toggle-wrap:hover::before,
      .jm-bullet-toggle-wrap:hover::after {
        opacity: 1;
      }
      .jm-bullet-item.jm-excluded { opacity: 0.45; }
      .jm-bullet-item.jm-excluded .jm-bullet-after { text-decoration: line-through; }

      /* Job notes */
      .jm-notes-section {
        border-top: 1px solid var(--jm-border);
        margin-top: 12px;
        padding-top: 12px;
      }
      .jm-notes-section h3 {
        font-size: 12px;
        font-weight: 600;
        color: var(--jm-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 6px;
      }
      .jm-notes-textarea {
        width: 100%;
        resize: vertical;
        border: 1px solid var(--jm-border);
        border-radius: 6px;
        padding: 8px 10px;
        font-size: 12.5px;
        font-family: inherit;
        color: var(--jm-text);
        background: var(--jm-input-bg);
        min-height: 62px;
        box-sizing: border-box;
      }
      .jm-notes-textarea:focus {
        outline: none;
        border-color: var(--jm-primary);
        box-shadow: 0 0 0 2px var(--jm-shadow);
      }

      /* Resume slot switcher */
      .jm-resume-switcher {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
        flex-wrap: wrap;
      }
      .jm-switch-label {
        font-size: 11px;
        font-weight: 600;
        color: var(--jm-text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        white-space: nowrap;
      }
      .jm-switch-pills {
        display: flex;
        gap: 4px;
        flex-wrap: wrap;
      }
      .jm-switch-pill {
        font-size: 11px;
        padding: 3px 10px;
        border-radius: 20px;
        border: 1.5px solid var(--jm-border);
        background: transparent;
        color: var(--jm-text-secondary);
        cursor: pointer;
        transition: all 0.15s;
        white-space: nowrap;
        max-width: 90px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .jm-switch-pill:hover:not(:disabled) {
        border-color: var(--jm-primary);
        color: var(--jm-primary);
      }
      .jm-switch-pill.active {
        background: var(--jm-primary);
        border-color: transparent;
        color: white;
        font-weight: 600;
      }
      .jm-switch-pill:disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }
      /* Local (no-AI) keyword-match score badge for the active resume.
         Deliberately a small pill (not the big AI score circle) so it
         never reads as the AI-generated match score. */
      .jm-local-score {
        font-size: 11px;
        font-weight: 700;
        padding: 3px 9px;
        border-radius: 20px;
        white-space: nowrap;
        margin-left: auto;
      }
      .jm-local-score-green { background: rgba(16,185,129,0.14); color: #059669; }
      .jm-local-score-amber { background: rgba(245,158,11,0.14); color: #d97706; }
      .jm-local-score-red   { background: rgba(239,68,68,0.14);  color: #dc2626; }
      .jm-download-resume-btn {
        font-size: 11px;
        font-weight: 600;
        padding: 3px 9px;
        border-radius: 20px;
        white-space: nowrap;
        border: 1.5px solid var(--jm-border);
        background: transparent;
        color: var(--jm-text-secondary);
        cursor: pointer;
        transition: all 0.15s;
      }
      .jm-download-resume-btn:hover {
        border-color: var(--jm-primary);
        color: var(--jm-primary);
      }

      /* Saved jobs tab */
      .jm-saved-list { display: flex; flex-direction: column; gap: 8px; }
      .jm-saved-card {
        background: var(--jm-card-bg); border-radius: 8px; padding: 12px;
        position: relative; border: 1px solid var(--jm-border);
        transition: border-color 0.15s;
      }
      .jm-saved-card:hover { border-color: var(--jm-primary); }
      .jm-saved-title { font-weight: 600; font-size: 13px; color: var(--jm-text); text-decoration: none; display: block; margin-bottom: 4px; }
      .jm-saved-title:hover { color: var(--jm-primary); }
      .jm-saved-company { font-size: 12px; color: var(--jm-text-secondary); }
      .jm-saved-meta { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 11px; color: var(--jm-text-muted); }
      .jm-saved-score { padding: 2px 8px; border-radius: 4px; color: #fff; font-weight: 600; font-size: 11px; }
      .jm-saved-delete {
        position: absolute; top: 8px; right: 8px;
        background: none; border: none; cursor: pointer;
        color: var(--jm-text-muted); font-size: 16px; line-height: 1;
        transition: color 0.15s;
      }
      .jm-saved-delete:hover { color: #ef4444; }
      .jm-saved-empty { text-align: center; color: var(--jm-text-muted); font-size: 13px; padding: 32px 16px; }

      /* Tab content visibility */
      .jm-tab-content { display: none; }
      .jm-tab-content.active { display: block; }

      @media (max-width: 500px) {
        #jm-panel { width: 100vw !important; }
        .jm-body { padding: 12px !important; }
      }
    `;
  }

  /**
   * Returns the static inner HTML string for the side panel.
   * Sections that are initially hidden (display:none) are shown
   * programmatically after analysis / autofill completes.
   * @returns {string} HTML markup for the panel body.
   */
  function getPanelHTML() {
    return `
      <div class="jm-header">
        <h2>
          <span class="jm-icon">&#9733;</span>
          <div class="jm-title-text">
            <span class="jm-main-title">JobMatch AI</span>
            <span class="jm-subtitle">Resume &amp; Job Analyzer</span>
          </div>
        </h2>
        <div style="display:flex;align-items:center;gap:8px;">
          <button class="jm-theme-btn" id="jmThemeToggle" title="Switch theme">&#9728;&#65039;</button>
        </div>
      </div>
      <div class="jm-nav">
        <button class="jm-nav-btn" data-nav="profile">Profile</button>
        <button class="jm-nav-btn" data-nav="qa">Q&A</button>
        <button class="jm-nav-btn" data-nav="saved">Saved</button>
        <button class="jm-nav-btn" data-nav="settings">Settings</button>
      </div>
      <div class="jm-body">
        <!-- Saved Jobs tab -->
        <div class="jm-tab-content" id="jmSavedTab">
          <div class="jm-saved-list" id="jmSavedList">
            <div class="jm-saved-empty" id="jmSavedEmpty">No saved jobs yet. Click 'Save Job' on any job posting to bookmark it.</div>
          </div>
        </div>

        <!-- Main content (default) -->
        <div class="jm-tab-content active" id="jmMainTab">
        <div class="jm-status" id="jmStatus"></div>

        <div class="jm-job-info" id="jmJobInfo">
          <div class="jm-job-title" id="jmJobTitle"></div>
          <div class="jm-job-company" id="jmJobCompany"></div>
          <div class="jm-job-meta">
            <span id="jmJobLocation" style="display:none">&#128205;&nbsp;<span id="jmJobLocationText"></span></span>
            <span id="jmJobLanguage" style="display:none">&#128172;&nbsp;<span id="jmJobLanguageText"></span></span>
            <span id="jmJobSalary" style="display:none">&#128176;&nbsp;<span id="jmJobSalaryText"></span></span>
            <span id="jmJobId" style="display:none">&#128196;&nbsp;ID: <span id="jmJobIdText"></span></span>
          </div>
        </div>

        <!-- Resume switcher -->
        <div class="jm-resume-switcher" id="jmResumeSwitch">
          <span class="jm-switch-label">Resume:</span>
          <div class="jm-switch-pills" id="jmSwitchPills"></div>
          <!-- Local (no-AI) ATS-keyword match score for the ACTIVE resume
               against the current JD — the same skills + certifications +
               project-technologies keyword set shown on the Profile tab's
               "ATS Keywords" list (lib/resumeKeywords.js), scored for
               overlap with this JD (lib/resumeRanker.js). Filled by
               updateLocalScoreChip(). Computed entirely in-browser — an
               instant, free preview shown before the user spends an AI call
               on Analyze. Hidden until a JD + at least one resume are
               available. -->
          <span class="jm-local-score" id="jmLocalScore" style="display:none"
                title="ATS keyword-match score (skills, certifications, project technologies) — computed instantly on-device, no AI call. Not the same as the AI-generated match score from Analyze."></span>
          <!-- Downloads the exact file (same bytes, same generated name)
               that AutoFill's resume-upload attachment would use for the
               currently active resume — lets the user open and check it
               before trusting AutoFill to attach it on a real form. Shown
               and hidden together with jmLocalScore by updateLocalScoreChip,
               since both depend on a resume having been scored/selected for
               the current JD. -->
          <button class="jm-download-resume-btn" id="jmDownloadResume" style="display:none"
                  title="Download the exact resume file AutoFill would attach, to check it yourself first">&#8681; Resume file</button>
        </div>
        <div class="jm-actions">
          <button class="jm-btn jm-btn-primary" id="jmAnalyze">Analyze Job</button>
          <button class="jm-btn jm-btn-secondary" id="jmAutofill">AutoFill Application</button>
          <button class="jm-btn jm-btn-success" id="jmSaveJob" style="display:none">Save Job</button>
          <button class="jm-btn jm-btn-applied" id="jmMarkApplied" style="display:none">Mark as Applied</button>
          <button class="jm-btn jm-btn-outline" id="jmCoverLetterBtn" style="display:none">&#9993; Cover Letter</button>
          <button class="jm-btn jm-btn-outline" id="jmRewriteBulletsBtn" style="display:none">&#9997; Improve Resume Bullets</button>
          <button class="jm-btn jm-btn-outline" id="jmTailoredResumeBtn" style="display:none">&#128196; Generate Tailored Resume</button>
        </div>

        <div class="jm-autofill-warning" id="jmAutofillWarning" style="display:none">
          <button class="jm-autofill-warning-close" id="jmAutofillWarningClose" title="Dismiss">&#10005;</button>
          <div class="jm-autofill-warning-icon">&#9888;</div>
          <div class="jm-autofill-warning-text">
            <strong>Review before submitting</strong>
            <span>AI can make mistakes. Please check every autofilled answer on the form before hitting Submit.</span>
          </div>
        </div>

        <div class="jm-score-section" id="jmScoreSection">
          <div class="jm-score-circle" id="jmScoreCircle">--</div>
          <div class="jm-score-label">Match Score</div>
        </div>

        <div class="jm-section" id="jmMatchingSection">
          <h3>Matching Skills</h3>
          <div class="jm-tags" id="jmMatchingSkills"></div>
        </div>

        <div class="jm-section" id="jmMissingSection">
          <h3>Missing Skills</h3>
          <div class="jm-tags" id="jmMissingSkills"></div>
        </div>

        <div class="jm-section" id="jmRecsSection">
          <h3>Recommendations</h3>
          <ul class="jm-recs" id="jmRecs"></ul>
        </div>

        <div class="jm-section" id="jmInsightsSection">
          <h3>Insights</h3>
          <div id="jmInsights"></div>
        </div>

        <div class="jm-section" id="jmKeywordsSection">
          <h3>ATS Keywords</h3>
          <div class="jm-tags" id="jmKeywords"></div>
        </div>

        <!-- Truncation notice. There used to be a second "Your resume was
             truncated" banner here, but its underlying truncated flag
             (background.js handleAnalyzeJob) was set by the exact same
             condition as jdTruncated below it — a copy-paste bug, not a
             real resume-length check (nothing in the analyze prompt ever
             truncates the resume). It always fired together with this one
             and was factually wrong about which text got cut, so it was
             removed rather than fixed to say something accurate. -->
        <div class="jm-trunc-notice" id="jmTruncNotice">
          &#9888; Job description trimmed (too long) — match score may be approximate.
        </div>

        <!-- Cover letter output -->
        <div class="jm-section" id="jmCoverLetterSection" style="display:none">
          <div class="jm-section-head">
            <h3>Cover Letter</h3>
            <div class="jm-section-head-actions">
              <button class="jm-btn jm-btn-secondary jm-copy-btn" id="jmCopyCoverLetter">Copy</button>
              <div class="jm-download-wrap">
                <button class="jm-btn jm-btn-secondary" id="jmDownloadCoverLetter" type="button" aria-haspopup="menu" aria-expanded="false">Download &#9662;</button>
                <div class="jm-download-menu" id="jmDownloadCoverLetterMenu" role="menu" hidden>
                  <button class="jm-download-item" type="button" data-fmt="docx" role="menuitem">.docx</button>
                  <button class="jm-download-item" type="button" data-fmt="pdf"  role="menuitem">.pdf</button>
                </div>
              </div>
            </div>
          </div>
          <div class="jm-cover-letter" id="jmCoverLetterText"></div>
        </div>

        <!-- Bullet rewriter output -->
        <div class="jm-section" id="jmBulletSection" style="display:none">
          <h3>Improved Resume Bullets</h3>
          <div id="jmBulletList"></div>
          <div class="jm-add-bullet-area" id="jmAddBulletArea" style="display:none;">
            <button class="jm-add-bullet-trigger" id="jmAddBulletTrigger">+ Add Custom Bullet</button>
            <div class="jm-add-bullet-form" id="jmAddBulletForm">
              <label style="font-size:11px;font-weight:600;color:var(--jm-text-secondary);display:block;margin-bottom:4px;">Add under:</label>
              <select class="jm-add-bullet-select" id="jmAddBulletTarget"></select>
              <label style="font-size:11px;font-weight:600;color:var(--jm-text-secondary);display:block;margin-bottom:4px;">Describe what you did:</label>
              <textarea class="jm-add-bullet-input" id="jmAddBulletInput" placeholder="e.g. built a dashboard for tracking sales metrics using React and D3..."></textarea>
              <div class="jm-add-bullet-actions">
                <button class="jm-btn jm-btn-primary" id="jmAddBulletGenerate" style="font-size:11px;padding:5px 14px;">Generate</button>
                <button class="jm-btn jm-btn-secondary" id="jmAddBulletCancel" style="font-size:11px;padding:5px 14px;">Cancel</button>
              </div>
            </div>
          </div>
          <button class="jm-btn jm-btn-outline" id="jmTailoredResumeBtnBottom" style="display:none;margin-top:10px;width:100%;">&#128196; Generate Tailored Resume</button>
        </div>

        <!-- Tailored resume output -->
        <div class="jm-section" id="jmTailoredResumeSection" style="display:none">
          <h3>Tailored Resume</h3>
          <div id="jmTailoredResumeStatus" class="jm-resume-status-card"></div>
        </div>

        <!-- Job notes (always visible) -->
        <div class="jm-notes-section">
          <h3>Notes</h3>
          <textarea class="jm-notes-textarea" id="jmNotesInput" placeholder="Add notes about this job — saved automatically..."></textarea>
        </div>
        </div><!-- end jmMainTab -->
      </div>
    `;
  }

  /**
   * Attaches all button click listeners and tab-switch handlers to the panel.
   * Called once after the panel HTML is injected into the Shadow DOM.
   * @param {HTMLElement} panel - The #jm-panel element inside the Shadow DOM.
   */
  function wireEvents(panel) {
    panel.querySelector('#jmAnalyze').addEventListener('click', () => {
      const btn = shadowRoot.getElementById('jmAnalyze');
      // If button says "Re-Analyze", force refresh; otherwise use cache
      const forceRefresh = btn.textContent.trim() === 'Re-Analyze';
      analyzeJob(forceRefresh);
    });
    panel.querySelector('#jmAutofill').addEventListener('click', autofillForm);
    panel.querySelector('#jmDownloadResume').addEventListener('click', downloadActiveResumeFile);
    panel.querySelector('#jmAutofillWarningClose').addEventListener('click', () => {
      shadowRoot.getElementById('jmAutofillWarning').style.display = 'none';
    });
    panel.querySelector('#jmSaveJob').addEventListener('click', saveJob);

    panel.querySelector('#jmMarkApplied').addEventListener('click', markApplied);
    panel.querySelector('#jmCoverLetterBtn').addEventListener('click', generateCoverLetter);
    panel.querySelector('#jmRewriteBulletsBtn').addEventListener('click', rewriteBullets);
    panel.querySelector('#jmTailoredResumeBtn').addEventListener('click', generateTailoredResume);
    panel.querySelector('#jmTailoredResumeBtnBottom').addEventListener('click', generateTailoredResume);

    // Add custom bullet UI
    panel.querySelector('#jmAddBulletTrigger').addEventListener('click', () => {
      const form = shadowRoot.getElementById('jmAddBulletForm');
      const area = shadowRoot.getElementById('jmAddBulletArea');
      const trigger = shadowRoot.getElementById('jmAddBulletTrigger');
      form.classList.add('jm-open');
      area.classList.add('jm-open');
      trigger.style.display = 'none';
      populateAddBulletDropdown();
    });
    panel.querySelector('#jmAddBulletCancel').addEventListener('click', () => {
      shadowRoot.getElementById('jmAddBulletForm').classList.remove('jm-open');
      shadowRoot.getElementById('jmAddBulletArea').classList.remove('jm-open');
      shadowRoot.getElementById('jmAddBulletTrigger').style.display = '';
      shadowRoot.getElementById('jmAddBulletInput').value = '';
    });
    panel.querySelector('#jmAddBulletGenerate').addEventListener('click', generateCustomBullet);
    panel.querySelector('#jmCopyCoverLetter').addEventListener('click', () => {
      const text = shadowRoot.getElementById('jmCoverLetterText').textContent;
      navigator.clipboard.writeText(text).then(() => {
        const btn = shadowRoot.getElementById('jmCopyCoverLetter');
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = orig; }, 1500);
      }).catch(() => {});
    });

    // ── Cover letter Download dropdown ──
    const downloadBtn  = panel.querySelector('#jmDownloadCoverLetter');
    const downloadMenu = panel.querySelector('#jmDownloadCoverLetterMenu');

    function closeDownloadMenu() {
      if (!downloadMenu) return;
      downloadMenu.hidden = true;
      downloadBtn.setAttribute('aria-expanded', 'false');
    }
    function openDownloadMenu() {
      if (!downloadMenu) return;
      downloadMenu.hidden = false;
      downloadBtn.setAttribute('aria-expanded', 'true');
    }

    if (downloadBtn && downloadMenu) {
      downloadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (downloadMenu.hidden) openDownloadMenu();
        else closeDownloadMenu();
      });

      // Outside-click closes the menu. We listen on the shadow root so we
      // only see clicks inside our shadow DOM — page clicks come through as
      // a separate event on document, which is fine since they don't
      // intersect with the menu's coordinates anyway.
      shadowRoot.addEventListener('mousedown', (e) => {
        if (downloadMenu.hidden) return;
        if (!e.composedPath().includes(downloadBtn) &&
            !e.composedPath().includes(downloadMenu)) {
          closeDownloadMenu();
        }
      });

      // Escape closes and returns focus to the trigger.
      downloadMenu.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { closeDownloadMenu(); downloadBtn.focus(); }
      });
      downloadBtn.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !downloadMenu.hidden) {
          closeDownloadMenu();
        }
      });

      panel.querySelectorAll('.jm-download-item').forEach(item => {
        item.addEventListener('click', (e) => {
          const fmt = item.dataset.fmt;
          if (fmt === 'docx' || fmt === 'pdf') {
            downloadCoverLetter(fmt);
          }
        });
      });
    }

    panel.querySelector('#jmNotesInput').addEventListener('blur', saveJobNotes);
    panel.querySelector('#jmNotesInput').addEventListener('input', saveJobNotes);

    // Theme toggle button
    panel.querySelector('#jmThemeToggle').addEventListener('click', cycleTheme);

    // Nav buttons → open profile page at the right tab, or switch to Saved tab
    panel.querySelectorAll('.jm-nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.nav;
        if (tab === 'saved') {
          // Switch to Saved tab within the panel
          activateSavedTab();
        } else {
          // Deactivate Saved tab highlight if switching away
          deactivateSavedTab();
          // Fire-and-forget: route through sendMessage wrapper so an
          // invalidated extension context surfaces a clean error instead of
          // crashing the click handler.
          sendMessage({ type: 'OPEN_PROFILE_TAB', hash: tab }).catch(() => {});
        }
      });
    });
  }

  // ─── Saved Jobs tab ──────────────────────────────────────────

  /**
   * Activates the Saved tab: highlights the nav button, shows the saved
   * tab content, hides the main tab content, and fetches saved jobs.
   */
  function activateSavedTab() {
    if (!shadowRoot) return;
    // Highlight the Saved nav button
    shadowRoot.querySelectorAll('.jm-nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.nav === 'saved');
    });
    // Show saved tab, hide main tab
    const savedTab = shadowRoot.getElementById('jmSavedTab');
    const mainTab = shadowRoot.getElementById('jmMainTab');
    if (savedTab) savedTab.classList.add('active');
    if (mainTab) mainTab.classList.remove('active');
    // Fetch and render saved jobs each time the tab is activated
    loadSavedJobs();
  }

  /**
   * Deactivates the Saved tab: removes nav highlight, hides saved tab,
   * and restores the main tab content.
   */
  function deactivateSavedTab() {
    if (!shadowRoot) return;
    shadowRoot.querySelectorAll('.jm-nav-btn').forEach(btn => {
      btn.classList.remove('active');
    });
    const savedTab = shadowRoot.getElementById('jmSavedTab');
    const mainTab = shadowRoot.getElementById('jmMainTab');
    if (savedTab) savedTab.classList.remove('active');
    if (mainTab) mainTab.classList.add('active');
  }

  /**
   * Fetches saved jobs from background.js and renders them in the Saved tab.
   * @async
   */
  async function loadSavedJobs() {
    if (!shadowRoot) return;
    const list = shadowRoot.getElementById('jmSavedList');
    const emptyMsg = shadowRoot.getElementById('jmSavedEmpty');
    if (!list) return;

    try {
      const jobs = await sendMessage({ type: 'GET_SAVED_JOBS' });
      // Clear previous cards (keep the empty message element)
      list.querySelectorAll('.jm-saved-card').forEach(c => c.remove());

      if (!jobs || jobs.length === 0) {
        if (emptyMsg) emptyMsg.style.display = 'block';
        return;
      }

      if (emptyMsg) emptyMsg.style.display = 'none';

      jobs.forEach(job => {
        const card = document.createElement('div');
        card.className = 'jm-saved-card';
        card.dataset.jobId = job.id;

        // Title link
        const title = document.createElement('a');
        title.className = 'jm-saved-title';
        title.textContent = job.title || 'Unknown Position';
        title.href = job.url || '#';
        title.target = '_blank';
        title.rel = 'noopener';

        // Company
        const company = document.createElement('div');
        company.className = 'jm-saved-company';
        company.textContent = job.company || 'Unknown Company';

        // Meta row (score + date)
        const meta = document.createElement('div');
        meta.className = 'jm-saved-meta';

        if (job.score != null && job.score !== 0) {
          const score = document.createElement('span');
          score.className = 'jm-saved-score';
          score.textContent = job.score + '%';
          if (job.score >= 70) score.style.background = '#059669';
          else if (job.score >= 45) score.style.background = '#d97706';
          else score.style.background = '#dc2626';
          meta.appendChild(score);
        }

        if (job.date) {
          const date = document.createElement('span');
          date.textContent = 'Saved ' + job.date;
          meta.appendChild(date);
        }

        // Delete button
        const del = document.createElement('button');
        del.className = 'jm-saved-delete';
        del.innerHTML = '&#10005;';
        del.title = 'Remove saved job';
        del.addEventListener('click', () => deleteSavedJob(job.id, card));

        card.appendChild(title);
        card.appendChild(company);
        card.appendChild(meta);
        card.appendChild(del);
        list.appendChild(card);
      });
    } catch (e) {
      // Silently fail — user can retry by switching tabs
    }
  }

  /**
   * Deletes a saved job by ID (optimistic UI removal).
   * @async
   * @param {string} jobId - The saved job's ID.
   * @param {HTMLElement} cardEl - The card DOM element to remove.
   */
  async function deleteSavedJob(jobId, cardEl) {
    // Optimistic removal from DOM
    cardEl.remove();

    // Show empty state if no cards remain
    if (shadowRoot) {
      const list = shadowRoot.getElementById('jmSavedList');
      const emptyMsg = shadowRoot.getElementById('jmSavedEmpty');
      if (list && list.querySelectorAll('.jm-saved-card').length === 0 && emptyMsg) {
        emptyMsg.style.display = 'block';
      }
    }

    try {
      await sendMessage({ type: 'DELETE_JOB', jobId: jobId });
    } catch (e) {
      // If delete fails, reload the list to restore correct state
      loadSavedJobs();
    }
  }

  /**
   * Checks if the current page URL is already saved and updates
   * the Save Job button to show "Saved" state if so.
   * @async
   */
  async function checkIfSaved() {
    try {
      const jobs = await sendMessage({ type: 'GET_SAVED_JOBS' });
      const btn = shadowRoot.getElementById('jmSaveJob');
      if (!btn) return;
      const here = normalizeUrl(window.location.href);
      if (jobs && jobs.some(j => normalizeUrl(j.url) === here)) {
        btn.textContent = 'Saved';
        btn.disabled = true;
        btn.style.opacity = '0.7';
      } else {
        btn.textContent = 'Save Job';
        btn.disabled = false;
        btn.style.opacity = '1';
      }
    } catch (e) { /* ignore */ }
  }

  // ─── Toggle button (always visible) ────────────────────────────
  // The ★ button is a separate Shadow DOM host from the panel so it can float
  // freely without interfering with the panel's stacking context.
  // It supports both mouse drag and touch drag, and persists its last position
  // across page navigations using localStorage.

  /**
   * Creates the draggable floating ★ toggle button and appends it to the page.
   *
   * Position is restored from localStorage on creation. Drag state is tracked
   * with mousedown/mousemove/mouseup (and touch equivalents). A click only fires
   * togglePanel() if the button was not meaningfully dragged (delta < 4px).
   */
  function createToggleButton() {
    const btn = document.createElement('button');
    btn.className = 'jm-toggle';
    btn.id = 'jobmatch-ai-toggle';
    btn.innerHTML = '&#9733;';
    btn.title = 'JobMatch AI';
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', 'Open JobMatch AI panel');
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('tabindex', '0');
    toggleBtnRef = btn;

    // Restore saved position or default to bottom-right
    const saved = (() => {
      try { return JSON.parse(localStorage.getItem('jm-fab-pos')); } catch { return null; }
    })();
    const defaultRight = 24;
    const defaultBottom = 24;
    if (saved && typeof saved.right === 'number' && typeof saved.bottom === 'number') {
      btn.style.right  = saved.right + 'px';
      btn.style.bottom = saved.bottom + 'px';
      btn.style.left   = 'auto';
      btn.style.top    = 'auto';
    } else {
      btn.style.right  = defaultRight + 'px';
      btn.style.bottom = defaultBottom + 'px';
      btn.style.left   = 'auto';
      btn.style.top    = 'auto';
    }

    // Auto-position based on what's at the corner was the wrong abstraction
    // — the button's position is user-controlled (drag), and the real
    // problem was reCAPTCHA painting over us, not which spot we sit in.
    // Stacking is now handled by attaching the host to <html> rather than
    // <body> (see the documentElement.appendChild call below).

    // ── Drag logic ──
    let didDrag = false, startX, startY, startRight, startBottom;
    const MIN_MARGIN = 8;
    const DRAG_THRESHOLD = 4;

    function onMove(e) {
      const cx = e.touches ? e.touches[0].clientX : e.clientX;
      const cy = e.touches ? e.touches[0].clientY : e.clientY;
      const dx = cx - startX;
      const dy = cy - startY;

      // Only start dragging after movement exceeds threshold
      if (!didDrag && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      didDrag = true;
      btn.classList.add('dragging');

      // Calculate new right/bottom with bounds checking (8px min margin)
      let newRight  = startRight - dx;
      let newBottom = startBottom - dy;
      newRight  = Math.max(MIN_MARGIN, Math.min(newRight,  window.innerWidth  - 48 - MIN_MARGIN));
      newBottom = Math.max(MIN_MARGIN, Math.min(newBottom, window.innerHeight - 48 - MIN_MARGIN));

      btn.style.right  = newRight + 'px';
      btn.style.bottom = newBottom + 'px';
      btn.style.left   = 'auto';
      btn.style.top    = 'auto';
    }

    function onEnd(e) {
      btn.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend',  onEnd);

      if (didDrag) {
        // Save position as {right, bottom}
        const pos = {
          right:  parseInt(btn.style.right,  10),
          bottom: parseInt(btn.style.bottom, 10)
        };
        try { localStorage.setItem('jm-fab-pos', JSON.stringify(pos)); } catch {}
      }
    }

    btn.addEventListener('mousedown', e => {
      startX = e.clientX; startY = e.clientY;
      startRight  = parseInt(btn.style.right,  10) || defaultRight;
      startBottom = parseInt(btn.style.bottom, 10) || defaultBottom;
      didDrag = false;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onEnd);
      e.preventDefault();
    });

    btn.addEventListener('touchstart', e => {
      startX = e.touches[0].clientX; startY = e.touches[0].clientY;
      startRight  = parseInt(btn.style.right,  10) || defaultRight;
      startBottom = parseInt(btn.style.bottom, 10) || defaultBottom;
      didDrag = false;
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend',  onEnd);
      e.preventDefault();
    }, { passive: false });

    // Only fire click if not dragged (threshold already checked during move)
    btn.addEventListener('click', e => {
      if (!didDrag) togglePanel();
    });

    // Keyboard accessibility: Enter and Space trigger toggle
    btn.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        togglePanel();
      }
    });

    // Attach to shadow root for isolation
    const host = document.createElement('div');
    host.id = 'jobmatch-ai-toggle-host';
    toggleHostRef = host; // module-level reference so self-healing can re-attach a detached host
    // Defend against page CSS that might target the host (e.g. Greenhouse
    // / Workday React templates with broad 'body > div' rules). Force-set
    // every visibility-affecting property inline with !important so page
    // styles can't override them. Host itself is a 0×0 fixed anchor in
    // the corner — the actual button inside the shadow uses its own
    // position:fixed bottom/right.
    [
      ['display', 'block'], ['visibility', 'visible'], ['opacity', '1'],
      ['position', 'fixed'], ['top', '0'], ['left', '0'],
      ['width', '0'], ['height', '0'],
      ['z-index', '2147483647'],
      ['pointer-events', 'none'], // button inside re-enables pointer-events
      ['transform', 'none'], ['filter', 'none'], ['clip', 'auto'],
      ['margin', '0'], ['padding', '0'], ['border', '0'],
    ].forEach(([k, v]) => host.style.setProperty(k, v, 'important'));
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = getPanelCSS();
    shadow.appendChild(style);
    shadow.appendChild(btn);
    document.body.appendChild(host);
  }

  // ─── Resume switcher ─────────────────────────────────────

  /**
   * Loads resume state from chrome.storage.local and renders the switcher pills.
   * Called when the panel opens so the switcher always reflects current storage.
   * @async
   */
  async function loadResumeState() {
    try {
      const result = await chrome.storage.local.get(['resumes', 'activeResumeId']);
      _resumes = result.resumes || [];
      _activeResumeId = result.activeResumeId || (_resumes[0] && _resumes[0].id) || null;
      renderSlotSwitcher();
    } catch (e) { /* ignore — switcher stays hidden */ }
  }

  /**
   * Renders one pill per saved resume into #jmSwitchPills, marking the
   * active resume with .active. Each pill's tooltip includes that resume's
   * local (no-AI) ATS-keyword-match percentage, if one has been computed
   * for the current JD (see _resumeScores) — scanResumeMatch() already
   * auto-switches to the strongest match by default, so the active pill
   * here is normally that one.
   *
   * Also refreshes the "Local Match" badge for whichever resume is active
   * (updateLocalScoreChip) — every code path that changes which resume is
   * active or which scores are available routes through here, so that badge
   * never goes stale.
   */
  function renderSlotSwitcher() {
    const container = shadowRoot && shadowRoot.getElementById('jmSwitchPills');
    if (!container) return;
    container.innerHTML = '';
    _resumes.forEach(r => {
      const isActive = r.id === _activeResumeId;
      const score = _resumeScores[r.id];
      const pctSuffix = typeof score === 'number' ? ` — ${Math.round(score * 100)}% ATS keyword match` : '';
      const btn = document.createElement('button');
      btn.className = 'jm-switch-pill' + (isActive ? ' active' : '');
      btn.textContent = r.name || 'Resume';
      btn.title = (r.name || 'Resume') + pctSuffix;
      btn.addEventListener('click', () => {
        _manualResumeSelection = true;
        switchSlot(r.id);
      });
      container.appendChild(btn);
    });
    updateLocalScoreChip();
  }

  /**
   * Updates the "Local Match" badge next to the resume switcher with the
   * ACTIVE resume's local ATS-keyword-match score against the current JD, read
   * from _resumeScores (populated by scanResumeMatch — a single pure-JS
   * pass over every saved resume, no AI call, no network request, so this
   * stays free and instant no matter how many resumes are saved). Hides the
   * badge when no score is available yet (no JD scanned, or nothing scored
   * for the active resume).
   */
  function updateLocalScoreChip() {
    const chip = shadowRoot && shadowRoot.getElementById('jmLocalScore');
    const downloadBtn = shadowRoot && shadowRoot.getElementById('jmDownloadResume');
    if (!chip) return;
    const score = _resumeScores[_activeResumeId];
    if (typeof score !== 'number') {
      chip.style.display = 'none';
      if (downloadBtn) downloadBtn.style.display = 'none';
      return;
    }
    const pct = Math.round(score * 100);
    const tier = getScoreClass(pct).replace('score-', ''); // 'green' | 'amber' | 'red'
    chip.textContent = `${pct}% ATS keyword match`;
    chip.className = 'jm-local-score jm-local-score-' + tier;
    chip.style.display = 'inline-block';
    // Shown together with the chip — both depend on a resume having been
    // scored/selected for the current JD (see attachResumeFile() /
    // downloadActiveResumeFile() for what this button actually downloads).
    if (downloadBtn) downloadBtn.style.display = 'inline-block';
  }

  /**
   * Switches the active resume, updates chrome.storage.local, and resets
   * the current analysis so the user re-analyzes with the new resume.
   * @async
   * @param {string} id - The id (in `resumes`) of the resume to switch to.
   * @param {Object} [opts]
   * @param {boolean} [opts.silent=false] - Skip the "Switched to ... Click
   *   Analyze Job." status message and its auto-clear timer. Used when
   *   analyzeJob() auto-selects the best-matching resume for the user —
   *   the caller shows its own status message for the rest of the analyze
   *   flow, and without this the switch's own 2.5s status-clear timer can
   *   race in and blank that message while the AI call is still in flight.
   */
  async function switchSlot(id, opts) {
    const silent = !!(opts && opts.silent);
    if (id === _activeResumeId) return;
    try {
      const result = await chrome.storage.local.get('resumes');
      const resumes = result.resumes || [];
      const target = resumes.find(r => r.id === id);
      if (!target) return;

      // Persist the new active resume and mirror its profile/raw-file into
      // the flat keys background.js reads for AI calls and tailored resumes.
      await chrome.storage.local.set({
        activeResumeId: id,
        profile: target.profile,
        rawResumeBase64: target.rawResumeBase64 || null,
        resumeFileType: target.resumeFileType || null,
      });

      _resumes = resumes;
      _activeResumeId = id;
      renderSlotSwitcher();

      // Reset analysis — it was scored against the previous resume
      currentAnalysis = null;
      const analyzeBtn = shadowRoot.getElementById('jmAnalyze');
      if (analyzeBtn) analyzeBtn.textContent = 'Analyze Job';

      // Hide all result sections so the panel is clean for the new resume.
      // jmSaveJob is deliberately NOT in this list: bookmarking a job no
      // longer depends on having an analysis (or on which resume is
      // active), so switching resumes shouldn't hide — or otherwise
      // disturb — the Save Job button.
      ['jmScoreSection','jmMatchingSection','jmMissingSection','jmRecsSection',
       'jmInsightsSection','jmKeywordsSection','jmCoverLetterSection','jmBulletSection',
       'jmMarkApplied','jmCoverLetterBtn','jmRewriteBulletsBtn'
      ].forEach(sectionId => {
        const el = shadowRoot.getElementById(sectionId);
        if (el) el.style.display = 'none';
      });

      if (!silent) {
        setStatus(`Switched to ${target.name || 'Resume'}. Click Analyze Job.`, 'success');
        setTimeout(clearStatus, 2500);
      }
    } catch (e) {
      setStatus('Could not switch resume: ' + e.message, 'error');
    }
  }

  // ─── Panel toggle ─────────────────────────────────────────────

  /**
   * Opens or closes the side panel.
   * On first open, createPanel() is called to build the Shadow DOM.
   * When opening, also triggers checkIfApplied() and loadJobNotes()
   * so the panel always reflects the latest state for the current URL.
   */
  // Reference to the backdrop element inside the panel's shadow DOM
  let _backdropEl = null;
  // Reference to the escape key handler so we can add/remove it
  let _escHandler = null;

  function togglePanel() {
    panelOpen = !panelOpen;
    if (!panelRoot) createPanel();

    // If the page (e.g. a heavy React app like Greenhouse) has removed
    // our hosts from the DOM, re-attach them when the user explicitly
    // triggers the panel. Event-driven so it can never loop with the
    // page's reconciler — only fires on user action.
    if (panelRoot && !panelRoot.isConnected) {
      try { document.body.appendChild(panelRoot); } catch (_) {}
    }
    if (toggleHostRef && !toggleHostRef.isConnected) {
      try { document.body.appendChild(toggleHostRef); } catch (_) {}
    }

    const panel = shadowRoot.getElementById('jm-panel');

    // Update accessibility attributes on the toggle button
    if (toggleBtnRef) {
      toggleBtnRef.setAttribute('aria-label', panelOpen ? 'Close JobMatch AI panel' : 'Open JobMatch AI panel');
      toggleBtnRef.setAttribute('aria-pressed', String(panelOpen));
    }

    if (panelOpen) {
      // Create backdrop inside the shadow DOM
      if (!_backdropEl) {
        _backdropEl = document.createElement('div');
        _backdropEl.className = 'jm-backdrop';
        _backdropEl.addEventListener('click', () => togglePanel());
        shadowRoot.insertBefore(_backdropEl, shadowRoot.firstChild.nextSibling);
      } else {
        _backdropEl.style.display = 'block';
      }

      panelRoot.classList.add('open');
      panel.classList.add('open');

      // Add Escape key handler
      _escHandler = (e) => {
        if (e.key === 'Escape' && panelOpen) togglePanel();
      };
      document.addEventListener('keydown', _escHandler);

      loadResumeState();
      checkIfApplied();
      checkIfSaved();
      loadJobNotes();
      previewJobMeta();
      scanResumeMatch();
      // Ensure we start on the main tab when opening the panel
      deactivateSavedTab();
    } else {
      panel.classList.remove('open');
      panelRoot.classList.remove('open');

      // Hide backdrop
      if (_backdropEl) _backdropEl.style.display = 'none';

      // Remove Escape key handler
      if (_escHandler) {
        document.removeEventListener('keydown', _escHandler);
        _escHandler = null;
      }
    }
    // Button always stays visible — never hide the toggle host
  }

  // ─── Status helpers ───────────────────────────────────────────

  /**
   * Displays a status message inside the panel (info / success / error styles).
   * @param {string} text - Message to display.
   * @param {'info'|'success'|'error'} type - CSS modifier class for color.
   */
  function setStatus(text, type) {
    const el = shadowRoot.getElementById('jmStatus');
    el.textContent = text;
    el.className = 'jm-status ' + type;
  }

  /** Hides the status bar (used after a timed delay post-success). */
  function clearStatus() {
    const el = shadowRoot.getElementById('jmStatus');
    el.className = 'jm-status';
    el.style.display = 'none';
  }


  /**
   * Scores every saved resume against the current JD purely by ATS-keyword
   * overlap — skills, certifications, and project technologies, the same
   * set shown on the Profile tab's "ATS Keywords" list (no AI call, no
   * network — see lib/resumeRanker.js / lib/resumeKeywords.js), populating
   * _resumeScores for the "Local Match" badge — and, if a non-active resume
   * comes out ahead with a non-zero score, auto-switches to it so the
   * strongest match is already active by default, before the user even
   * clicks Analyze (the same auto-select analyzeJob() does before an AI
   * call, just running earlier). The scores themselves are computed
   * regardless of resume count (so a single saved resume still gets a
   * badge); auto-switching only applies with two or more resumes to
   * compare. This is a lightweight heuristic to help pick which resume to
   * analyze with — not a substitute for the AI-generated match score.
   * @param {string} [jd] - Pre-extracted JD text. Extracted internally if omitted.
   * @async
   */
  async function scanResumeMatch(jd) {
    _resumeScores = {};

    if (jd === undefined) {
      jd = '';
      try { jd = (await getJobDescriptionForAnalysis()) || ''; } catch (_) { /* extraction can throw on weird pages */ }
    }
    if (!jd) { renderSlotSwitcher(); return; }

    try {
      const result = await chrome.storage.local.get('resumes');
      const resumes = result.resumes || [];
      if (!resumes.length) { renderSlotSwitcher(); return; }

      // Score every saved resume against this JD in one local pass — zero
      // AI calls and zero network requests no matter how many resumes are
      // saved. Powers both the active resume's "Local Match" badge below
      // and the default auto-selection just below.
      const ranked = rankResumes(jd, resumes);
      ranked.forEach(r => { _resumeScores[r.id] = r.score; });

      if (resumes.length < 2) { renderSlotSwitcher(); return; }
      // Respect a resume the user explicitly picked for this job — don't
      // second-guess it just because a different resume scores higher.
      if (_manualResumeSelection) { renderSlotSwitcher(); return; }

      const top = ranked[0];
      if (!top || top.score <= 0 || top.id === _activeResumeId) { renderSlotSwitcher(); return; }

      // Default to the strongest ATS-keyword match — switchSlot persists it
      // as activeResumeId, so this sticks until a stronger match shows up
      // (a new JD) or the user manually picks a different pill.
      const topPct = Math.round(top.score * 100);
      const topName = top.name || 'Resume';
      await switchSlot(top.id, { silent: true });
      setStatus(`Auto-selected "${topName}" — ${topPct}% ATS keyword match for this posting.`, 'info');
      setTimeout(clearStatus, 3000);
    } catch (e) { /* stay hidden */ }
  }

  /**
   * Scrolls the panel's scrollable body to bring a section into view.
   * Uses the panel's own scrollable container rather than window.scrollIntoView,
   * which would scroll the host page instead of the Shadow DOM panel.
   * @param {HTMLElement} el - The element to scroll to inside the panel.
   */
  function scrollPanelTo(el) {
    const body = shadowRoot.querySelector('.jm-body');
    if (!body) return;
    body.scrollTo({ top: el.offsetTop - 10, behavior: 'smooth' });
  }

  // ─── Job description extraction ───────────────────────────────
  // Each function tries a prioritised list of CSS selectors for supported job
  // sites, then falls back to heuristic DOM scanning.  Returns an empty string
  // (or null) when nothing can be found, so callers can show an error.

  /**
   * Extracts the full job description text from the current page using only
   * signals that actually indicate job-description content: a site-specific
   * selector match, or the largest named content block (main/article/etc.)
   * over 200 characters. Deliberately has NO last-resort "just grab the
   * page body" fallback — see extractJobDescription() for that — because
   * this is also used to decide whether the current page has real JD
   * content at all (see getJobDescriptionForAnalysis()). A page with no JD
   * (e.g. an application-form-only step of a multi-step apply flow) should
   * report that honestly as '' rather than have callers unknowingly treat
   * the form's own text as the job description.
   * @returns {string} The extracted job description text, or '' if nothing
   *   that actually looks like a job description was found.
   */
  function extractJobDescriptionConfident() {
    // ATS-specific selectors
    const selectors = [
      // Greenhouse
      '#content .job-post-content',
      '#content #gh_jid',
      '.job__description',
      // Lever
      '.posting-page .content',
      '.section-wrapper.page-full-width',
      // Workday
      '[data-automation-id="jobPostingDescription"]',
      '.job-description',
      // LinkedIn
      '.jobs-description__content',
      '.description__text',
      '.jobs-box__html-content',
      // Indeed
      '#jobDescriptionText',
      '.jobsearch-jobDescriptionText',
      // Generic
      '[class*="job-description"]',
      '[class*="jobDescription"]',
      '[id*="job-description"]',
      '[id*="jobDescription"]',
      '[class*="posting-description"]',
      'article[class*="job"]',
      '.job-details',
      '.job-content',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 100) {
        return el.innerText.trim();
      }
    }

    // Fallback: try to find the largest text block on page
    const blocks = document.querySelectorAll('main, article, [role="main"], .content, #content');
    let bestBlock = null;
    let bestLen = 0;
    for (const block of blocks) {
      const text = block.innerText.trim();
      if (text.length > bestLen) {
        bestLen = text.length;
        bestBlock = text;
      }
    }

    if (bestBlock && bestLen > 200) return bestBlock;
    return '';
  }

  /**
   * Extracts the full job description text from the current page. Tries
   * extractJobDescriptionConfident() first; if that finds nothing, falls
   * back to the page body text so this function's contract (never returns
   * '' on a non-empty page) is unchanged from before — existing callers
   * that don't need the tab-cache fallback (or that predate it) keep
   * working exactly as they did.
   *
   * New/updated callers that want the smarter behavior — fall back to the
   * JD this same TAB saw on an earlier step of the same posting, instead
   * of scraping whatever's on the current (JD-less) page — should use
   * getJobDescriptionForAnalysis() instead.
   * @returns {string} The extracted job description text, or '' if not found.
   */
  function extractJobDescription() {
    const confident = extractJobDescriptionConfident();
    if (confident) return confident;
    // Last resort: body text
    return document.body.innerText.substring(0, 10000);
  }

  /**
   * The JD-extraction entry point for anything that sends the result to the
   * AI or uses it for resume ranking (Analyze, AutoFill's resume
   * auto-select, Cover Letter, bullet rewriting). Handles multi-step apply
   * flows where the application-form step has no visible JD (e.g. Ashby's
   * .../<id> posting page vs .../<id>/application form page, reached via a
   * client-side route change — see handleSpaUrlChanged) by falling back to
   * whatever JD text THIS BROWSER TAB last confidently extracted, cached in
   * the background service worker (chrome.storage.session, cleared when the
   * tab closes — see the CACHE_TAB_JD/GET_CACHED_TAB_JD handlers in
   * background.js).
   *
   * On a page WITH real JD content, this caches it (fire-and-forget) for
   * later steps of the same posting to fall back to, and returns it
   * directly — no behavior change from extractJobDescription() there. Only
   * on a page with NO confident JD match does this reach for the tab's
   * cached JD instead of falling back to page-body text.
   * @async
   * @returns {Promise<string>} JD text — confidently extracted, or this
   *   tab's cached JD, or (only if neither exists) the same page-body
   *   fallback extractJobDescription() has always used.
   */
  async function getJobDescriptionForAnalysis() {
    const confident = extractJobDescriptionConfident();
    if (confident) {
      // Fire-and-forget — don't make the caller wait on the cache write,
      // and don't let a rejected promise (e.g. extension context torn down
      // mid-navigation) surface as an unhandled rejection.
      sendMessage({ type: 'CACHE_TAB_JD', jd: confident, url: window.location.href }).catch(() => {});
      return confident;
    }
    try {
      const cached = await sendMessage({ type: 'GET_CACHED_TAB_JD' });
      if (cached && cached.jd) return cached.jd;
    } catch (_) { /* best-effort — fall through to the page-body fallback below */ }
    // Nothing confidently extracted here, and nothing cached for this tab
    // (e.g. the very first page the user opened in this tab has no JD) —
    // fall back to the same last-resort scrape extractJobDescription() has
    // always used, so single-page postings are completely unaffected.
    return extractJobDescription();
  }

  /** @returns {string} The job title extracted from the page, or ''. */
  function extractJobTitle() {
    const selectors = [
      'h1.job-title', 'h1.posting-headline', '.job-title h1',
      'h1[class*="title"]', '.jobs-unified-top-card__job-title',
      'h1', '.posting-headline h2',
      'h2.job-title', '[data-automation-id="jobTitle"]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 2 && el.innerText.trim().length < 200) {
        return el.innerText.trim();
      }
    }
    return document.title.split('|')[0].split('-')[0].trim();
  }

  /**
   * Extracts company name using multiple strategies in priority order.
   * @returns {string} The company name, or ''.
   */
  function extractCompany() {
    const locationWords = /multiple locations|remote|hybrid|on-?site|united states|worldwide/i;
    const stateAbbr = /^[A-Z]{2},?\s/;

    function isValidCompany(text) {
      if (!text || text.length < 2 || text.length > 100) return false;
      if (locationWords.test(text) || stateAbbr.test(text)) return false;
      return true;
    }

    // ── Strategy 1: Site-specific CSS selectors ──
    const selectors = [
      // LinkedIn
      '.jobs-unified-top-card__company-name',
      '.job-details-jobs-unified-top-card__company-name a',
      // Indeed
      '[data-testid="inlineHeader-companyName"]',
      '.jobsearch-InlineCompanyRating-companyHeader a',
      // Glassdoor
      '[data-test="employer-name"]',
      // Greenhouse
      '.company-name',
      // Lever
      '.posting-categories .sort-by-team.posting-category:first-child',
      // Workday
      '[data-automation-id="company"]',
      // Phenom (Dell, etc.)
      '.job-company', '[data-ph-at-id="company-name"]',
      // Schema.org structured data
      '[itemprop="hiringOrganization"] [itemprop="name"]',
      // Generic
      '.company-name', '.employer-name',
    ];
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el && isValidCompany(el.innerText.trim())) {
          return el.innerText.trim();
        }
      } catch (_) {}
    }

    // ── Strategy 2: JSON-LD structured data (schema.org) ──
    try {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of scripts) {
        const data = JSON.parse(script.textContent);
        const org = data?.hiringOrganization?.name
          || data?.employerOverview?.name
          || (Array.isArray(data) && data.find(d => d['@type'] === 'JobPosting')?.hiringOrganization?.name);
        if (org && isValidCompany(org)) return org;
      }
    } catch (_) {}

    // ── Strategy 3: <meta> tags ──
    try {
      const ogSiteName = document.querySelector('meta[property="og:site_name"]')?.content;
      if (ogSiteName && isValidCompany(ogSiteName) && !ogSiteName.toLowerCase().includes('greenhouse')
          && !ogSiteName.toLowerCase().includes('lever') && !ogSiteName.toLowerCase().includes('workday')) {
        return ogSiteName;
      }
    } catch (_) {}

    // ── Strategy 4: Page title pattern matching ──
    // Many job pages: "Job Title - Company Name" or "Job Title | Company Name" or "Job Title at Company"
    try {
      const title = document.title;
      // "at Company" pattern
      const atMatch = title.match(/\bat\s+([A-Z][A-Za-z0-9\s&.,']+?)(?:\s*[-|]|\s*$)/);
      if (atMatch && isValidCompany(atMatch[1].trim())) return atMatch[1].trim();
      // "Title - Company" or "Title | Company" (take the LAST segment)
      const parts = title.split(/\s*[-|]\s*/);
      if (parts.length >= 2) {
        // Try last part first, then second part
        for (let i = parts.length - 1; i >= 1; i--) {
          const candidate = parts[i].trim();
          // Skip common non-company suffixes
          if (/careers|jobs|apply|hiring|job board|greenhouse|lever|workday/i.test(candidate)) continue;
          if (isValidCompany(candidate) && candidate.length > 2 && candidate.length < 50) {
            return candidate;
          }
        }
      }
    } catch (_) {}

    // ── Strategy 5: Hostname extraction ──
    try {
      const host = window.location.hostname;
      const parts = host.split('.');
      const skip = new Set([
        // generic
        'jobs', 'careers', 'apply', 'hire', 'www', 'com', 'org', 'net', 'io', 'co', 'uk', 'boards', 'app',
        // ATS/job-board hostnames — never the actual employer
        'greenhouse', 'lever', 'workday', 'myworkday', 'smartrecruiters',
        'ashbyhq', 'ashby', 'workable', 'breezy', 'icims', 'taleo',
        'jobvite', 'bamboohr', 'recruitee', 'teamtailor', 'pinpointhq',
        'rippling', 'gusto', 'comeet', 'jazzhr',
        // common job aggregators
        'linkedin', 'indeed', 'glassdoor', 'ziprecruiter', 'monster',
        'simplyhired', 'angel', 'wellfound', 'dice', 'builtin',
      ]);
      for (const part of parts) {
        if (!skip.has(part) && part.length > 2) {
          // Capitalize first letter
          return part.charAt(0).toUpperCase() + part.slice(1);
        }
      }
    } catch (_) {}

    return '';
  }

  /** @returns {string} The job location extracted from the page, or ''. */
  function extractLocation() {
    const selectors = [
      // LinkedIn
      '.jobs-unified-top-card__bullet',
      '.job-details-jobs-unified-top-card__primary-description-container .tvm__text',
      // Indeed
      '[data-testid="job-location"], .jobsearch-JobInfoHeader-subtitle > div:last-child',
      // Glassdoor
      '[data-test="emp-location"]',
      // Greenhouse
      '.location', '.job-post-location',
      // Lever
      '.posting-categories .sort-by-team.posting-category:nth-child(2)',
      '.posting-categories .location',
      // Workday
      '[data-automation-id="locations"]',
      // Generic
      '[class*="location"]', '[class*="job-location"]',
      '[data-field="location"]', '[itemprop="jobLocation"]'
    ];
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          const text = el.innerText.trim();
          if (text.length > 1 && text.length < 150) return text;
        }
      } catch (e) { /* skip invalid selectors */ }
    }

    // justjoin.it renders location via Material-UI with no class name that
    // contains the word "location" (classes like "MuiTypography-subtitle3"
    // are generic, and "mui-1a6mstl"-style hashes are regenerated per build,
    // so neither is a stable selector target). Fall back to matching the
    // site's distinctive "<city> +N Locations" text pattern instead, scoped
    // to this hostname only so it can't misfire elsewhere.
    try {
      if (/(^|\.)justjoin\.it$/i.test(location.hostname)) {
        const m = document.body.innerText.match(/[\p{L}][\p{L}\s]{0,40}\+\d+\s*Locations?\b/u);
        if (m) return m[0].trim();
      }
    } catch (_) { /* unsupported regex flags on very old engines */ }

    return '';
  }

  /**
   * @returns {string} Human-language requirements extracted from the page
   *   (e.g. "English (C1), Polish (B2)"), or ''.
   *
   * Currently justjoin.it-specific: its "Skills & Languages" widget lists
   * both tech skills (Python, React, ...) and spoken languages side by side
   * as MUI Typography rows, distinguished only by content — a skill's level
   * is a word ("advanced", "regular"), while a language's level is a CEFR
   * code (A1-C2). We match on that CEFR pattern rather than on MUI's
   * per-build hashed classes, since the hashes aren't stable across deploys.
   */
  function extractLanguages() {
    try {
      if (!/(^|\.)justjoin\.it$/i.test(location.hostname)) return '';
      const cefr = /^(A1|A2|B1|B2|C1|C2)$/i;
      const headers = document.querySelectorAll('h4[class*="MuiTypography-subtitle"]');
      const langs = [];
      for (const h of headers) {
        const name = h.textContent.trim();
        if (!name) continue;
        const box = h.closest('div');
        if (!box) continue;
        const levelEl = box.querySelector('span[class*="MuiTypography-subtitle"]');
        if (!levelEl) continue;
        const level = levelEl.textContent.trim();
        if (cefr.test(level)) langs.push(`${name} (${level.toUpperCase()})`);
      }
      return langs.join(', ');
    } catch (_) { return ''; }
  }

  /** @returns {string} The salary/compensation text extracted from the page, or ''. */
  function extractSalary() {
    // Site-specific selectors
    const selectors = [
      // LinkedIn
      '.salary-main-rail__data-body',
      '.jobs-unified-top-card__job-insight--highlight span',
      // Indeed
      '#salaryInfoAndJobType', '.jobsearch-JobMetadataHeader-item',
      '[data-testid="attribute_snippet_testid"]',
      // Glassdoor
      '[data-test="detailSalary"]',
      // Greenhouse / Lever / Workday
      '[data-automation-id="salary"]',
      // Phenom (Dell, etc)
      '.job-salary', '.salary-range', '.compensation-range',
      // Generic
      '[class*="salary"]', '[class*="compensation"]', '[class*="pay-range"]',
      '[class*="pay_range"]', '[data-field="salary"]'
    ];
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          const text = el.innerText.trim();
          if (text.length > 1 && text.length < 200 && /\d/.test(text)) return text;
        }
      } catch (e) { /* skip */ }
    }
    // Regex fallback: search JD text for salary patterns
    const jdText = (document.querySelector('.jobs-description__content') ||
                    document.querySelector('#jobDescriptionText') ||
                    document.querySelector('[class*="job-description"]') ||
                    document.body).innerText || '';
    const patterns = [
      /\$[\d,]+(?:\.\d{2})?\s*[-–to]+\s*\$[\d,]+(?:\.\d{2})?(?:\s*\/?\s*(?:year|yr|annually|hour|hr|month|mo))?/i,
      /\$[\d,]+(?:\.\d{2})?\s*(?:\/?\s*(?:year|yr|annually|hour|hr|month|mo))/i,
      /\d{2,3}k\s*[-–to]+\s*\d{2,3}k(?:\s*(?:\/?\s*(?:year|yr|annually))?)/i,
      /(?:salary|compensation|pay)[:\s]*\$[\d,]+(?:\s*[-–to]+\s*\$[\d,]+)?/i
    ];
    for (const pat of patterns) {
      const match = jdText.match(pat);
      if (match) return match[0].trim();
    }
    return '';
  }

  /** @returns {string} The job ID/reference number extracted from the page, or ''. */
  function extractJobId() {
    // Site-specific selectors
    const selectors = [
      // Workday
      '[data-automation-id="jobID"]',
      // Generic
      '[class*="job-id"]', '[class*="jobId"]', '[class*="requisition"]',
      '[class*="ref-number"]', '[data-field="job-id"]',
    ];
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          const text = el.innerText.trim();
          if (text.length > 1 && text.length < 50) return text;
        }
      } catch (_) {}
    }
    // Regex fallback: search page text for job ID patterns
    const bodyText = document.body.innerText || '';
    const patterns = [
      /(?:job\s*(?:id|#|number|ref|reference|code)[:\s]*)([\w-]{3,20})/i,
      /(?:requisition\s*(?:id|#|number)?[:\s]*)([\w-]{3,20})/i,
      /(?:posting\s*(?:id|#)?[:\s]*)([\w-]{3,20})/i,
    ];
    for (const pat of patterns) {
      const match = bodyText.match(pat);
      if (match && match[1]) return match[1].trim();
    }
    // Try URL path for numeric job IDs
    const urlMatch = window.location.pathname.match(/\/(\d{5,12})(?:\/|$)/);
    if (urlMatch) return urlMatch[1];
    return '';
  }

  // ─── Analyze job ──────────────────────────────────────────────

  /**
   * Runs a job analysis for the current page: extracts the JD, sends it to the
   * AI via background.js, caches the result, and renders it in the panel.
   *
   * If a cached result exists for the current URL and forceRefresh is false,
   * the cached result is displayed immediately with no API call.
   *
   * @async
   * @param {boolean} [forceRefresh=false] - When true, bypasses the cache and
   *   always makes a fresh AI call (triggered by the "Re-Analyze" button).
   */
  async function analyzeJob(forceRefresh) {
    const btn = shadowRoot.getElementById('jmAnalyze');
    // pageUrl is the normalized cache/dedupe key — it strips tracking params
    // (utm_*, gh_src, token, etc.) down to just the allowlisted job-id param
    // so the same posting reached via different links/sources hits one cache
    // entry. It is NOT what gets saved as the job's link: rawPageUrl (the
    // untouched window.location.href) is what's stored on currentAnalysis.url
    // and flows into Save Job / Mark Applied, so the link the user can click
    // back to still has every param the page needs to actually load
    // (e.g. Greenhouse embeds require `token`/`for`, not just `gh_jid`).
    const pageUrl = normalizeUrl(window.location.href);
    const rawPageUrl = window.location.href;
    // Capture a generation token. If the user SPA-navigates while we're
    // awaiting the AI response, the SPA observer bumps _analyzeGen and we
    // detect the mismatch below — preventing a stale analysis from rendering
    // on the new job's panel.
    const myGen = ++_analyzeGen;
    const isStale = () => _analyzeGen !== myGen;

    // Auto-select the best-matching resume for this JD before doing anything
    // else, so both the cache lookup and the AI call use the right resume —
    // this replaces the old flow where the user had to manually pick a
    // resume from the switcher pills before analyzing.
    //
    // Ranking uses the same local, zero-AI-call ATS-keyword-overlap ranker
    // that already powers the "★ ... Switch?" hint (lib/resumeRanker.js,
    // scoring against lib/resumeKeywords.js's skills + certifications +
    // project-technologies set), so this stays instant and free of API cost
    // no matter how many resumes are saved — only the single winning resume
    // is ever sent to the AI below.
    let autoSelectedName = null;
    let autoSelectedPct = null;
    // Skip auto-selection entirely once the user has manually picked a
    // resume for this job — otherwise clicking Analyze right after
    // switching resumes could silently switch back to a different resume
    // before the cache lookup / AI call below even runs, making the
    // analysis (or a stale cache hit) come back for the WRONG resume even
    // though the user just explicitly chose one.
    if (!_manualResumeSelection) {
      try {
        const jdForRanking = (await getJobDescriptionForAnalysis()) || '';
        if (jdForRanking) {
          const { resumes = [], activeResumeId } = await chrome.storage.local.get(['resumes', 'activeResumeId']);
          if (resumes.length >= 2) {
            const ranked = rankResumes(jdForRanking, resumes);
            const top = ranked[0];
            const currentId = activeResumeId || _activeResumeId;
            if (top && top.score > 0 && top.id !== currentId) {
              await switchSlot(top.id, { silent: true });
              autoSelectedName = top.name || 'Resume';
              autoSelectedPct = Math.round(top.score * 100);
            }
          }
        }
      } catch (_) { /* best-effort — analysis proceeds with whichever resume is currently active */ }
    }
    if (isStale()) return; // user navigated away while the auto-select ran

    // Name of whichever resume ends up active for this analysis (after the
    // auto-select above) — carried on currentAnalysis so Save Job / Mark
    // Applied (and from there, the Google Sheets "Resume" column) can record
    // which resume was actually used, without the caller having to look it
    // up separately or risk it drifting if the user switches resumes later.
    const activeResumeName = (_resumes.find(r => r.id === _activeResumeId) || {}).name || '';

    // Check cache first (unless force re-analyze). Keyed by URL + active
    // resume so a resume switch (auto or manual) never surfaces a stale
    // score that was actually cached for a different resume.
    const cached = await getCachedAnalysis(pageUrl, _activeResumeId);
    if (isStale()) return; // user navigated while cache lookup was in flight
    if (!forceRefresh && cached) {
      // Override the cached url/resumeName with current values rather than
      // trusting whatever was stored when this entry was cached — a cache
      // entry written before the rawPageUrl fix (or one whose page has since
      // added/changed tracking params) would otherwise resurrect a stale or
      // truncated link into Save Job / Mark Applied.
      currentAnalysis = { ...cached.analysis, url: rawPageUrl, resumeName: activeResumeName };
      showJobMeta(cached.title, cached.company, cached.location, cached.salary, cached.jobId, cached.language);
      renderAnalysis(cached.response);
      // jmSaveJob is already visible (showJobMeta reveals it as soon as the
      // panel opens, before Analyze) — no need to show it again here.
      // checkIfApplied() (run at panel-open / SPA-nav time) has already set
      // this button's text to "Applied" or "Mark as Applied" as appropriate —
      // just reveal it, don't gate on its text.
      shadowRoot.getElementById('jmMarkApplied').style.display = 'flex';
      updateMarkAppliedGating(currentAnalysis.matchScore);
      shadowRoot.getElementById('jmCoverLetterBtn').style.display = 'flex';
      shadowRoot.getElementById('jmRewriteBulletsBtn').style.display = 'flex';
      shadowRoot.getElementById('jmTailoredResumeBtn').style.display = 'flex';
      btn.textContent = 'Re-Analyze';
      setStatus(autoSelectedName
        ? `Showing cached results for "${autoSelectedName}" (${autoSelectedPct}% ATS keyword match).`
        : 'Showing cached results.', 'success');
      setTimeout(clearStatus, 2000);
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="jm-spinner"></span> Analyzing...';
    let analysisSucceeded = false;

    try {
      const jd = await getJobDescriptionForAnalysis();
      const title = extractJobTitle();
      const company = extractCompany();
      const location = extractLocation();
      const salary = extractSalary();
      const jobId = extractJobId();
      const language = extractLanguages();

      if (jd.length < 50) {
        setStatus('Could not find a job description on this page.', 'error');
        return;
      }

      showJobMeta(title, company, location, salary, jobId, language);

      // Warn if the extracted JD is too short to produce reliable results,
      // but don't block — the user can still trigger analysis.
      if (jd.length < 100) {
        setStatus('Could not extract enough job details from this page. Try copying the job description manually.', 'error');
        btn.disabled = false;
        btn.textContent = 'Analyze Job';
        return;
      }

      setStatus(autoSelectedName
        ? `Best match: "${autoSelectedName}" (${autoSelectedPct}% ATS keywords) — analyzing...`
        : 'Analyzing job match...', 'info');

      const response = await sendMessage({
        type: 'ANALYZE_JOB',
        jobDescription: jd,
        jobTitle: title,
        company: company,
        resumeId: _activeResumeId
      });

      // Bail before mutating any UI/storage if the user navigated mid-flight.
      // Without this, the previous job's analysis renders on the new page.
      if (isStale()) return;

      currentAnalysis = { ...response, title, company, location, salary, jobId, language, url: rawPageUrl, resumeName: activeResumeName };
      await setCachedAnalysis(pageUrl, _activeResumeId, { response, analysis: currentAnalysis, title, company, location, salary, jobId, language });
      if (isStale()) return;
      analysisSucceeded = true;
      renderAnalysis(response);
      clearStatus();

      // Show truncation notices if text was trimmed
      shadowRoot.getElementById('jmTruncNotice').style.display = response.jdTruncated ? 'block' : 'none';

      // Show applied, cover letter, bullet rewriter buttons. (jmSaveJob is
      // already visible — showJobMeta() revealed it as soon as the panel
      // opened, before Analyze — so it doesn't need to be shown again here.)
      // checkIfApplied() (run at panel-open / SPA-nav time) has already set
      // jmMarkApplied's text to "Applied" or "Mark as Applied" as
      // appropriate — just reveal it, don't gate on its text.
      shadowRoot.getElementById('jmMarkApplied').style.display = 'flex';
      updateMarkAppliedGating(currentAnalysis.matchScore);
      shadowRoot.getElementById('jmCoverLetterBtn').style.display = 'flex';
      shadowRoot.getElementById('jmRewriteBulletsBtn').style.display = 'flex';
      shadowRoot.getElementById('jmTailoredResumeBtn').style.display = 'flex';
      // Reset any previous AI output sections
      shadowRoot.getElementById('jmCoverLetterSection').style.display = 'none';
      shadowRoot.getElementById('jmBulletSection').style.display = 'none';
      shadowRoot.getElementById('jmTailoredResumeSection').style.display = 'none';
    } catch (err) {
      setStatus('Error: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = analysisSucceeded ? 'Re-Analyze' : 'Analyze Job';
    }
  }

  /**
   * Renders the job title, company, location, language, and salary in the
   * panel header. Elements with no data are hidden to avoid empty UI gaps.
   * @param {string} title    - Job title text.
   * @param {string} company  - Company name.
   * @param {string} location - Job location string.
   * @param {string} salary   - Salary/compensation string.
   * @param {string} [jobId]  - Job ID/reference string.
   * @param {string} [language] - Human-language requirements (e.g. "English (C1)").
   */
  function showJobMeta(title, company, location, salary, jobId, language) {
    const jobInfo = shadowRoot.getElementById('jmJobInfo');
    shadowRoot.getElementById('jmJobTitle').textContent = title;
    shadowRoot.getElementById('jmJobCompany').textContent = company;
    jobInfo.style.display = 'block';
    // Reveal "Save Job" as soon as we have enough to identify a posting —
    // bookmarking doesn't need an AI analysis, so this runs the moment the
    // panel opens (via previewJobMeta()) rather than waiting for Analyze.
    // checkIfSaved() (run alongside) independently sets this button's
    // text/disabled state if the job turns out to already be saved.
    shadowRoot.getElementById('jmSaveJob').style.display = 'flex';
    if (location) {
      shadowRoot.getElementById('jmJobLocationText').textContent = location;
      shadowRoot.getElementById('jmJobLocation').style.display = 'inline-flex';
    }
    if (language) {
      shadowRoot.getElementById('jmJobLanguageText').textContent = language;
      shadowRoot.getElementById('jmJobLanguage').style.display = 'inline-flex';
    }
    if (salary) {
      shadowRoot.getElementById('jmJobSalaryText').textContent = salary;
      shadowRoot.getElementById('jmJobSalary').style.display = 'inline-flex';
    }
    if (jobId) {
      shadowRoot.getElementById('jmJobIdText').textContent = jobId;
      shadowRoot.getElementById('jmJobId').style.display = 'inline-flex';
    }
  }

  /**
   * Best-effort preview of the job title/company/location/salary shown the
   * moment the panel opens (and after an SPA navigation to a new posting) —
   * before the user spends an AI call on Analyze. Reuses the same
   * page-scraping extractors analyzeJob() uses, so this is pure DOM
   * scraping: no AI call, no network request. Silently does nothing when
   * no title or company can be found (e.g. the page isn't a job posting) —
   * analyzeJob() will surface that with its own "no JD found" message.
   */
  function previewJobMeta() {
    try {
      const title = extractJobTitle();
      const company = extractCompany();
      if (!title && !company) return;
      showJobMeta(title, company, extractLocation(), extractSalary(), extractJobId(), extractLanguages());
    } catch (_) { /* extraction can throw on weird pages */ }
  }

  /**
   * Populates all analysis sections in the panel (score, matching skills,
   * missing skills, recommendations, insights, ATS keywords).
   * Each section is shown only if the AI returned data for it.
   * @param {Object} data - The analysis object returned by background.js handleAnalyzeJob.
   */
  function renderAnalysis(data) {
    // Score
    const scoreSection = shadowRoot.getElementById('jmScoreSection');
    const scoreCircle = shadowRoot.getElementById('jmScoreCircle');
    const score = data.matchScore || 0;
    scoreCircle.textContent = score;
    scoreCircle.className = 'jm-score-circle ' + getScoreClass(score);
    scoreSection.style.display = 'block';

    // Matching skills
    const matchingSection = shadowRoot.getElementById('jmMatchingSection');
    const matchingEl = shadowRoot.getElementById('jmMatchingSkills');
    if (data.matchingSkills && data.matchingSkills.length) {
      matchingEl.innerHTML = data.matchingSkills.map(s =>
        `<span class="jm-tag jm-tag-match">${escapeHTML(s)}</span>`
      ).join('');
      matchingSection.style.display = 'block';
    }

    // Missing skills
    const missingSection = shadowRoot.getElementById('jmMissingSection');
    const missingEl = shadowRoot.getElementById('jmMissingSkills');
    if (data.missingSkills && data.missingSkills.length) {
      missingEl.innerHTML = data.missingSkills.map(s =>
        `<span class="jm-tag jm-tag-missing">${escapeHTML(s)}</span>`
      ).join('');
      missingSection.style.display = 'block';
    }

    // Recommendations
    const recsSection = shadowRoot.getElementById('jmRecsSection');
    const recsEl = shadowRoot.getElementById('jmRecs');
    if (data.recommendations && data.recommendations.length) {
      recsEl.innerHTML = data.recommendations.map(r =>
        `<li>${escapeHTML(r)}</li>`
      ).join('');
      recsSection.style.display = 'block';
    }

    // Insights
    const insightsSection = shadowRoot.getElementById('jmInsightsSection');
    const insightsEl = shadowRoot.getElementById('jmInsights');
    if (data.insights) {
      let html = '';
      if (data.insights.strengths) {
        html += `<div class="jm-insight-block"><h4>Strengths</h4><p>${escapeHTML(data.insights.strengths)}</p></div>`;
      }
      if (data.insights.gaps) {
        html += `<div class="jm-insight-block"><h4>Gaps</h4><p>${escapeHTML(data.insights.gaps)}</p></div>`;
      }
      insightsEl.innerHTML = html;
      insightsSection.style.display = 'block';

      // Keywords
      if (data.insights.keywords && data.insights.keywords.length) {
        const keySection = shadowRoot.getElementById('jmKeywordsSection');
        const keyEl = shadowRoot.getElementById('jmKeywords');
        keyEl.innerHTML = data.insights.keywords.map(k =>
          `<span class="jm-tag jm-tag-keyword">${escapeHTML(k)}</span>`
        ).join('');
        keySection.style.display = 'block';
      }
    }
  }

  /**
   * Maps a 0–100 match score to a CSS class for color-coding the score circle.
   * @param {number} score - The match score.
   * @returns {'score-green'|'score-amber'|'score-red'}
   */
  function getScoreClass(score) {
    if (score >= 70) return 'score-green';
    if (score >= 45) return 'score-amber';
    return 'score-red';
  }

  // ─── Save job ─────────────────────────────────────────────────

  /**
   * Saves the current job to the user's saved-jobs list via background.js.
   *
   * Works with or without a completed analysis: if the user has already run
   * Analyze, the full analysis (score, matching/missing skills, etc.) is
   * saved alongside the bookmark. Otherwise — bookmarking is meant to work
   * without spending an AI call — this falls back to the same page-scraping
   * extractors previewJobMeta() uses, so a quick-save costs nothing but a
   * DOM read. Quick-saved jobs get `score: null` (not 0), which the Saved
   * Jobs tab renders as "Not analyzed" rather than a misleading red 0.
   * @async
   */
  async function saveJob() {
    let jobData;
    if (currentAnalysis) {
      jobData = {
        title: currentAnalysis.title,
        company: currentAnalysis.company,
        location: currentAnalysis.location || '',
        salary: currentAnalysis.salary || '',
        score: currentAnalysis.matchScore,
        url: currentAnalysis.url,
        analysis: currentAnalysis
      };
    } else {
      const title = extractJobTitle();
      const company = extractCompany();
      if (!title && !company) return; // nothing on this page worth bookmarking
      jobData = {
        title: title || 'Unknown Position',
        company: company || 'Unknown Company',
        location: extractLocation() || '',
        salary: extractSalary() || '',
        score: null,
        url: window.location.href,
        analysis: null
      };
    }
    try {
      await sendMessage({ type: 'SAVE_JOB', jobData });
      // Update button to "Saved" state
      const saveBtn = shadowRoot.getElementById('jmSaveJob');
      if (saveBtn) {
        saveBtn.textContent = 'Saved';
        saveBtn.disabled = true;
        saveBtn.style.opacity = '0.7';
      }
      setStatus('Job saved to tracker!', 'success');
      setTimeout(clearStatus, 2000);
    } catch (err) {
      setStatus('Error saving: ' + err.message, 'error');
    }
  }

  // ─── Mark as Applied ─────────────────────────────────────────

  // Jobs at or below this AI match score can't be marked as applied — a
  // guardrail against tracking (and syncing to Sheets) applications to
  // obviously poor-fit postings. The button enables only for a score
  // strictly ABOVE this value (75 itself stays disabled). Only gates the
  // "Mark as Applied" default state; a job already confirmed-synced
  // ("Applied", locked) is left alone.
  const MIN_SCORE_TO_APPLY = 75;

  /**
   * Enables/disables the Mark Applied button based on the current job's AI
   * match score. Called after every Analyze (fresh or cache-hit) once
   * currentAnalysis.matchScore is known. Never touches a button already
   * locked into the "Applied" (confirmed-synced) done state.
   * @param {number} [score] - currentAnalysis.matchScore for this job.
   */
  function updateMarkAppliedGating(score) {
    const btn = shadowRoot.getElementById('jmMarkApplied');
    if (!btn || btn.classList.contains('jm-btn-applied-done')) return;
    if (typeof score === 'number' && score <= MIN_SCORE_TO_APPLY) {
      btn.disabled = true;
      btn.title = `Match score is ${score}% — needs to be above ${MIN_SCORE_TO_APPLY}% to mark as applied.`;
    } else {
      btn.disabled = false;
      btn.title = '';
    }
  }

  /**
   * Records the current job as applied and attempts the Google Sheets sync.
   *
   * "Applied" (button reads "Applied", locked) means the sync was CONFIRMED
   * successful — a row was actually appended to the user's Google Sheet.
   * If Google Sheets Sync is disabled, or the webhook call fails, the button
   * is left as "Mark as Applied" (re-enabled) so the user can click it again
   * once they've fixed their Sheets Sync settings — background.js reuses the
   * same local record and retries the sync rather than creating a duplicate.
   * @async
   */
  async function markApplied() {
    if (!currentAnalysis) return;
    // Belt-and-suspenders: updateMarkAppliedGating() disables the button for
    // low scores, but guard the action itself too in case it's ever invoked
    // some other way (e.g. TRIGGER_APPLIED-style messaging in the future).
    if (typeof currentAnalysis.matchScore === 'number' && currentAnalysis.matchScore <= MIN_SCORE_TO_APPLY) {
      setStatus(`Match score is ${currentAnalysis.matchScore}% — needs to be above ${MIN_SCORE_TO_APPLY}% to mark as applied.`, 'error');
      setTimeout(clearStatus, 4000);
      return;
    }
    const btn = shadowRoot.getElementById('jmMarkApplied');
    btn.disabled = true;
    try {
      const result = await sendMessage({
        type: 'MARK_APPLIED',
        jobData: {
          title: currentAnalysis.title,
          company: currentAnalysis.company,
          location: currentAnalysis.location || '',
          salary: currentAnalysis.salary || '',
          score: currentAnalysis.matchScore || 0,
          url: currentAnalysis.url,
          resume: currentAnalysis.resumeName || ''
        }
      });
      if (result && result.sheetsSynced === true) {
        btn.textContent = 'Applied';
        btn.className = 'jm-btn jm-btn-applied-done';
        btn.disabled = true;
        setStatus('Marked as applied and synced to Google Sheets!', 'success');
        setTimeout(clearStatus, 2500);
      } else {
        // Not confirmed synced — leave the button actionable so the user
        // can retry (e.g. after fixing their Web App URL / secret).
        btn.textContent = 'Mark as Applied';
        btn.className = 'jm-btn jm-btn-applied';
        btn.disabled = false;
        const reason = (result && result.sheetsSyncError) || 'Google Sheets sync is not enabled.';
        setStatus('Not synced to Google Sheets yet — ' + reason, 'error');
        setTimeout(clearStatus, 4000);
      }
    } catch (err) {
      setStatus('Error: ' + err.message, 'error');
      btn.disabled = false;
    }
  }

  async function checkIfApplied() {
    try {
      const jobs = await sendMessage({ type: 'GET_APPLIED_JOBS' });
      const btn = shadowRoot.getElementById('jmMarkApplied');
      if (!btn) return;
      const here = normalizeUrl(window.location.href);
      // "Applied" means this job's row was CONFIRMED appended to the user's
      // Google Sheet (sheetsSynced === true) — not merely that a local
      // record exists. A record with sheetsSynced false/undefined (sync
      // disabled, or the webhook call failed) still shows "Mark as Applied"
      // so the button stays actionable/retryable.
      if (jobs && jobs.some(j => normalizeUrl(j.url) === here && j.sheetsSynced === true)) {
        btn.textContent = 'Applied';
        btn.className = 'jm-btn jm-btn-applied-done';
        btn.style.display = 'flex';
      } else {
        // Reset to the default un-applied state. Without this branch, once
        // ANY job got marked "Applied" during this page load, the button's
        // stale text/class would silently carry over to every other job
        // viewed afterward on the same SPA (the panel's shadow DOM persists
        // across client-side navigations — see togglePanel's `if
        // (!panelRoot) createPanel()`), showing "Applied" for jobs that
        // were never actually marked.
        btn.textContent = 'Mark as Applied';
        btn.className = 'jm-btn jm-btn-applied';
      }
    } catch (e) { /* ignore */ }
  }

  // ─── AutoFill ─────────────────────────────────────────────────
  // The autofill pipeline:
  //   1. Detect — detectFormFields() scans the page and builds _fieldMap.
  //   2. AI     — GENERATE_AUTOFILL sends questions to background, gets answers.
  //   3. Fill   — fillFormFromAnswers() immediately writes answers into the form.

  /**
   * Initiates the autofill pipeline: detects fields, asks AI for answers,
   * then immediately fills the form.
   * @async
   */
  async function autofillForm() {
    console.log('[JobMatch AI] AutoFill button clicked');
    const btn = shadowRoot.getElementById('jmAutofill');
    if (!btn) { console.error('[JobMatch AI] AutoFill button not found'); return; }
    btn.disabled = true;
    btn.innerHTML = '<span class="jm-spinner"></span> Scanning form...';
    // Hide previous run's warning
    const _autofillWarning = shadowRoot.getElementById('jmAutofillWarning');
    if (_autofillWarning) _autofillWarning.style.display = 'none';

    try {
      // Step 0: make sure "the active resume" is the best local ATS match
      // for this JD before anything below reads it (file upload AND the
      // Q&A/AI text passes both key off whichever resume is active).
      try {
        await ensureBestResumeSelected();
      } catch (_) {}

      // Step 1: detect fields and store DOM references
      _fieldMap = {};
      clearAutofillBadges(); // remove any badges left over from a previous run on this page
      console.log('[JobMatch AI] Detecting form fields...');
      const questions = detectFormFields();
      console.log(`[JobMatch AI] Found ${questions.length} form fields`);

      // Pass 0: Attach the active resume's file to any resume-upload field
      // found in this frame (no AI call — see attachResumeFile()). Runs
      // before the "no fields found" check below since a bare "upload your
      // resume" page can have a file input and nothing else.
      setStatus('Attaching resume...', 'info');
      let resumeResult = { attached: 0, fileName: null };
      try {
        resumeResult = await attachResumeFile();
      } catch (_) { /* best-effort — the rest of the pipeline still runs */ }

      if (questions.length === 0) {
        // No text/dropdown/radio/checkbox fields in top frame — try iframes via broadcast
        console.log('[JobMatch AI] No fields in top frame, broadcasting to iframes...');
        setStatus('Found embedded form. Filling fields...', 'info');
        try {
          // Routes through the sendMessage wrapper so an invalidated extension
          // context surfaces a clean error instead of an uncaught exception.
          // The wrapper unwraps the {success, data} envelope, so we read
          // .filled directly off the resolved value.
          const iframeData = await sendMessage({ type: 'AUTOFILL_IN_FRAMES' });
          const iframeFilled = iframeData?.filled || 0;
          if (iframeFilled > 0 || resumeResult.attached > 0) {
            let msg = `Filled ${iframeFilled} field${iframeFilled === 1 ? '' : 's'} in embedded form.`;
            if (resumeResult.attached > 0) msg += ` Attached resume (${resumeResult.fileName}).`;
            setStatus(msg, 'success');
            setTimeout(clearStatus, 5000);
            return;
          }
        } catch (iframeErr) {
          console.warn('[JobMatch AI] iframe broadcast error:', iframeErr);
        }
        if (resumeResult.attached > 0) {
          setStatus(`Attached resume (${resumeResult.fileName}). No other form fields found.`, 'success');
          setTimeout(clearStatus, 5000);
        } else {
          setStatus('No form fields found on this page.', 'error');
        }
        return;
      }

      // Pass 1: Direct fill from Q&A (no AI)
      setStatus('Filling from Q&A...', 'info');
      let directFilled = 0;
      if (window.__jobMatchDirectFill) {
        try {
          const qaList = await sendMessage({ type: 'GET_QA_LIST' }) || [];
          const profile = await sendMessage({ type: 'GET_PROFILE', resumeId: _activeResumeId }) || {};
          const directResult = await window.__jobMatchDirectFill(qaList, profile);
          directFilled = directResult.filled;
        } catch (_) {}
      }

      setStatus(`Direct fill: ${directFilled}. Sending rest to AI...`, 'info');

      // Pass 2: AI fill for remaining empty fields
      const questionsForAI = questions.filter(q => {
        const el = q._el;
        if (!el) return true;
        return !(el.value || '').trim();
      }).map(q => {
        const clean = { ...q };
        delete clean._el;
        delete clean._radios;
        return clean;
      });

      console.log('[JobMatch AI] Sending to AI for autofill...');
      const response = await sendMessage({
        type: 'GENERATE_AUTOFILL',
        formFields: questionsForAI,
        resumeId: _activeResumeId
      });
      console.log('[JobMatch AI] AI response received');

      // Step 3: write the AI's proposed answers straight into the form —
      // no review/confirm gate. Any answer the AI couldn't produce
      // (NEEDS_USER_INPUT / blank) is simply left for the user to fill in.
      const answers = response.answers || response;
      const { filled, skipped } = await fillFormFromAnswers(Array.isArray(answers) ? answers : []);
      const totalFilled = directFilled + filled;
      let msg = `Filled ${totalFilled} field${totalFilled === 1 ? '' : 's'}.`;
      if (resumeResult.attached > 0) msg += ` Attached resume (${resumeResult.fileName}).`;
      if (skipped.length > 0) msg += ` ${skipped.length} left for you to fill in manually.`;
      setStatus(msg, 'success');
      setTimeout(clearStatus, 4000);

      const warningEl = shadowRoot && shadowRoot.getElementById('jmAutofillWarning');
      if (warningEl) warningEl.style.display = 'flex';
    } catch (err) {
      console.error('[JobMatch AI] AutoFill error:', err);
      setStatus('Error: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = 'AutoFill Application';
    }
  }

  // ─── Form field detection ─────────────────────────────────────
  // Scans the live DOM for all fillable form fields and builds two data structures:
  //   questions[] — serialisable descriptors sent to the AI (label, type, options)
  //   _fieldMap   — maps each question_id to the actual DOM element(s) for filling
  //
  // Supported field types: text/email/tel/number inputs, textareas, native <select>,
  // custom dropdown triggers (aria-combobox, aria-haspopup), radio groups, checkboxes.

  /**
   * Detects all fillable form fields on the current page.
   * Populates the module-level _fieldMap and returns a serialisable questions array.
   * @returns {Array<Object>} Array of field descriptors to send to the AI.
   */
  function detectFormFields() {
    const questions = [];
    let qIndex = 0;
    const seen = new Set(); // track qids to avoid duplicates
    _resumeFileFields = []; // reset — repopulated by the file-input pass below

    // ── Helper: build select option data ──
    function buildSelectOptions(selectEl) {
      const optMap = {};
      const optTexts = [];
      Array.from(selectEl.options).forEach(o => {
        const v = o.value.trim();
        const t = o.textContent.trim();
        if (!v || v === '' || v === '-1') return;
        if (!t || /^(select|choose|--|pick)/i.test(t)) return;
        optTexts.push(t);
        optMap[t.toLowerCase()] = o.value;
      });
      return { optMap, optTexts };
    }

    // ── Helper: detect if an input is a custom dropdown trigger ──
    function isCustomDropdown(el) {
      if (el.getAttribute('role') === 'combobox') return true;
      if (el.getAttribute('aria-haspopup') === 'listbox' || el.getAttribute('aria-haspopup') === 'true') return true;
      if (el.getAttribute('aria-autocomplete')) return true;
      if (el.getAttribute('data-testid')?.includes('select')) return true;
      // Check if parent/grandparent looks like a select wrapper
      const wrapper = el.closest('[class*="select"], [class*="dropdown"], [class*="combobox"], [class*="listbox"]');
      if (wrapper && wrapper.querySelector('[role="listbox"], [role="option"], [class*="option"]')) return true;
      return false;
    }

    // ── Helper: read options from custom dropdown's associated listbox ──
    function readCustomOptions(el) {
      const optTexts = [];
      // 1. Check aria-controls / aria-owns
      const listboxId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
      if (listboxId) {
        const lb = document.getElementById(listboxId);
        if (lb) {
          lb.querySelectorAll('[role="option"]').forEach(o => {
            const t = o.textContent.trim();
            if (t) optTexts.push(t);
          });
          if (optTexts.length > 0) return optTexts;
        }
      }
      // 2. Search nearby in DOM
      const container = el.closest('[class*="select"], [class*="dropdown"], [class*="field"], [data-testid]') || el.parentElement;
      if (container) {
        container.querySelectorAll('[role="option"], [class*="option"]:not([class*="options"])').forEach(o => {
          const t = o.textContent.trim();
          if (t && !optTexts.includes(t)) optTexts.push(t);
        });
      }
      return optTexts;
    }

    // ── 1. ALL <select> elements (visible AND hidden) ──
    document.querySelectorAll('select').forEach(sel => {
      const qid = sel.id || sel.name;
      if (!qid || seen.has(qid)) return;
      // C3b: skip CSRF/tracking/honeypot fields entirely — never send them
      // to the AI, never offer them to the user as autofill candidates.
      if (!isFieldEligible(sel)) return;
      const label = getFieldLabel(sel);
      if (!label && !sel.id && !sel.name) return;

      const { optMap, optTexts } = buildSelectOptions(sel);
      if (optTexts.length === 0) return;

      seen.add(qid);
      questions.push({
        question_id: qid,
        question_text: label || sel.name || '',
        field_type: 'dropdown',
        required: sel.required,
        available_options: optTexts
      });
      _fieldMap[qid] = { el: sel, type: 'dropdown', optionMap: optMap, optionTexts: optTexts, questionText: label || sel.name || '' };
      qIndex++;
    });

    // ── 2. Text inputs, textareas (detect custom dropdowns among them) ──
    document.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea'
    ).forEach(input => {
      if (input.offsetParent === null) return;
      // C3b: skip CSRF/tracking/honeypot fields.
      if (!isFieldEligible(input)) return;
      const label = getFieldLabel(input);
      const qid = input.id || input.name || ('q_' + qIndex);
      if ((!label && !input.id && !input.name) || seen.has(qid)) return;

      const tag = input.tagName.toLowerCase();

      // Check if this text input is actually a custom dropdown
      if (tag !== 'textarea' && isCustomDropdown(input)) {
        const optTexts = readCustomOptions(input);
        seen.add(qid);
        questions.push({
          question_id: qid,
          question_text: label || input.placeholder || input.name || '',
          field_type: 'dropdown',
          required: input.required,
          available_options: optTexts // may be empty — will be read during fill
        });
        _fieldMap[qid] = { el: input, type: 'custom_dropdown', optionTexts: optTexts, questionText: label || input.placeholder || input.name || '' };
        qIndex++;
        return;
      }

      // Check if a hidden <select> shares this field's container (custom select wrappers)
      const container = input.closest('.field, .form-field, .form-group, [class*="field"], [class*="select"]');
      if (container) {
        const hiddenSelect = container.querySelector('select');
        if (hiddenSelect && !seen.has(hiddenSelect.id || hiddenSelect.name)) {
          const selQid = hiddenSelect.id || hiddenSelect.name || qid;
          if (!seen.has(selQid)) {
            const { optMap, optTexts } = buildSelectOptions(hiddenSelect);
            if (optTexts.length > 0) {
              seen.add(selQid);
              seen.add(qid);
              questions.push({
                question_id: selQid,
                question_text: label || input.placeholder || '',
                field_type: 'dropdown',
                required: input.required || hiddenSelect.required,
                available_options: optTexts
              });
              // Store BOTH the hidden select and the visible input
              _fieldMap[selQid] = {
                el: hiddenSelect, visibleEl: input,
                type: 'dropdown', optionMap: optMap, optionTexts: optTexts,
                questionText: label || input.placeholder || ''
              };
              qIndex++;
              return;
            }
          }
        }
      }

      // Regular text / textarea
      seen.add(qid);
      const fieldType = tag === 'textarea' ? 'textarea' : 'text';
      questions.push({
        question_id: qid,
        question_text: label || input.placeholder || input.name || '',
        field_type: fieldType,
        required: input.required
      });
      _fieldMap[qid] = { el: input, type: fieldType };
      qIndex++;
    });

    // ── 3. Radio button groups ──
    const radioGroups = {};
    document.querySelectorAll('input[type="radio"]').forEach(radio => {
      if (radio.offsetParent === null) return;
      const groupName = radio.name;
      if (!groupName) return;
      // C3b: skip groups whose name looks like CSRF/tracking/etc.
      if (!isFieldEligible(radio)) return;
      if (!radioGroups[groupName]) {
        radioGroups[groupName] = {
          question_id: groupName,
          question_text: getFieldLabel(radio) || groupName.replace(/[_-]/g, ' '),
          field_type: 'radio',
          required: radio.required,
          available_options: [],
          _radios: []
        };
        _fieldMap[groupName] = { type: 'radio', radios: [] };
      }
      const optText = getRadioLabel(radio);
      if (optText && !radioGroups[groupName].available_options.includes(optText)) {
        radioGroups[groupName].available_options.push(optText);
      }
      radioGroups[groupName]._radios.push(radio);
      _fieldMap[groupName].radios.push({ el: radio, text: optText });
    });
    for (const group of Object.values(radioGroups)) {
      if (group.available_options.length > 0) {
        const clean = { ...group };
        delete clean._radios;
        questions.push(clean);
      }
    }

    // ── 4. Standalone checkboxes ──
    document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      if (cb.offsetParent === null) return;
      // C3b: skip honeypot / token-shaped checkboxes.
      if (!isFieldEligible(cb)) return;
      const label = getFieldLabel(cb) || getRadioLabel(cb);
      if (!label) return;
      const qid = cb.id || cb.name || ('cb_' + qIndex);
      if (seen.has(qid)) return;
      seen.add(qid);
      questions.push({
        question_id: qid,
        question_text: label,
        field_type: 'checkbox',
        required: cb.required,
        available_options: ['Yes', 'No']
      });
      _fieldMap[qid] = { el: cb, type: 'checkbox' };
      qIndex++;
    });

    // ── 5. Resume-upload file inputs ──
    // Filled locally from the active resume's raw file bytes (see
    // attachResumeFile()) — never sent to the AI, so these are collected
    // into _resumeFileFields rather than pushed onto `questions`.
    document.querySelectorAll('input[type="file"]').forEach(fileEl => {
      if (fileEl.offsetParent === null) return;
      if (!isFieldEligible(fileEl)) return;
      if (fileEl.files && fileEl.files.length > 0) return; // already has a file — don't clobber it
      const label = getFieldLabel(fileEl);
      if (!looksLikeResumeUpload(fileEl, label)) return;
      _resumeFileFields.push({ el: fileEl, label });
    });

    return questions;
  }

  /**
   * Heuristic: does this file input look like a resume/CV upload field
   * (as opposed to a cover letter, portfolio, transcript, or "additional
   * documents" upload)? Checked against the field's label, id, name, and
   * accept attribute. Deliberately conservative — a false positive would
   * attach the resume to the wrong upload field, so any cover-letter-ish
   * wording anywhere in the probe text disqualifies the field even if
   * "resume" also appears (e.g. "Resume/Cover Letter" combined uploaders
   * are skipped rather than guessed at).
   * @param {HTMLInputElement} el
   * @param {string} label
   * @returns {boolean}
   */
  function looksLikeResumeUpload(el, label) {
    const probe = [label, el.id, el.name, el.getAttribute('aria-label'), el.getAttribute('data-testid')]
      .filter(Boolean).join(' ').toLowerCase();
    if (!probe) return false;
    if (/cover[\s_-]?letter|coverletter|portfolio|transcript|writing[\s_-]?sample|references?\b/i.test(probe)) return false;
    return /resum[eé]|\bcv\b|curriculum vitae/i.test(probe);
  }

  /**
   * Re-affirms (or updates) the active resume as the best local
   * ATS-keyword match for the current job description, before AutoFill
   * reads "the active resume" for both the file-upload attachment and the
   * Q&A/AI text answers.
   *
   * This duplicates (rather than calls into) the equivalent auto-select
   * block inside analyzeJob(), deliberately: scanResumeMatch() — which
   * runs on panel open and on SPA navigation — already does this same
   * switch, but it's fire-and-forget there, so there's a brief window
   * right after opening the panel or navigating to a new posting where
   * _activeResumeId could still point at a stale resume if AutoFill is
   * clicked before that scan finishes. Calling this at the start of
   * autofillForm() makes AutoFill's resume selection deterministic
   * instead of "usually right by the time you click". A manual pick for
   * this job (_manualResumeSelection) is always honored over the score,
   * exactly as it is for Analyze.
   * @async
   */
  async function ensureBestResumeSelected() {
    if (_manualResumeSelection) return;
    try {
      const jdForRanking = (await getJobDescriptionForAnalysis()) || '';
      if (!jdForRanking) return;
      const { resumes = [], activeResumeId } = await chrome.storage.local.get(['resumes', 'activeResumeId']);
      if (resumes.length < 2) return; // nothing to compare against
      const ranked = rankResumes(jdForRanking, resumes);
      const top = ranked[0];
      const currentId = activeResumeId || _activeResumeId;
      if (top && top.score > 0 && top.id !== currentId) {
        await switchSlot(top.id, { silent: true });
      }
    } catch (_) { /* best-effort — AutoFill proceeds with whichever resume is active */ }
  }

  /**
   * Builds a File for the currently active resume — shared by
   * attachResumeFile() (AutoFill's automatic attachment) and
   * downloadActiveResumeFile() (the manual "⬇ Resume file" button), so
   * both always produce the exact same bytes and the exact same name.
   *
   * Filename is always the generated "Resume_<CandidateName>.<ext>" form
   * (e.g. "Resume_Jane-Doe.pdf") rather than the originally-uploaded
   * filename — falls back to a bare "Resume.<ext>" when no candidate name
   * is available yet. Format always matches whatever the resume was
   * actually uploaded as (PDF stays PDF, DOCX stays DOCX) — this never
   * converts between formats.
   *
   * How it works: background.js's rawResumeBase64/resumeFileType keys are
   * kept mirrored to whichever resume is active (see switchSlot()), so
   * GET_RAW_RESUME always returns the right file for the resume AutoFill
   * (or the download button) is currently running against.
   *
   * @async
   * @returns {Promise<{file: File, fileName: string, mime: string, ext: string}|null>}
   *   null when there's no resume file saved yet, or it couldn't be decoded.
   */
  async function buildActiveResumeFile() {
    let raw;
    try {
      raw = await sendMessage({ type: 'GET_RAW_RESUME', resumeId: _activeResumeId });
    } catch (_) {
      return null;
    }
    const { rawResumeBase64, fileType } = raw || {};
    if (!rawResumeBase64) return null;

    const ext = fileType === 'docx' ? 'docx' : 'pdf';
    const mime = ext === 'docx'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'application/pdf';

    let candidateName = '';
    try {
      const profile = await sendMessage({ type: 'GET_PROFILE', resumeId: _activeResumeId });
      candidateName = (profile && profile.name) || '';
    } catch (_) { /* fall back to a generic filename below */ }
    const nameSeg = sanitizeFileNameSegment(candidateName);
    const fileName = (nameSeg ? `Resume_${nameSeg}` : 'Resume') + '.' + ext;

    try {
      const blob = base64ToBlob(rawResumeBase64, mime);
      const file = new File([blob], fileName, { type: mime });
      return { file, fileName, mime, ext };
    } catch (err) {
      console.warn('[JobMatch AI] Could not build resume File object:', err.message);
      return null;
    }
  }

  /**
   * Attaches the active resume's raw file to every detected resume-upload
   * field (see _resumeFileFields), so AutoFill can complete a file-upload
   * widget the same way it fills text fields — no AI call, no network
   * request beyond the existing GET_RAW_RESUME / GET_PROFILE messages (via
   * buildActiveResumeFile()).
   *
   * Call ensureBestResumeSelected() before this so "the active resume" is
   * guaranteed to be the best local ATS match rather than whatever was
   * last active for a different job.
   *
   * The file itself is attached to the input via a DataTransfer (the
   * standard trick for scripting a native file input — Chrome does not
   * allow setting .files directly), and both a plain 'change' event and
   * synthetic drag events are dispatched, since some ATS upload widgets
   * (react-dropzone-style components common on Lever/Workday) listen for a
   * 'drop' event on a wrapping element rather than 'change' on the input
   * itself.
   *
   * @async
   * @returns {Promise<{attached: number, fileName: string|null, reason?: string}>}
   */
  async function attachResumeFile() {
    if (!_resumeFileFields.length) return { attached: 0, fileName: null };

    const built = await buildActiveResumeFile();
    if (!built) return { attached: 0, fileName: null, reason: 'no-resume' };
    const { file, fileName, ext, mime } = built;

    let attached = 0;
    for (const { el } of _resumeFileFields) {
      if (!el.isConnected) continue;
      if (!fileAcceptsType(el, ext, mime)) continue;
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        el.files = dt.files;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));

        // Some upload widgets are drop-zones listening for 'drop' rather
        // than (or in addition to) the input's 'change' — fire the same
        // sequence on the input and its likely drop-zone wrapper. Wrapped
        // in its own try/catch: DragEvent-with-dataTransfer construction
        // isn't universally needed, so a failure here shouldn't undo the
        // native-input attachment above.
        try {
          const dropTarget = el.closest('[class*="dropzone"], [class*="drop-zone"], [class*="drag"], [class*="upload"]') || el;
          ['dragenter', 'dragover', 'drop'].forEach(type => {
            dropTarget.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
          });
        } catch (_) { /* best-effort only */ }

        showAutofillBadge(el);
        attached++;
      } catch (err) {
        console.warn('[JobMatch AI] Could not attach resume file to field:', err.message);
      }
    }

    return { attached, fileName: attached > 0 ? fileName : null };
  }

  /**
   * Handler for the "⬇ Resume file" button next to the Local Match score —
   * downloads the exact file (same bytes, same generated name) that
   * attachResumeFile() would attach to a resume-upload field right now, so
   * the user can open it themselves and confirm it's correct before
   * trusting AutoFill to attach it on a real application form.
   *
   * Uses the standard content-script download trick (object URL + a
   * temporary `<a download>` click) rather than chrome.downloads, since
   * this fork has no "downloads" permission in the manifest and this way
   * needs none — it's the same mechanism a page's own "Download" link
   * would use.
   * @async
   */
  async function downloadActiveResumeFile() {
    try {
      const built = await buildActiveResumeFile();
      if (!built) {
        setStatus('No resume file saved for the active resume.', 'error');
        setTimeout(clearStatus, 3000);
        return;
      }
      const url = URL.createObjectURL(built.file);
      const a = document.createElement('a');
      a.href = url;
      a.download = built.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke on a delay rather than immediately — some browsers process
      // the download asynchronously and revoking too early can abort it.
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      setStatus(`Downloaded ${built.fileName}.`, 'success');
      setTimeout(clearStatus, 3000);
    } catch (err) {
      console.warn('[JobMatch AI] Resume download failed:', err.message);
      setStatus('Could not download resume: ' + err.message, 'error');
    }
  }

  /**
   * Best-effort check of a file input's `accept` attribute against the
   * resume's actual type — an input explicitly restricted to a
   * type the resume isn't (e.g. accept=".doc,.docx" but the saved resume
   * is a PDF) is skipped rather than attached and likely rejected by the
   * page anyway. An input with no `accept`, or one that already allows
   * the resume's extension/mimetype, passes.
   * @param {HTMLInputElement} el
   * @param {string} ext - 'pdf' | 'docx'
   * @param {string} mime
   * @returns {boolean}
   */
  function fileAcceptsType(el, ext, mime) {
    const accept = (el.getAttribute('accept') || '').trim();
    if (!accept) return true;
    const tokens = accept.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    if (tokens.some(t => t === '*/*' || t === '*')) return true;
    return tokens.some(t => t === '.' + ext || t === mime || (t.endsWith('/*') && mime.startsWith(t.slice(0, -1))));
  }

  /**
   * Decodes a base64 string into a Blob of the given MIME type.
   * @param {string} base64
   * @param {string} mimeType
   * @returns {Blob}
   */
  function base64ToBlob(base64, mimeType) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
    return new Blob([bytes], { type: mimeType });
  }

  /**
   * Sanitizes a name segment for use in a generated filename — same rules
   * as lib/coverLetterFilename.mjs's buildCoverLetterFilename(), kept as a
   * small local copy here since content.js is a classic (non-module)
   * script and can't import that .mjs helper directly.
   * @param {string} input
   * @returns {string}
   */
  function sanitizeFileNameSegment(input) {
    let s = String(input || '').trim();
    if (!s) return '';
    s = s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!s || s.length <= 30) return s;
    const cut = s.lastIndexOf('-', 30);
    return cut > 0 ? s.slice(0, cut) : s.slice(0, 30);
  }

  /**
   * Extracts the visible label text for a radio button.
   * Clones the parent label and strips the input element to get only text.
   * @param {HTMLInputElement} input - A radio input element.
   * @returns {string} The label text, or '' if not determinable.
   */
  function getRadioLabel(input) {
    const parentLabel = input.closest('label');
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll('input').forEach(el => el.remove());
      const text = clone.textContent.trim();
      if (text) return text;
    }
    const next = input.nextSibling;
    if (next && next.nodeType === Node.TEXT_NODE && next.textContent.trim()) {
      return next.textContent.trim();
    }
    if (next && next.nodeType === Node.ELEMENT_NODE && next.tagName === 'LABEL') {
      return next.textContent.trim();
    }
    if (input.getAttribute('aria-label')) return input.getAttribute('aria-label');
    if (input.value && input.value !== 'on') return input.value;
    return '';
  }

  /**
   * Resolves a human-readable label for a form input using multiple strategies:
   * 1. <label for="id"> association, 2. wrapping <label>, 3. aria-label/aria-labelledby,
   * 4. placeholder, 5. nearby sibling/parent text.
   * @param {HTMLElement} input - Any form element.
   * @returns {string} The best label text found, or ''.
   */
  function getFieldLabel(input) {
    // 1. <label for="id">
    if (input.id) {
      const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (label) return label.textContent.trim();
    }

    // 2. Wrapping <label>
    const parentLabel = input.closest('label');
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll('input, textarea, select').forEach(el => el.remove());
      const text = clone.textContent.trim();
      if (text) return text;
    }

    // 3. aria-label
    if (input.getAttribute('aria-label')) return input.getAttribute('aria-label');

    // 4. aria-labelledby
    const labelledBy = input.getAttribute('aria-labelledby');
    if (labelledBy) {
      const el = document.getElementById(labelledBy);
      if (el) return el.textContent.trim();
    }

    // 5. placeholder
    if (input.placeholder) return input.placeholder;

    // 6. name attribute (humanized)
    if (input.name) return input.name.replace(/[_-]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');

    return '';
  }

  // ─── Form filling (uses _fieldMap from detection) ────────────

  /**
   * Fills form fields using AI-generated answers and the _fieldMap built by detectFormFields.
   * Routes each answer to the correct fill strategy based on the field type:
   *   - 'dropdown'        → fillSelectByText (native <select>)
   *   - 'custom_dropdown' → fillCustomDropdown (ARIA combobox, opens a listbox)
   *   - 'radio'           → fillRadioFromRef
   *   - 'checkbox'        → fillCheckboxFromRef
   *   - default           → fillInput (text/textarea/email/etc.)
   *
   * Falls back to fillFormLegacy() if answers is a plain object (old AI response format).
   * @async
   * @param {Array<Object>|Object} answers - AI answer array or legacy flat object.
   * @returns {Promise<{filled: number, skipped: string[]}>}
   */
  // Synonym groups for semantic matching — organized by category
  const _genderGroups = [
    ['male', 'man', 'he', 'him', 'he/him'],
    ['female', 'woman', 'she', 'her', 'she/her'],
    ['non-binary', 'non binary', 'nonbinary', 'they', 'them', 'they/them', 'genderqueer'],
  ];
  const _yesNoGroups = [
    ['yes', 'true', 'i am', 'authorized', 'i do', 'i have'],
    ['no', 'false', 'i am not', 'not authorized', 'i do not', 'i don\'t'],
    ['prefer not to say', 'decline', 'decline to self-identify', 'do not wish', 'choose not', 'not to answer'],
  ];
  const _raceGroups = [
    ['white', 'caucasian'],
    ['black', 'african american'],
    ['asian', 'asian american', 'east asian', 'south asian', 'southeast asian'],
    ['hispanic', 'latino', 'latina', 'latinx'],
  ];
  const _orientationGroups = [
    ['straight', 'heterosexual', 'straight / heterosexual'],
    ['gay', 'lesbian', 'gay or lesbian'],
    ['bisexual', 'bi'],
  ];
  const _synonymGroups = [..._genderGroups, ..._yesNoGroups, ..._raceGroups, ..._orientationGroups];

  function _findSynonymGroup(val) {
    const lower = val.toLowerCase().trim();
    // Use word boundary matching to avoid "woman" matching "man"
    // Check exact match first, then word boundary regex
    return _synonymGroups.find(g => g.some(s => {
      if (lower === s) return true;
      // Word boundary: "man" should not match "woman"
      const re = new RegExp('\\b' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
      return re.test(lower);
    }));
  }

  // ─── Autofill badges ─────────────────────────────────────────
  // Small "AI" pills placed next to each field AutoFill just wrote a value
  // into — a visual cue backing the "please review AI answers" warning
  // shown after a fill. Rendered into the page's own DOM (not the shadow
  // panel), since that's where the filled fields actually live.

  /**
   * Displays an "AI"-labeled badge pinned to the top-right corner of a
   * field that was just autofilled, and wires up shared scroll/resize
   * listeners (once) so every tracked badge stays anchored to its field as
   * the page moves. Tracked in _badges for clearAutofillBadges() to remove.
   * @param {HTMLElement} fieldEl - The form element that was just filled.
   */
  function showAutofillBadge(fieldEl) {
    if (!fieldEl || !fieldEl.isConnected) return;
    const badgeEl = document.createElement('div');
    badgeEl.textContent = 'AI';
    badgeEl.title = 'Filled by JobMatch AI — please review';
    badgeEl.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'background:#3b82f6', 'color:#fff',
      'font:600 10px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'padding:2px 5px', 'border-radius:8px', 'pointer-events:none',
      'box-shadow:0 1px 3px rgba(0,0,0,0.35)',
    ].join(';');
    document.body.appendChild(badgeEl);

    const entry = { badgeEl, fieldEl };
    _badges.push(entry);
    positionAutofillBadge(entry);

    if (!_badgeScrollHandler) {
      _badgeScrollHandler = () => _badges.forEach(positionAutofillBadge);
      window.addEventListener('scroll', _badgeScrollHandler, { passive: true, capture: true });
    }
    if (!_badgeResizeObs && window.ResizeObserver) {
      _badgeResizeObs = new ResizeObserver(() => _badges.forEach(positionAutofillBadge));
      _badgeResizeObs.observe(document.body);
    }
  }

  /**
   * Repositions one badge at its field's current top-right corner —
   * re-run on scroll/resize since fields move under a fixed-position badge.
   * @param {{badgeEl: HTMLElement, fieldEl: HTMLElement}} entry
   */
  function positionAutofillBadge({ badgeEl, fieldEl }) {
    if (!fieldEl.isConnected) return;
    const r = fieldEl.getBoundingClientRect();
    badgeEl.style.top = Math.max(0, r.top - 8) + 'px';
    badgeEl.style.left = Math.max(0, r.right - 20) + 'px';
  }

  /**
   * Removes every autofill badge and disconnects the shared scroll/resize
   * listeners. Called at the start of a new AutoFill run (so re-running it
   * on the same page doesn't stack duplicate badges) and on SPA navigation
   * to a new job (so badges from the previous posting's form don't linger).
   */
  function clearAutofillBadges() {
    _badges.forEach(({ badgeEl }) => badgeEl.remove());
    _badges = [];
    if (_badgeScrollHandler) {
      window.removeEventListener('scroll', _badgeScrollHandler, { capture: true });
      _badgeScrollHandler = null;
    }
    if (_badgeResizeObs) {
      _badgeResizeObs.disconnect();
      _badgeResizeObs = null;
    }
  }

  /**
   * Fills every detected field from the AI's bulk answers.
   *
   * Fields are bucketed by how they need to be filled rather than handled
   * in one big sequential loop:
   *   - radio/checkbox/text fields need no extra API call — filled
   *     synchronously, in whatever order they were detected.
   *   - native <select> dropdowns each need their own MATCH_DROPDOWN call
   *     (for better accuracy than the bulk answer alone), but don't touch
   *     any shared page UI state, so all of them fire CONCURRENTLY via
   *     Promise.all — this is the main autofill speed-up: N sequential
   *     round-trips collapses to the time of the single slowest one.
   *   - custom ARIA dropdowns (Workday/Greenhouse/Lever-style comboboxes)
   *     have to open/read/click the page's own live dropdown UI, and only
   *     one can safely be open at a time (opening one can close another),
   *     so these stay sequential, same as before.
   * @async
   * @param {Array<Object>} answers - AI-provided answers, one per question_id.
   * @returns {Promise<{filled: number, skipped: string[]}>}
   */
  async function fillFormFromAnswers(answers) {
    // Handle array format (new) or flat object (legacy)
    if (!Array.isArray(answers)) {
      return await fillFormLegacy(answers);
    }

    let filled = 0;
    const skipped = [];
    const nativeDropdowns = [];
    const customDropdowns = [];

    // First pass: validate + bucket. Radio/checkbox/text fields are filled
    // immediately here since they're synchronous and don't need to wait on
    // anything; dropdown types are queued for the phases below.
    for (const ans of answers) {
      const val = ans.selected_option || ans.generated_text || '';
      if (!val || val === 'NEEDS_USER_INPUT') {
        skipped.push(ans.question_id);
        continue;
      }
      const qid = ans.question_id;
      const ref = _fieldMap[qid];
      if (!ref) {
        skipped.push(qid);
        continue;
      }

      try {
        if (ref.type === 'dropdown') {
          nativeDropdowns.push({ qid, ref, val, questionText: ref.questionText || ans.question_text || '' });
        } else if (ref.type === 'custom_dropdown') {
          customDropdowns.push({ qid, ref, val });
        } else if (ref.type === 'radio') {
          if (fillRadioFromRef(ref.radios, val)) {
            // Badge goes below the last radio in the group
            const lastRadio = ref.radios[ref.radios.length - 1]?.el || ref.radios[0]?.el;
            showAutofillBadge(lastRadio);
            filled++;
          } else {
            skipped.push(qid);
          }
        } else if (ref.type === 'checkbox') {
          fillCheckboxFromRef(ref.el, val);
          showAutofillBadge(ref.el);
          filled++;
        } else {
          fillInput(ref.el, val);
          showAutofillBadge(ref.el);
          filled++;
        }
      } catch (e) {
        skipped.push(qid);
      }
    }

    // Phase 2: native <select> dropdowns, all matched concurrently.
    await Promise.all(nativeDropdowns.map(async ({ qid, ref, val, questionText }) => {
      try {
        // For native selects: use deterministic matcher via background for better accuracy
        if (questionText && ref.optionTexts && ref.optionTexts.length > 0) {
          try {
            const bestOption = await sendMessage({
              type: 'MATCH_DROPDOWN',
              questionText: questionText,
              options: ref.optionTexts,
              resumeId: _activeResumeId
            });
            if (bestOption && bestOption !== 'SKIP' && bestOption !== 'NEEDS_USER_INPUT') {
              fillSelectByText(ref.el, bestOption, ref.optionMap, ref.optionTexts);
              showAutofillBadge(ref.el);
              filled++;
              return;
            }
          } catch (e) {
            // fall through to the bulk-answer fallback below
          }
        }
        // Fallback: use the bulk AI answer directly
        fillSelectByText(ref.el, val, ref.optionMap, ref.optionTexts);
        showAutofillBadge(ref.el);
        filled++;
      } catch (e) {
        skipped.push(qid);
      }
    }));

    // Phase 3: custom ARIA dropdowns — sequential, since opening one on a
    // real page can close another that's still mid-fill.
    for (const { qid, ref, val } of customDropdowns) {
      try {
        if (await fillCustomDropdown(ref.el, ref.questionText || val)) {
          showAutofillBadge(ref.el);
          filled++;
        } else {
          skipped.push(qid);
        }
      } catch (e) {
        skipped.push(qid);
      }
    }

    return { filled, skipped };
  }

  /**
   * Legacy fill path for old-format AI responses (flat key→value object).
   * Used as a fallback when the AI returns a map instead of an array.
   * @async
   * @param {Object} mapping - Map of field identifiers to answer strings.
   * @returns {Promise<{filled: number, skipped: []}>}
   */
  async function fillFormLegacy(mapping) {
    let filled = 0;
    for (const [key, value] of Object.entries(mapping)) {
      if (!value || value === 'NEEDS_USER_INPUT') continue;
      const ref = _fieldMap[key];
      if (!ref) continue;
      if (ref.type === 'dropdown') {
        fillSelectByText(ref.el, value, ref.optionMap, ref.optionTexts);
        showAutofillBadge(ref.el);
      } else if (ref.type === 'custom_dropdown') {
        await fillCustomDropdown(ref.el, ref.questionText || value);
        showAutofillBadge(ref.el);
      } else {
        fillInput(ref.el, value);
        showAutofillBadge(ref.el);
      }
      filled++;
    }
    return { filled, skipped: [] };
  }

  // ── Custom dropdown: open → read options → ask AI → click chosen option ──
  // Custom dropdowns (used by Workday, Greenhouse, Lever, etc.) are not native
  // <select> elements — they are ARIA comboboxes that render a listbox on click.
  // Strategy: programmatically open them, read the live option elements, ask AI
  // to pick one, then click the matching element and wait for it to register.

  /**
   * Fills a custom ARIA dropdown by: opening it, reading its options,
   * sending them to the AI, and clicking the AI's chosen option.
   * @async
   * @param {HTMLElement} input        - The combobox trigger element.
   * @param {string}      questionText - The field's label, sent to the AI for context.
   * @returns {Promise<boolean>} true if successfully filled, false otherwise.
   */
  async function fillCustomDropdown(input, questionText) {

    // Step 1: Click to open the dropdown. Click the nearest react-select-style
    // "control" wrapper when there is one, not just the trigger input —
    // libraries built this way (Greenhouse's job-boards.greenhouse.io
    // application forms among them) wire their open/close toggle to the
    // wrapper's onMouseDown/onPointerDown, and the input itself is often too
    // small (sometimes visually near-invisible) for a synthetic click at its
    // own center to land on anything meaningful. clickElement() dispatches a
    // full pointer+mouse sequence, which covers pointer-event-only toggles
    // that a plain MouseEvent/`.click()` never reaches.
    input.focus();
    const openTarget = input.closest('[class*="__control"], [class*="-control"], [class*="select-shell"]') || input;
    clickElement(openTarget);
    await sleep(600);

    // Step 2: Read all visible option elements from the live DOM
    const optionEls = findVisibleOptions(input);
    if (optionEls.length === 0) {
      // Close the dropdown
      document.body.click();
      return false;
    }

    const optionTexts = optionEls.map(o => o.text);

    // Step 3: Ask AI to pick the best option
    let aiChoice;
    try {
      aiChoice = await sendMessage({
        type: 'MATCH_DROPDOWN',
        questionText: questionText,
        options: optionTexts,
        resumeId: _activeResumeId
      });
    } catch (e) {
      document.body.click();
      return false;
    }


    if (!aiChoice || aiChoice === 'SKIP' || aiChoice === 'NEEDS_USER_INPUT') {
      document.body.click();
      return false;
    }

    // Step 4: Find the option element that matches AI's choice and click it
    const choiceLower = aiChoice.toLowerCase().trim();
    const choiceNorm = choiceLower.replace(/[^a-z0-9]/g, '');

    // Exact text match
    for (const opt of optionEls) {
      if (opt.text.toLowerCase().trim() === choiceLower) {
        clickElement(opt.el);
        await sleep(200);
        return true;
      }
    }

    // Normalized match
    for (const opt of optionEls) {
      if (opt.text.toLowerCase().replace(/[^a-z0-9]/g, '') === choiceNorm) {
        clickElement(opt.el);
        await sleep(200);
        return true;
      }
    }

    // Partial/contains match
    for (const opt of optionEls) {
      const optLower = opt.text.toLowerCase().trim();
      if (optLower.includes(choiceLower) || choiceLower.includes(optLower)) {
        clickElement(opt.el);
        await sleep(200);
        return true;
      }
    }

    document.body.click();
    return false;
  }

  /**
   * Finds all visible option elements for an open custom dropdown.
   * Checks the aria-controls listbox, nearby parent containers, and
   * any floating listbox/option elements currently in the DOM.
   * @param {HTMLElement} triggerEl - The combobox trigger that was clicked to open the dropdown.
   * @returns {Array<{text: string, el: HTMLElement}>} List of option text+element pairs.
   */
  function findVisibleOptions(triggerEl) {
    const results = [];
    const seen = new Set();

    // Strategy 1: ARIA — find listbox via aria-controls/aria-owns
    const lbId = triggerEl.getAttribute('aria-controls') || triggerEl.getAttribute('aria-owns');
    if (lbId) {
      const lb = document.getElementById(lbId);
      if (lb) collectOptions(lb.querySelectorAll('[role="option"]'), results, seen);
    }

    // Strategy 2: Search nearby container
    const container = triggerEl.closest(
      '[class*="select"], [class*="dropdown"], [class*="field"], [class*="combobox"], [data-testid]'
    ) || triggerEl.parentElement?.parentElement;
    if (container) {
      collectOptions(container.querySelectorAll('[role="option"], [class*="option"]:not([class*="options"])'), results, seen);
    }

    // Strategy 3: Search entire document for visible options (dropdown might be portaled)
    if (results.length === 0) {
      const allOptions = document.querySelectorAll(
        '[role="option"], [role="listbox"] > *, .dropdown-option, [class*="menu-item"], [class*="listbox-option"]'
      );
      collectOptions(allOptions, results, seen);
    }

    return results;
  }

  /**
   * Collects visible, non-placeholder option elements from a node list.
   * Skips hidden elements (zero bounding rect) and placeholder text like "Select…".
   * @param {NodeList|Array} nodeList - DOM elements to scan.
   * @param {Array}          results  - Accumulator array of {text, el} objects.
   * @param {Set}            seen     - Set of already-collected text values (dedup).
   */
  function collectOptions(nodeList, results, seen) {
    for (const el of nodeList) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const text = el.textContent.trim();
      if (!text || seen.has(text)) continue;
      if (/^(select|choose|--|pick|search)/i.test(text)) continue;
      seen.add(text);
      results.push({ el, text });
    }
  }

  /**
   * Dispatches a realistic pointerdown → mousedown → pointerup → mouseup →
   * click sequence at the element's own center coordinates.
   *
   * A plain `MouseEvent('click')` (or even a real `.click()` call) isn't
   * enough for every custom dropdown: many React-based combobox libraries —
   * react-select among them, which is what Greenhouse's job-boards.greenhouse.io
   * application forms use for their dropdown fields — bind their open/select
   * handlers to `onPointerDown`/`onMouseDown` rather than `onClick`, so an
   * event sequence missing pointer events can silently do nothing. Real
   * clientX/clientY (rather than defaulting to 0,0) matters too, since some
   * libraries do their own hit-testing against the event's coordinates.
   *
   * Dispatches all five events via dispatchEvent rather than also calling
   * the native `.click()` method — calling both would fire any 'click'
   * listener twice for one logical click.
   * @param {HTMLElement} el - The element to click.
   */
  function clickElement(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
      el.dispatchEvent(new PointerEvent(type, { ...base, pointerId: 1, pointerType: 'mouse' }));
    });
  }

  /** Returns a Promise that resolves after `ms` milliseconds. Used for async waits during form fill. */
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Select: match AI's option text → actual option value, then select it ──

  /**
   * Selects the best matching option in a native <select> element.
   * Tries six strategies in order: exact map lookup, exact value match,
   * exact text match, normalised match (strip punctuation), partial/contains match,
   * and finally a word-overlap fuzzy score.
   * @param {HTMLSelectElement} select      - The native select element to fill.
   * @param {string}            aiText      - The option text chosen by the AI.
   * @param {Object}            optionMap   - Map of lowercase option text → option value.
   * @param {string[]}          optionTexts - Array of option text strings (for fallback).
   */
  function fillSelectByText(select, aiText, optionMap, optionTexts) {
    const text = String(aiText).trim();
    const textLower = text.toLowerCase();

    // 1. Exact text match → get the real value from our map
    if (optionMap && optionMap[textLower] !== undefined) {
      select.value = optionMap[textLower];
      fireEvents(select);
      return;
    }

    // 2. Try matching against actual <option> elements directly
    const realOptions = Array.from(select.options).filter(o =>
      o.value.trim() && o.value.trim() !== '-1' && o.textContent.trim()
    );

    // Exact value match (AI returned the value attribute)
    for (const opt of realOptions) {
      if (opt.value === text || opt.value.toLowerCase() === textLower) {
        select.value = opt.value;
        fireEvents(select);
        return;
      }
    }

    // 3. Normalized match — strip all non-alphanumeric chars
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const textNorm = norm(text);
    for (const opt of realOptions) {
      if (norm(opt.textContent) === textNorm) {
        select.value = opt.value;
        fireEvents(select);
        return;
      }
    }

    // 4. Partial / contains match on text
    for (const opt of realOptions) {
      const optText = opt.textContent.trim().toLowerCase();
      if (optText.includes(textLower) || textLower.includes(optText)) {
        select.value = opt.value;
        fireEvents(select);
        return;
      }
    }

    // 4. Best fuzzy match — word overlap + prefix scoring
    let bestOpt = null;
    let bestScore = 0;
    const words = textLower.split(/[\s,\/\-_]+/).filter(Boolean);
    for (const opt of realOptions) {
      const optText = opt.textContent.trim().toLowerCase();
      const optWords = optText.split(/[\s,\/\-_]+/).filter(Boolean);
      let score = 0;
      for (const w of words) {
        for (const ow of optWords) {
          if (w === ow) { score += 10; continue; }
          let p = 0;
          while (p < w.length && p < ow.length && w[p] === ow[p]) p++;
          if (p >= 2) score += p;
        }
      }
      if (score > bestScore) { bestScore = score; bestOpt = opt; }
    }
    if (bestOpt && bestScore >= 3) {
      select.value = bestOpt.value;
      fireEvents(select);
      return;
    }

  }

  // ── Radio: use stored refs directly ──

  /**
   * Selects a radio button from a group based on the AI's text answer.
   * Tries exact label match, then normalised match, then partial match.
   * @param {Array<{text: string, el: HTMLInputElement}>} radioRefs - Radio option refs.
   * @param {string} selectedText - The option text chosen by the AI.
   */
  function fillRadioFromRef(radioRefs, selectedText) {
    const target = selectedText.toLowerCase().trim();

    // Exact label match
    for (const r of radioRefs) {
      if (r.text.toLowerCase().trim() === target || r.el.value.toLowerCase().trim() === target) {
        r.el.checked = true;
        fireEvents(r.el);
        return true;
      }
    }
    // Partial match
    for (const r of radioRefs) {
      const label = r.text.toLowerCase().trim();
      const val = r.el.value.toLowerCase().trim();
      if (label.includes(target) || target.includes(label) ||
          val.includes(target) || target.includes(val)) {
        r.el.checked = true;
        fireEvents(r.el);
        return true;
      }
    }
    return false;
  }

  // ── Checkbox: use stored ref directly ──

  /**
   * Checks or unchecks a checkbox based on the AI's answer value.
   * Treats 'yes', 'true', '1', 'agree', 'accept' as truthy.
   * @param {HTMLInputElement} cb    - The checkbox element.
   * @param {string}           value - The AI's answer string.
   */
  function fillCheckboxFromRef(cb, value) {
    const shouldCheck = /^(yes|true|1|checked|agree|accept)$/i.test(String(value).trim());
    if (cb.checked !== shouldCheck) {
      cb.checked = shouldCheck;
      fireEvents(cb);
    }
  }

  // ── Shared event dispatcher ──

  /**
   * Fires input, change, and blur events on an element.
   * Required to notify React/Vue/Angular frameworks that the value was
   * changed programmatically — without these events, the framework's
   * internal state won't update and the value may be ignored on submit.
   * @param {HTMLElement} el - The form element that was just filled.
   */
  function fireEvents(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  /**
   * Sets a text input or textarea value in a React-compatible way.
   * React overrides the native value setter — if you set input.value directly,
   * React won't detect the change and the field will appear unchanged on submit.
   * Using Object.getOwnPropertyDescriptor to access the native setter bypasses
   * React's override and triggers its synthetic event system correctly.
   * @param {HTMLInputElement|HTMLTextAreaElement} input - The input to fill.
   * @param {string} value - The value to set.
   */
  function fillInput(input, value) {
    // React-compatible value setter
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;
    const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;

    const setter = input.tagName.toLowerCase() === 'textarea'
      ? nativeTextAreaValueSetter
      : nativeInputValueSetter;

    if (setter) {
      setter.call(input, value);
    } else {
      input.value = value;
    }

    // Dispatch events for frameworks
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }


  // ─── Cover letter ─────────────────────────────────────────────

  /**
   * Format a Date as "May 11, 2026" — used in the cover-letter file body.
   */
  function formatLongDate(d) {
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  /**
   * Join the user's present contact fields with " · " for the cover-letter
   * letterhead. Empty fields are skipped — the line is omitted entirely if
   * every field is empty.
   */
  function buildContactLine(profile) {
    if (!profile) return '';
    const fields = [profile.email, profile.phone, profile.linkedin, profile.location, profile.website];
    return fields.map(f => (f || '').trim()).filter(Boolean).join(' · ');
  }

  /**
   * Builds and downloads the cover letter as either .docx or .pdf.
   * Returns silently on success (browser download chrome appears).
   * On error, surfaces via setStatus().
   */
  async function downloadCoverLetter(format) {
    const text = (shadowRoot.getElementById('jmCoverLetterText')?.textContent || '').trim();
    if (!text)                  { setStatus('Cover letter is empty', 'error'); return; }
    if (!currentAnalysis)       { setStatus('Generate the cover letter first', 'error'); return; }

    const downloadBtn  = shadowRoot.getElementById('jmDownloadCoverLetter');
    const items        = shadowRoot.querySelectorAll('.jm-download-item');
    const originalLabel = downloadBtn ? downloadBtn.innerHTML : '';

    // Disable while building
    if (downloadBtn) { downloadBtn.disabled = true; downloadBtn.innerHTML = '<span class="jm-spinner"></span> Working...'; }
    items.forEach(i => { i.disabled = true; });

    try {
      const profile = await sendMessage({ type: 'GET_PROFILE', resumeId: _activeResumeId });
      const result  = await sendMessage({
        type:    'BUILD_COVER_LETTER_FILE',
        format,
        text,
        header:  {
          name:        (profile?.name || '').trim(),
          contactLine: buildContactLine(profile),
        },
        today:   formatLongDate(new Date()),
        jobMeta: {
          company: currentAnalysis.company || '',
          title:   currentAnalysis.title   || '',
        },
      });

      if (!result || !result.bytesBase64) {
        throw new Error('No bytes returned from background');
      }

      // chrome.runtime.sendMessage JSON-serializes the envelope, so the
      // background hands us bytes as a base64 string. Decode into a real
      // Uint8Array so the Blob contains binary, not "[object Object]".
      const binary = atob(result.bytesBase64);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const blob = new Blob([bytes], { type: result.mime });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke after a tick so the browser has time to start the download.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setStatus('Could not generate cover letter file: ' + (err?.message || err), 'error');
    } finally {
      if (downloadBtn) { downloadBtn.disabled = false; downloadBtn.innerHTML = originalLabel; }
      items.forEach(i => { i.disabled = false; });
      // Close menu after action (mirrors success and error paths).
      const menu = shadowRoot.getElementById('jmDownloadCoverLetterMenu');
      if (menu) { menu.hidden = true; downloadBtn?.setAttribute('aria-expanded', 'false'); }
    }
  }

  /**
   * Generates a tailored cover letter for the current job via the AI and
   * displays it in the Cover Letter section of the panel.
   * Requires a completed analysis (currentAnalysis must be non-null).
   * @async
   */
  async function generateCoverLetter() {
    const btn = shadowRoot.getElementById('jmCoverLetterBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="jm-spinner"></span> Writing...';
    try {
      if (!currentAnalysis) throw new Error('Analyze the job first.');
      const jd = await getJobDescriptionForAnalysis();
      // Re-scrape company fresh (cached value may be stale or wrong)
      const freshCompany = extractCompany() || currentAnalysis.company || '';
      const freshTitle = extractJobTitle() || currentAnalysis.title || '';
      const clResult = await sendMessage({
        type: 'GENERATE_COVER_LETTER',
        jobDescription: jd,
        resumeId: _activeResumeId,
        analysis: {
          matchingSkills: currentAnalysis.matchingSkills,
          matchScore: currentAnalysis.matchScore
        },
        jobMeta: {
          title: freshTitle,
          company: freshCompany,
          location: currentAnalysis.location || '',
          salary: currentAnalysis.salary || ''
        }
      });
      // Support both old string and new object response format
      const text = typeof clResult === 'string' ? clResult : clResult.text;
      const clTruncated = typeof clResult === 'object' && clResult.truncated;
      shadowRoot.getElementById('jmCoverLetterText').textContent = text;
      const section = shadowRoot.getElementById('jmCoverLetterSection');
      section.style.display = 'block';
      scrollPanelTo(section);
    } catch (err) {
      setStatus('Error: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '&#9993; Cover Letter';
    }
  }

  // ─── Bullet rewriter ──────────────────────────────────────────

  /**
   * Requests AI-rewritten resume bullets targeted at the current job's missing skills.
   * Shows the Improved Resume Bullets section immediately (before AI responds) so the
   * user can see a loading state, then populates it with before/after pairs.
   * Each bullet has a Copy button to copy the improved version to clipboard.
   * @async
   */
  async function rewriteBullets() {
    const btn = shadowRoot.getElementById('jmRewriteBulletsBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="jm-spinner"></span> Analyzing...';
    const section = shadowRoot.getElementById('jmBulletSection');
    const list = shadowRoot.getElementById('jmBulletList');
    list.innerHTML = '';
    section.style.display = 'block';
    try {
      if (!currentAnalysis) throw new Error('Analyze the job first.');
      const jd = await getJobDescriptionForAnalysis();
      const bullets = await sendMessage({
        type: 'REWRITE_BULLETS',
        jobDescription: jd,
        missingSkills: currentAnalysis.missingSkills || [],
        resumeId: _activeResumeId
      });

      if (!Array.isArray(bullets) || bullets.length === 0) {
        list.innerHTML = '<p style="font-size:12px;color:var(--jm-text-secondary);">No bullet improvements generated. Your resume experience section may be empty or the AI could not suggest improvements.</p>';
      } else {
        bullets.forEach(b => {
          const item = document.createElement('div');
          item.className = 'jm-bullet-item';
          // Build skill chips HTML from missing skills
          const missingSkills = currentAnalysis.missingSkills || [];
          const skillChipsHtml = missingSkills.map(s =>
            `<span class="jm-skill-chip" data-skill="${escapeHTML(s)}">${escapeHTML(s)}</span>`
          ).join('');

          item.innerHTML = `
            <div class="jm-bullet-header">
              <span class="jm-bullet-toggle-wrap" data-tip="Uncheck to exclude from tailored resume"><input type="checkbox" class="jm-bullet-toggle" checked></span>
              <div class="jm-bullet-job">${escapeHTML(b.job || '')}</div>
              <button class="jm-bullet-skills-btn" title="Manage missing skills for this bullet">Skills</button>
            </div>
            <div class="jm-bullet-skills-panel">
              <div class="jm-bullet-skills-label">Missing skills to include (click to exclude)</div>
              <div class="jm-bullet-skills-list">${skillChipsHtml}</div>
            </div>
            <div class="jm-bullet-before">${escapeHTML(b.original || '')}</div>
            <div class="jm-bullet-after" contenteditable="true" spellcheck="false" title="Click to edit — changes are used when regenerating or generating tailored resume">${escapeHTML(b.improved || '')}</div>
            <div class="jm-bullet-actions">
              <button class="jm-btn jm-btn-secondary jm-bullet-copy">Copy</button>
              <button class="jm-bullet-refresh" title="Regenerate this bullet">&#8635;</button>
            </div>`;
          // Include/exclude toggle
          item.querySelector('.jm-bullet-toggle').addEventListener('change', (e) => {
            item.classList.toggle('jm-excluded', !e.target.checked);
            e.target.closest('.jm-bullet-toggle-wrap').dataset.tip = e.target.checked
              ? 'Uncheck to exclude from tailored resume'
              : 'Check to include in tailored resume';
          });

          // Skills panel toggle
          item.querySelector('.jm-bullet-skills-btn').addEventListener('click', () => {
            const panel = item.querySelector('.jm-bullet-skills-panel');
            const btn = item.querySelector('.jm-bullet-skills-btn');
            panel.classList.toggle('jm-open');
            btn.classList.toggle('jm-active');
          });

          // Skill chip toggle (click to include/exclude)
          item.querySelectorAll('.jm-skill-chip').forEach(chip => {
            chip.addEventListener('click', () => {
              chip.classList.toggle('jm-excluded-skill');
            });
          });

          // Copy button
          item.querySelector('.jm-bullet-copy').addEventListener('click', () => {
            const currentText = item.querySelector('.jm-bullet-after').textContent;
            navigator.clipboard.writeText(currentText).then(() => {
              const cb = item.querySelector('.jm-bullet-copy');
              cb.textContent = 'Copied!';
              setTimeout(() => { cb.textContent = 'Copy'; }, 1500);
            }).catch(() => {});
          });

          // Regenerate — uses only the included skills for this bullet
          item.querySelector('.jm-bullet-refresh').addEventListener('click', async (e) => {
            const refreshBtn = e.currentTarget;
            refreshBtn.disabled = true;
            refreshBtn.classList.add('jm-spinning');
            try {
              const jd = await getJobDescriptionForAnalysis();
              const original = item.querySelector('.jm-bullet-before').textContent;
              const currentEdit = item.querySelector('.jm-bullet-after').textContent.trim();
              const bulletSkills = [];
              const excludedSkills = [];
              item.querySelectorAll('.jm-skill-chip').forEach(chip => {
                if (chip.classList.contains('jm-excluded-skill')) {
                  excludedSkills.push(chip.dataset.skill);
                } else {
                  bulletSkills.push(chip.dataset.skill);
                }
              });
              const newBullet = await sendMessage({
                type: 'REWRITE_SINGLE_BULLET',
                originalBullet: original,
                currentEdit: currentEdit !== original ? currentEdit : '',
                jobDescription: jd,
                missingSkills: bulletSkills,
                excludedSkills
              });
              item.querySelector('.jm-bullet-after').textContent = newBullet;
            } catch (err) {
              item.querySelector('.jm-bullet-after').textContent = 'Error: ' + err.message;
            } finally {
              refreshBtn.disabled = false;
              refreshBtn.classList.remove('jm-spinning');
            }
          });
          list.appendChild(item);
        });
        // Show add custom bullet area and bottom generate button
        shadowRoot.getElementById('jmAddBulletArea').style.display = 'block';
        shadowRoot.getElementById('jmTailoredResumeBtnBottom').style.display = 'flex';
      }
    } catch (err) {
      list.innerHTML = `<p style="font-size:12px;color:#dc2626;">Error: ${escapeHTML(err.message)}</p>`;
    } finally {
      scrollPanelTo(section);
      btn.disabled = false;
      btn.innerHTML = '&#9997; Improve Resume Bullets';
    }
  }

  // ─── Tailored resume generator ───────────────────────────────

  /**
   * Generates a tailored DOCX resume by sending rewritten bullets to the
   * background service worker, which edits the DOCX directly using JSZip.
   * Downloads the modified DOCX file.
   * @async
   */
  async function generateTailoredResume() {
    const btn = shadowRoot.getElementById('jmTailoredResumeBtn');
    const section = shadowRoot.getElementById('jmTailoredResumeSection');
    const status = shadowRoot.getElementById('jmTailoredResumeStatus');
    btn.disabled = true;
    btn.innerHTML = '<span class="jm-spinner"></span> Generating...';
    section.style.display = 'block';
    status.className = 'jm-resume-status-card';
    status.innerHTML = '';

    try {
      if (!currentAnalysis) throw new Error('Analyze the job first.');

      // Collect only CHECKED bullets from the UI (both rewritten and custom)
      const bulletItems = shadowRoot.querySelectorAll('.jm-bullet-item');
      const rewrittenBullets = [];
      const customBullets = [];
      bulletItems.forEach(item => {
        // Skip excluded bullets (unchecked checkbox adds jm-excluded class)
        if (item.classList.contains('jm-excluded')) return;
        const checkbox = item.querySelector('.jm-bullet-toggle');
        if (checkbox && !checkbox.checked) return;
        const improved = item.querySelector('.jm-bullet-after')?.textContent || '';
        if (!improved) return;

        if (item.classList.contains('jm-custom-bullet')) {
          // Custom bullet — needs to be inserted, not replaced
          customBullets.push({
            text: improved,
            targetSection: item.dataset.targetSection || '',
            targetIdx: parseInt(item.dataset.targetIdx || '0', 10),
          });
        } else {
          // Rewritten bullet — replaces existing text
          const original = item.querySelector('.jm-bullet-before')?.textContent || '';
          if (original && original !== improved) {
            rewrittenBullets.push({ original, improved });
          }
        }
      });

      if (rewrittenBullets.length === 0 && customBullets.length === 0) {
        throw new Error('No bullets selected. Click "Improve Resume Bullets" first and check the ones you want to include.');
      }

      status.className = 'jm-resume-status-card';
      status.innerHTML = '<span style="color:var(--jm-text-secondary);font-size:12px;">Editing your resume...</span>';

      // Send to background for DOCX editing
      const result = await sendMessage({
        type: 'GENERATE_TAILORED_RESUME',
        rewrittenBullets,
        customBullets,
        missingSkills: currentAnalysis.missingSkills || [],
        resumeId: _activeResumeId
      });

      // Build filename: {originalName}_{company or autoId}.docx
      const company = (currentAnalysis.company || '').replace(/[^a-zA-Z0-9 ]/g, '').trim().replace(/\s+/g, '_');
      const baseName = (result.originalFileName || 'resume').replace(/\.docx$/i, '');
      let downloadName;
      if (company) {
        downloadName = `${baseName}_${company}.docx`;
      } else {
        const counter = await sendMessage({ type: 'INCREMENT_RESUME_COUNTER' });
        downloadName = `${baseName}_${counter}.docx`;
      }

      // Convert base64 to blob and trigger download
      const binaryString = atob(result.base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes.buffer], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = downloadName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      const totalSelected = rewrittenBullets.length + customBullets.length;
      const totalAll = shadowRoot.querySelectorAll('.jm-bullet-item').length;
      const skipped = totalAll > totalSelected ? totalAll - totalSelected : 0;

      status.className = 'jm-resume-status-card success';
      status.style.color = '';

      let html = `
        <div class="jm-resume-stat-row">
          <span style="font-size:16px;">&#10003;</span>
          <span><strong>Resume downloaded</strong> as <strong>${escapeHTML(downloadName)}</strong></span>
        </div>
        <div class="jm-resume-stat-row" style="color:var(--jm-text-secondary);font-size:12px;">
          <span>Replaced <strong>${result.replacedCount}</strong> of <strong>${result.totalBullets}</strong> bullets</span>
          ${result.insertedCount > 0 ? `<span>&middot; Inserted <strong>${result.insertedCount}</strong> new</span>` : ''}
          ${skipped > 0 ? `<span>&middot; <strong>${skipped}</strong> excluded</span>` : ''}
        </div>`;

      if (result.replacedCount < result.totalBullets) {
        html += `<div style="font-size:11px;color:var(--jm-text-secondary);margin-top:4px;">${result.totalBullets - result.replacedCount} bullet(s) could not be matched — the text may be split differently in the DOCX.</div>`;
      }

      html += `<div class="jm-resume-warn">&#9888; Review the downloaded resume for accuracy before submitting.</div>`;
      status.innerHTML = html;
    } catch (err) {
      status.className = 'jm-resume-status-card error';
      status.style.color = '';
      if (err.message === 'DOCX_REQUIRED' || err.message.includes('DOCX_REQUIRED')) {
        status.innerHTML = `<div class="jm-resume-stat-row"><span style="font-size:16px;">&#9888;</span><span>DOCX required — please upload your resume as <strong>.docx</strong> in <strong>Profile</strong>.</span></div>`;
      } else {
        status.innerHTML = `<div class="jm-resume-stat-row"><span style="font-size:16px;">&#9888;</span><span style="color:#dc2626;">${escapeHTML(err.message)}</span></div>`;
      }
    } finally {
      scrollPanelTo(section);
      btn.disabled = false;
      btn.innerHTML = '&#128196; Generate Tailored Resume';
    }
  }

  // ─── Custom bullet generator ─────────────────────────────────

  /**
   * Populates the "Add under" dropdown with jobs and projects from the user's profile.
   */
  async function populateAddBulletDropdown() {
    const select = shadowRoot.getElementById('jmAddBulletTarget');
    select.innerHTML = '';
    try {
      const profile = await sendMessage({ type: 'GET_PROFILE', resumeId: _activeResumeId });
      if (profile?.experience) {
        profile.experience.forEach((exp, i) => {
          const opt = document.createElement('option');
          opt.value = `exp_${i}`;
          opt.textContent = `${exp.title || 'Role'} at ${exp.company || 'Company'}`;
          opt.dataset.section = 'experience';
          opt.dataset.idx = String(i);
          select.appendChild(opt);
        });
      }
      if (profile?.projects) {
        profile.projects.forEach((proj, i) => {
          const opt = document.createElement('option');
          opt.value = `proj_${i}`;
          opt.textContent = `Project: ${proj.name || proj.title || 'Untitled'}`;
          opt.dataset.section = 'projects';
          opt.dataset.idx = String(i);
          select.appendChild(opt);
        });
      }
    } catch (_) {
      const opt = document.createElement('option');
      opt.textContent = 'Could not load profile';
      select.appendChild(opt);
    }
  }

  /**
   * Generates a polished bullet from the user's rough description using AI,
   * then adds it to the bullet list as a custom bullet tagged with the selected job/project.
   */
  async function generateCustomBullet() {
    const input = shadowRoot.getElementById('jmAddBulletInput');
    const select = shadowRoot.getElementById('jmAddBulletTarget');
    const genBtn = shadowRoot.getElementById('jmAddBulletGenerate');
    const description = input.value.trim();

    if (!description) return;

    genBtn.disabled = true;
    genBtn.textContent = 'Generating...';

    try {
      const jd = await getJobDescriptionForAnalysis();
      const selectedOption = select.options[select.selectedIndex];
      const targetLabel = selectedOption?.textContent || 'Unknown';

      const polishedBullet = await sendMessage({
        type: 'GENERATE_CUSTOM_BULLET',
        description,
        targetRole: targetLabel,
        jobDescription: jd,
        missingSkills: currentAnalysis?.missingSkills || []
      });

      // Create a new bullet item in the list
      const list = shadowRoot.getElementById('jmBulletList');
      const item = document.createElement('div');
      item.className = 'jm-bullet-item jm-custom-bullet';
      // Store the target info for DOCX insertion
      item.dataset.customTarget = selectedOption?.value || '';
      item.dataset.targetSection = selectedOption?.dataset.section || '';
      item.dataset.targetIdx = selectedOption?.dataset.idx || '';

      const missingSkills = currentAnalysis?.missingSkills || [];
      const skillChipsHtml = missingSkills.map(s =>
        `<span class="jm-skill-chip" data-skill="${escapeHTML(s)}">${escapeHTML(s)}</span>`
      ).join('');

      item.innerHTML = `
        <div class="jm-bullet-header">
          <span class="jm-bullet-toggle-wrap" data-tip="Uncheck to exclude from tailored resume"><input type="checkbox" class="jm-bullet-toggle" checked></span>
          <div class="jm-bullet-job">${escapeHTML(targetLabel)}</div>
          <span class="jm-bullet-custom-tag">New</span>
          <button class="jm-bullet-skills-btn" title="Manage missing skills for this bullet">Skills</button>
        </div>
        <div class="jm-bullet-skills-panel">
          <div class="jm-bullet-skills-label">Missing skills to include (click to exclude)</div>
          <div class="jm-bullet-skills-list">${skillChipsHtml}</div>
        </div>
        <div class="jm-bullet-before" style="text-decoration:none;color:var(--jm-text-muted);font-style:italic;">${escapeHTML(description)}</div>
        <div class="jm-bullet-after" contenteditable="true" spellcheck="false" title="Click to edit">${escapeHTML(polishedBullet)}</div>
        <div class="jm-bullet-actions">
          <button class="jm-btn jm-btn-secondary jm-bullet-copy">Copy</button>
          <button class="jm-bullet-refresh" title="Regenerate this bullet">&#8635;</button>
        </div>`;

      // Wire events (same as regular bullets)
      item.querySelector('.jm-bullet-toggle').addEventListener('change', (e) => {
        item.classList.toggle('jm-excluded', !e.target.checked);
        e.target.closest('.jm-bullet-toggle-wrap').dataset.tip = e.target.checked
          ? 'Uncheck to exclude from tailored resume'
          : 'Check to include in tailored resume';
      });
      item.querySelector('.jm-bullet-skills-btn').addEventListener('click', () => {
        item.querySelector('.jm-bullet-skills-panel').classList.toggle('jm-open');
        item.querySelector('.jm-bullet-skills-btn').classList.toggle('jm-active');
      });
      item.querySelectorAll('.jm-skill-chip').forEach(chip => {
        chip.addEventListener('click', () => chip.classList.toggle('jm-excluded-skill'));
      });
      item.querySelector('.jm-bullet-copy').addEventListener('click', () => {
        navigator.clipboard.writeText(item.querySelector('.jm-bullet-after').textContent).then(() => {
          const cb = item.querySelector('.jm-bullet-copy');
          cb.textContent = 'Copied!';
          setTimeout(() => { cb.textContent = 'Copy'; }, 1500);
        }).catch(() => {});
      });
      item.querySelector('.jm-bullet-refresh').addEventListener('click', async (e) => {
        const refreshBtn = e.currentTarget;
        refreshBtn.disabled = true;
        refreshBtn.classList.add('jm-spinning');
        try {
          const bulletSkills = [];
          const excludedSkills = [];
          item.querySelectorAll('.jm-skill-chip').forEach(chip => {
            if (chip.classList.contains('jm-excluded-skill')) {
              excludedSkills.push(chip.dataset.skill);
            } else {
              bulletSkills.push(chip.dataset.skill);
            }
          });
          const newBullet = await sendMessage({
            type: 'GENERATE_CUSTOM_BULLET',
            description,
            targetRole: targetLabel,
            jobDescription: await getJobDescriptionForAnalysis(),
            missingSkills: bulletSkills,
            excludedSkills
          });
          item.querySelector('.jm-bullet-after').textContent = newBullet;
        } catch (err) {
          item.querySelector('.jm-bullet-after').textContent = 'Error: ' + err.message;
        } finally {
          refreshBtn.disabled = false;
          refreshBtn.classList.remove('jm-spinning');
        }
      });

      list.appendChild(item);

      // Reset the form
      input.value = '';
      shadowRoot.getElementById('jmAddBulletForm').classList.remove('jm-open');
      shadowRoot.getElementById('jmAddBulletArea').classList.remove('jm-open');
      shadowRoot.getElementById('jmAddBulletTrigger').style.display = '';
    } catch (err) {
      input.value += '\n\nError: ' + err.message;
    } finally {
      genBtn.disabled = false;
      genBtn.textContent = 'Generate';
    }
  }

  // ─── Job notes ────────────────────────────────────────────────
  // Per-URL free-text notes stored in chrome.storage.local under 'jm_jobNotes'.
  // Notes are loaded when the panel opens and auto-saved on input/blur.

  const NOTES_STORAGE_KEY = 'jm_jobNotes'; // Key for the notes map in chrome.storage.local

  /**
   * Loads saved notes for the current page URL and populates the notes textarea.
   * @async
   */
  async function loadJobNotes() {
    try {
      const url = normalizeUrl(window.location.href);
      const result = await chrome.storage.local.get(NOTES_STORAGE_KEY);
      const notes = result[NOTES_STORAGE_KEY] || {};
      const textarea = shadowRoot && shadowRoot.getElementById('jmNotesInput');
      // Try the normalized key first, then fall back to raw URL for any
      // notes saved by the pre-I2 code path so the user doesn't lose them.
      const value = notes[url] || notes[window.location.href] || '';
      if (textarea) textarea.value = value;
    } catch (e) { /* ignore */ }
  }

  /**
   * Saves the current notes textarea value for the current page URL.
   * Called on textarea blur and input events (auto-save).
   * Caps the notes map at 200 entries by evicting the oldest.
   * @async
   */
  async function saveJobNotes() {
    try {
      const url = normalizeUrl(window.location.href);
      const textarea = shadowRoot && shadowRoot.getElementById('jmNotesInput');
      if (!textarea) return;
      const result = await chrome.storage.local.get(NOTES_STORAGE_KEY);
      const notes = result[NOTES_STORAGE_KEY] || {};
      const val = textarea.value.trim();
      if (val) {
        notes[url] = val;
      } else {
        delete notes[url];
      }
      // Drop any duplicate entry under the unnormalized URL left by older
      // versions of this function so we don't show stale notes elsewhere.
      if (url !== window.location.href) delete notes[window.location.href];
      // Prune to 200 entries
      const keys = Object.keys(notes);
      if (keys.length > 200) keys.slice(0, keys.length - 200).forEach(k => delete notes[k]);
      await chrome.storage.local.set({ [NOTES_STORAGE_KEY]: notes });
    } catch (e) { /* ignore */ }
  }

  // ─── Message handling ─────────────────────────────────────────

  /**
   * Sends a message to the background service worker and returns a Promise.
   * Wraps chrome.runtime.sendMessage to:
   *  - Check chrome.runtime.id before sending (detects invalidated extension context)
   *  - Translate the { success, data/error } envelope into resolve/reject
   *  - Provide a user-friendly error when the extension has been updated mid-session
   * @param {Object} msg - The message object to send (must have a `type` field).
   * @returns {Promise<*>} Resolves with resp.data on success, rejects with Error on failure.
   */
  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      try {
        if (!chrome.runtime?.id) {
          return reject(new Error('Extension was updated. Please refresh this page (F5) and try again.'));
        }
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) {
            const errMsg = chrome.runtime.lastError.message || '';
            if (errMsg.includes('invalidated') || errMsg.includes('Extension context')) {
              return reject(new Error('Extension was updated. Please refresh this page (F5) and try again.'));
            }
            return reject(new Error(errMsg));
          }
          if (!resp) return reject(new Error('No response'));
          if (!resp.success) return reject(new Error(resp.error));
          resolve(resp.data);
        });
      } catch (e) {
        reject(new Error('Extension was updated. Please refresh this page (F5) and try again.'));
      }
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'TOGGLE_PANEL':
        togglePanel();
        sendResponse({ success: true });
        break;
      case 'TRIGGER_ANALYZE':
        if (!panelOpen) togglePanel();
        setTimeout(analyzeJob, 300);
        sendResponse({ success: true });
        break;
      case 'TRIGGER_AUTOFILL':
        if (!panelOpen) togglePanel();
        setTimeout(autofillForm, 300);
        sendResponse({ success: true });
        break;
      case 'SPA_URL_CHANGED':
        // Background webNavigation listener tells us the URL changed via
        // history.pushState (replaces the old MutationObserver).
        handleSpaUrlChanged();
        sendResponse({ success: true });
        break;
    }
    return true;
  });

  // ─── Utility ──────────────────────────────────────────────────

  /**
   * Escapes a string for safe insertion into HTML via innerHTML.
   * Uses the browser's own text node serialisation so all special characters
   * (&, <, >, ", ') are correctly escaped without a manual replacement table.
   * @param {string} str - The raw string to escape.
   * @returns {string} HTML-safe string.
   */
  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── Initialize ───────────────────────────────────────────────
  // Build the panel and toggle button immediately on script inject.
  // The panel starts hidden (no .open class); it is shown on first togglePanel() call.
  // Only create the panel and toggle button in the top frame — not in iframes.
  // In iframes, we only listen for autofill messages from the parent.
  //
  // `window === window.top` alone is not enough: sandboxed iframes (e.g.
  // reCAPTCHA's badge iframe at ~256×60) have `window.top` aliased to
  // themselves, so the equality check returns true and we'd inject a full
  // panel into a tiny third-party iframe. We saw this on Greenhouse job
  // pages — the panel header rendered inside the reCAPTCHA badge box.
  // Defense in depth: also check that we have a real viewport.
  function isRealTopFrame() {
    try { if (window !== window.top) return false; } catch (_) { return false; }
    try { if (window !== window.parent) return false; } catch (_) { return false; }
    try { if (window.frameElement) return false; } catch (_) { /* cross-origin → fall through */ }
    if (window.innerWidth < 500 || window.innerHeight < 400) return false;
    return true;
  }

  if (isRealTopFrame()) {
    try {
      createPanel();
      createToggleButton();
    } catch (e) {
      // Only surface errors — successful init stays silent. The thrown
      // error gives us a console breadcrumb if the panel ever fails to
      // appear on a page in the wild.
      console.error('[JobMatch AI] init error:', e && (e.stack || e.message || e));
    }
    // Note: a previous version of this code had a MutationObserver +
    // setInterval that aggressively re-appended our hosts whenever a page
    // detached them. On heavily-React-driven sites (Greenhouse job boards
    // are the worst case) the page's reconciler kept removing our nodes
    // and we kept re-attaching them, generating tens of thousands of
    // mutation events and breaking the page. Removed. If a page strips
    // our hosts, the toolbar icon still opens the panel — we don't need
    // to fight the page to keep a floating button alive.
  } else {
    // Running inside an iframe — listen for autofill requests from the parent
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'AUTOFILL_IN_FRAME') {
        (async () => {
          try {
            let totalFilled = 0;

            // Make sure the active resume is the best local ATS match
            // before reading it below (same as the top-frame flow).
            try { await ensureBestResumeSelected(); } catch (_) {}

            // ── PASS 0: Attach resume file to any resume-upload field in
            // this frame (no AI) — detectFormFields() populates
            // _resumeFileFields as a side effect; Pass 2 below calls it
            // again for the text/dropdown/radio/checkbox questions.
            try {
              detectFormFields();
              const resumeResult = await attachResumeFile();
              totalFilled += resumeResult.attached;
              if (resumeResult.attached > 0) {
                console.log(`[JobMatch AI] iframe Pass 0 (resume file): attached ${resumeResult.fileName}`);
              }
            } catch (_) {}

            // ── PASS 1: Direct fill from Q&A (no AI, instant, accurate) ──
            let qaList = [], profile = {};
            try {
              qaList = await sendMessage({ type: 'GET_QA_LIST' }) || [];
              profile = await sendMessage({ type: 'GET_PROFILE', resumeId: _activeResumeId }) || {};
            } catch (_) {}

            if (window.__jobMatchDirectFill) {
              const directResult = await window.__jobMatchDirectFill(qaList, profile);
              totalFilled += directResult.filled;
              console.log(`[JobMatch AI] iframe Pass 1 (direct): filled ${directResult.filled} fields`);
            }

            // ── PASS 2: AI fill for remaining fields ──
            // Get labels that Direct Fill already handled
            const filledLabels = new Set();
            if (window.__jobMatchFilledLabels) {
              window.__jobMatchFilledLabels.forEach(l => filledLabels.add(l.toLowerCase()));
            }

            _fieldMap = {};
            const questions = detectFormFields();
            // Filter out fields that were already filled in Pass 1
            const emptyQuestions = questions.filter(q => {
              // Skip if this field's label was handled by direct fill
              const qText = (q.question_text || '').toLowerCase();
              if (qText && filledLabels.has(qText)) return false;
              // Also check partial label match
              for (const filled of filledLabels) {
                if (filled.length > 5 && (qText.includes(filled) || filled.includes(qText))) return false;
              }
              // Check if element already has a value
              const el = q._el;
              if (!el) return true;
              const val = el.value || '';
              return !val || val.trim().length === 0;
            });

            console.log(`[JobMatch AI] iframe Pass 2 (AI): ${emptyQuestions.length} of ${questions.length} fields need AI (${filledLabels.size} labels filled by Pass 1)`);

            if (emptyQuestions.length > 0) {
              const questionsForAI = emptyQuestions.map(q => {
                const clean = { ...q };
                delete clean._el;
                delete clean._radios;
                return clean;
              });

              const BATCH_SIZE = 6;
              for (let i = 0; i < questionsForAI.length; i += BATCH_SIZE) {
                const batch = questionsForAI.slice(i, i + BATCH_SIZE);
                const batchNum = Math.floor(i / BATCH_SIZE) + 1;
                console.log(`[JobMatch AI] iframe AI batch ${batchNum} (${batch.length} fields)`);
                try {
                  const response = await sendMessage({ type: 'GENERATE_AUTOFILL', formFields: batch, resumeId: _activeResumeId });
                  const answers = Array.isArray(response) ? response : (response.answers || []);
                  const { filled } = await fillFormFromAnswers(answers);
                  totalFilled += filled;
                } catch (batchErr) {
                  console.warn(`[JobMatch AI] iframe AI batch ${batchNum} failed: ${batchErr.message}. Retrying per field...`);
                  for (const field of batch) {
                    try {
                      const resp = await sendMessage({ type: 'GENERATE_AUTOFILL', formFields: [field], resumeId: _activeResumeId });
                      const ans = Array.isArray(resp) ? resp : (resp.answers || []);
                      const { filled } = await fillFormFromAnswers(ans);
                      totalFilled += filled;
                    } catch (_) {}
                  }
                }
              }
            }

            sendResponse({ filled: totalFilled });
          } catch (err) {
            console.error('[JobMatch AI] iframe autofill error:', err);
            sendResponse({ filled: 0, error: err.message });
          }
        })();
        return true; // keep channel open for async response
      }
    });
  }

  // ─── SPA URL change detection (LinkedIn, Indeed, etc.) ────────
  // The background service worker uses chrome.webNavigation.onHistoryStateUpdated
  // and forwards a SPA_URL_CHANGED message to this frame whenever the URL
  // changes via pushState/replaceState/popstate. That replaces a heavy
  // MutationObserver(subtree:true on document.body) that used to run on every
  // page in every iframe (C6 in the audit).

  let _lastUrl = normalizeUrl(window.location.href);

  function handleSpaUrlChanged() {
    const currentUrl = normalizeUrl(window.location.href);
    if (currentUrl === _lastUrl) return;
    _lastUrl = currentUrl;
    // Bump the analyze generation so any in-flight analyzeJob() against
    // the previous URL becomes stale and bails before touching the UI (I3).
    _analyzeGen++;
    currentAnalysis = null;
    _fieldMap = {};
    clearAutofillBadges();
    // A new posting — any manual resume pick was for the PREVIOUS job, so
    // let auto-select freshly re-evaluate which resume fits this one best.
    _manualResumeSelection = false;
    if (shadowRoot && panelOpen) {
      const analyzeBtn = shadowRoot.getElementById('jmAnalyze');
      if (analyzeBtn && analyzeBtn.textContent === 'Re-Analyze') analyzeBtn.textContent = 'Analyze Job';
      const autofillBtn = shadowRoot.getElementById('jmAutofill');
      if (autofillBtn) { autofillBtn.innerHTML = 'AutoFill Application'; autofillBtn.onclick = null; }
      [
        'jmScoreSection', 'jmMatchingSection', 'jmMissingSection', 'jmRecsSection',
        'jmInsightsSection', 'jmKeywordsSection', 'jmTruncNotice',
        'jmAutofillWarning', 'jmCoverLetterSection', 'jmBulletSection',
        'jmJobInfo', 'jmSaveJob', 'jmMarkApplied', 'jmCoverLetterBtn', 'jmRewriteBulletsBtn'
      ].forEach(id => {
        const el = shadowRoot.getElementById(id);
        if (el) el.style.display = 'none';
      });
      loadJobNotes();
      loadResumeState();
      previewJobMeta();
      scanResumeMatch(); // re-scan the new job's JD for resume match
      // Re-check Applied/Saved status for the NEW job immediately, rather
      // than leaving the buttons' stale text/class from the previous job
      // sitting there (merely hidden) until the panel is next toggled.
      checkIfApplied();
      checkIfSaved();
      setStatus('New job detected — click Analyze Job.', 'info');
      setTimeout(clearStatus, 3000);
    }
  }

  checkIfApplied();

})();
