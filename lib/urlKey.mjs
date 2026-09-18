/**
 * ES-module version of normalizeUrlForCache for the MV3 service worker
 * (background.js loads as a module). The classic-script copy at
 * lib/urlKey.js is the same logic for content scripts.
 *
 * If you change one, change the other — the parity test at
 * tests/unit/urlKey-parity.test.js verifies they produce identical output.
 */

const JOB_ID_PARAMS = new Set([
  'gh_jid',         // Greenhouse
  'jobId',          // Workday, generic
  'jobid',          // case variant
  'currentJobId',   // LinkedIn /jobs/search variant
  'jl',             // Glassdoor job listing
  'vjk',            // Indeed view-job-key
  'jk',             // Indeed alternate
]);

export function normalizeUrlForCache(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  let u;
  try { u = new URL(rawUrl); } catch (_) { return rawUrl; }

  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  u.hash = '';

  const keepParams = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (JOB_ID_PARAMS.has(k)) keepParams.push([k, v]);
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
