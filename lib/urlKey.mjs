/**
 * ES-module version of normalizeUrlForCache for the MV3 service worker
 * (background.js loads as a module). The classic-script copy at
 * lib/urlKey.js is the same logic for content scripts.
 *
 * If you change one, change the other — the parity test at
 * tests/unit/urlKey-parity.test.js verifies they produce identical output.
 */

// Query params known to be tracking/referral noise rather than anything
// that identifies WHICH job a URL points to. Everything else is KEPT by
// default — see the doc comment above normalizeUrlForCache for why this
// is a blocklist, not an allowlist of known job-id params.
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
 * Normalizes a URL into a stable cache/dedupe key for "is this the same
 * job posting" comparisons (used by the applied-jobs and saved-jobs
 * lookups).
 *
 * Real bug this fixes: an earlier version of this function used an
 * ALLOWLIST of known job-id query params (Greenhouse's gh_jid, Indeed's
 * vjk, LinkedIn's currentJobId, etc.) and dropped every other query
 * param. For any platform not on that list whose job id lives ONLY in an
 * unlisted query param — with an otherwise generic/shared path — two
 * genuinely DIFFERENT job postings would normalize to the identical key,
 * so the second one silently showed as "Applied" the moment its page
 * loaded, despite the user never having applied to it. Flipping to a
 * blocklist of known tracking/referral noise and keeping everything else
 * by default fixes that for any current or future platform without
 * having to keep discovering and special-casing each one's param name —
 * the asymmetric risk (an unrecognized *tracking* param surviving, at
 * worst causing an already-applied job to not show as applied) is far
 * less harmful than the original failure mode (a real job wrongly hidden
 * behind someone else's "Applied" status).
 */
export function normalizeUrlForCache(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  let u;
  try { u = new URL(rawUrl); } catch (_) { return rawUrl; }

  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  u.hash = '';

  const keepParams = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (!isTrackingParam(k)) keepParams.push([k, v]);
  }
  keepParams.sort(([a], [b]) => a.localeCompare(b));
  u.search = '';
  for (const [k, v] of keepParams) u.searchParams.append(k, v);

  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }

  // Some ATS platforms split one posting into two pages that share a
  // single job id — an overview/JD page and a separate "/application" or
  // "/apply" step for the actual form. Strip the suffix so both collapse
  // to the same cache/dedupe key. Not scoped to one hostname — confirmed
  // independently on jobs.ashbyhq.com (.../application) and catsone.com
  // career sites (.../apply). See lib/urlKey.js for the full rationale.
  for (const suffix of ['/application', '/apply']) {
    if (u.pathname.endsWith(suffix)) {
      u.pathname = u.pathname.slice(0, -suffix.length) || '/';
      break;
    }
  }

  return u.toString();
}
