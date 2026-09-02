/**
 * ES-module mirror of lib/resumeKeywords.js. The classic-script copy is for
 * content scripts and profile.html; this copy is for tests. A parity test
 * asserts both produce the same output for the same inputs — change one,
 * change both.
 *
 * Vocabulary (which terms exist at all) comes only from the structured
 * fields (skills/certifications/projects[].technologies). Free-text prose —
 * profile.summary and each profile.experience[].description bullet — is
 * then scanned for additional whole-word mentions of those same terms,
 * adding to their occurrence count. This never introduces a new term on its
 * own; it only makes an already-known term's count reflect how often it
 * actually shows up in the resume's narrative, not just whether it's listed
 * once. A mention in an experience bullet is weighted by how recent that
 * role is (see RECENCY_WEIGHT_DECAY_PER_ROLE) — a skill demonstrated in
 * your current job counts for more than the same skill mentioned in a role
 * from a decade ago, though an old role's mentions are never fully
 * discounted. Because of this, `count` can be fractional; round it for
 * display (profile.js's ×N badge does).
 */

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Counts non-overlapping whole-word/phrase occurrences of needleLower in
 * haystackLower — bounded by non-alphanumeric characters (or the string's
 * edges) on both sides, so e.g. "go" matches standalone but not inside
 * "google" or "ongoing". */
function countWholeWordOccurrences(haystackLower, needleLower) {
  if (!haystackLower || !needleLower) return 0;
  const re = new RegExp('(?:^|[^a-z0-9])' + escapeRegExp(needleLower) + '(?=$|[^a-z0-9])', 'g');
  const matches = haystackLower.match(re);
  return matches ? matches.length : 0;
}

// How much less an experience bullet's mentions count for each role
// further back in the list, and the floor that decay never goes below — an
// old role's experience should count for less than your current job, but
// never for nothing. Index 0 (assumed most recent, per standard resume
// convention) always counts at full weight (1.0).
const RECENCY_WEIGHT_DECAY_PER_ROLE = 0.15;
const RECENCY_MIN_WEIGHT = 0.4;

/**
 * Extracts every ATS keyword from a resume profile, deduplicated with an
 * occurrence count. Mentions of an already-known term inside
 * profile.summary or a profile.experience[].description bullet add further
 * to that count — summary mentions always at full weight, experience
 * mentions weighted by that role's recency (see
 * RECENCY_WEIGHT_DECAY_PER_ROLE).
 *
 * @param {{skills?: string[], certifications?: string[], summary?: string,
 *   experience?: Array<{description?: string}>,
 *   projects?: Array<{technologies?: string[]}>}} [profile]
 * @returns {Array<{term: string, count: number}>} Sorted by count desc, then term A→Z.
 *   `count` can be fractional once recency-weighted prose mentions are
 *   included — round it for display.
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

  const addProse = (text, weight) => {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return;
    Object.keys(keywordCounts).forEach(term => {
      const extra = countWholeWordOccurrences(t, term.toLowerCase());
      if (extra > 0) keywordCounts[term] += extra * weight;
    });
  };

  // Summary prose isn't tied to any one role, so it always counts fully.
  addProse(profile && profile.summary, 1);

  // Experience bullets: most recent role (index 0) counts fully, each
  // older role counts progressively less, down to RECENCY_MIN_WEIGHT.
  ((profile && profile.experience) || []).forEach((exp, index) => {
    const weight = Math.max(RECENCY_MIN_WEIGHT, 1 - index * RECENCY_WEIGHT_DECAY_PER_ROLE);
    addProse(exp && exp.description, weight);
  });

  return Object.entries(keywordCounts)
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
}
