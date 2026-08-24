/**
 * ES-module mirror of lib/resumeKeywords.js. The classic-script copy is for
 * content scripts and profile.html; this copy is for tests. A parity test
 * asserts both produce the same output for the same inputs — change one,
 * change both.
 */

/**
 * Extracts every ATS keyword from a resume profile, deduplicated with an
 * occurrence count.
 *
 * @param {{skills?: string[], certifications?: string[], projects?: Array<{technologies?: string[]}>}} [profile]
 * @returns {Array<{term: string, count: number}>} Sorted by count desc, then term A→Z.
 */
export function extractAtsKeywords(profile) {
  const keywordCounts = {};
  const addAll = (arr) => (arr || []).forEach(k => {
    const term = String(k || '').trim();
    if (!term) return;
    keywordCounts[term] = (keywordCounts[term] || 0) + 1;
  });
  addAll(profile && profile.skills);
  addAll(profile && profile.certifications);
  ((profile && profile.projects) || []).forEach(p => addAll(p && p.technologies));

  return Object.entries(keywordCounts)
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
}
