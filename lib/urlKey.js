/**
 * URL normalization for cache keys.
 *
 * Two visits to the same job posting from different sources should hit the
 * same cache entry. UTM params, click IDs, and analytics noise must not
 * defeat the cache or duplicate applied-jobs entries (I2 in the audit).
 *
 * Loaded as a content script before content.js — it hangs the API on
 * globalThis so other content scripts in the same isolated world can use it,
 * and tests can `import './lib/urlKey.js'` and read globalThis.JMUrlKey.
 */
(function () {
  'use strict';

  // Query params known to be tracking/referral noise rather than anything
  // that identifies WHICH job a URL points to. Everything else is KEPT by
  // default — see normalizeUrlForCache's own doc comment for why this is
  // a blocklist, not an allowlist of known job-id params.
  const TRACKING_PARAMS = new Set([
    'gclid', 'fbclid', 'msclkid', 'dclid', 'twclid', 'igshid',
    'mc_cid', 'mc_eid', '_ga', '_gl',
    'ref', 'referrer', 'referer', 'source', 'src', 'from', 'utm',
    'jr_id', // catsone.com — confirmed a per-visit referral id, not a job id (that platform's job id lives in the path)
  ]);

  function isTrackingParam(key) {
    const k = key.toLowerCase();
    return TRACKING_PARAMS.has(k) || k.startsWith('utm_');
  }

  /**
   * Normalize a URL into a stable cache key.
   *
   * - Drops URL fragment (#…)
   * - Lowercases scheme + host
   * - Strips trailing slash from path (except root)
   * - Drops known tracking/referral query params (see TRACKING_PARAMS);
   *   keeps everything else, since any surviving param could be the
   *   thing that actually distinguishes one job posting from another on
   *   a platform we haven't specifically seen before — see the real bug
   *   this fixed, described below.
   * - Sorts surviving params alphabetically for stability
   *
   * Real bug this fixes: an earlier version of this function used an
   * ALLOWLIST of known job-id query params (Greenhouse's gh_jid, Indeed's
   * vjk, LinkedIn's currentJobId, etc.) and dropped every other query
   * param. For any platform not on that list whose job id lives ONLY in
   * an unlisted query param — with an otherwise generic/shared path —
   * two genuinely DIFFERENT job postings would normalize to the identical
   * key, so the second one silently showed as "Applied" the moment its
   * page loaded, despite the user never having applied to it. Flipping to
   * a blocklist of known tracking/referral noise fixes that for any
   * current or future platform without having to keep discovering and
   * special-casing each one's param name — the asymmetric risk (an
   * unrecognized tracking param surviving, at worst causing an
   * already-applied job to not show as applied) is far less harmful than
   * the original failure mode (a real job wrongly hidden behind someone
   * else's "Applied" status).
   *
   * If the input is not a parseable URL, returns it unchanged so callers can
   * still use it as a key (defensive — never throws).
   *
   * @param {string} rawUrl
   * @returns {string} a normalized URL safe to use as a cache/dedupe key
   */
  function normalizeUrlForCache(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
    let u;
    try { u = new URL(rawUrl); } catch (_) { return rawUrl; }

    // Lowercase scheme + host (path is case-sensitive on most servers)
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();

    // Drop fragment
    u.hash = '';

    // Filter query params: drop known tracking noise, keep everything else.
    const keepParams = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (!isTrackingParam(k)) keepParams.push([k, v]);
    }
    keepParams.sort(([a], [b]) => a.localeCompare(b));
    u.search = '';
    for (const [k, v] of keepParams) u.searchParams.append(k, v);

    // Drop trailing slash from path (except for the root "/")
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }

    // Some ATS platforms split one posting into two pages that share a
    // single job id — an overview/JD page and a separate "/application" or
    // "/apply" step for the actual form — reached via two separate
    // tabs/links, or (on React-Router-style SPA career sites, confirmed on
    // a CATS/catsone.com site) a client-side route change. Without this,
    // the two pages normalize to different cache keys and get treated as
    // different jobs (re-analyzed, and separately logged as applied).
    // Stripping the suffix collapses both to the same key. Not scoped to
    // one hostname — confirmed independently on jobs.ashbyhq.com
    // (.../application) and catsone.com career sites (.../apply), so this
    // convention isn't specific to either platform.
    for (const suffix of ['/application', '/apply']) {
      if (u.pathname.endsWith(suffix)) {
        u.pathname = u.pathname.slice(0, -suffix.length) || '/';
        break;
      }
    }

    return u.toString();
  }

  const api = { normalizeUrlForCache };

  // CommonJS / vitest
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  // Content script / browser
  if (typeof globalThis !== 'undefined') {
    globalThis.JMUrlKey = api;
  }
})();
