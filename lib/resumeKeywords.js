/**
 * Shared "ATS keywords" extractor for a resume profile.
 *
 * An Applicant Tracking System (ATS) scans a resume for keywords — mostly
 * skills, certifications, and named technologies — rather than reading it
 * the way a human would. This module defines, in exactly one place, what
 * JobMatch AI counts as a resume's ATS keyword footprint: every term from
 * profile.skills, profile.certifications, and each profile.projects[].technologies
 * entry, deduplicated with an occurrence count.
 *
 * Two consumers share this single definition so they can never drift apart:
 *   - profile.js renders it as the "ATS Keywords" list on the Profile tab.
 *   - lib/resumeRanker.js uses it (instead of skills alone) to score a
 *     resume against a job description — entirely locally, no AI call.
 *
 * Loaded as a content script before lib/resumeRanker.js and content.js —
 * hangs the API on globalThis. Mirrored at lib/resumeKeywords.mjs for tests
 * and for profile.js's module-free browser context; a parity test keeps the
 * two copies in sync.
 */
(function () {
  'use strict';

  /**
   * Extracts every ATS keyword from a resume profile, deduplicated with an
   * occurrence count (a term appearing as both a skill and a project
   * technology, for instance, gets count: 2 — a rough proxy for how
   * strongly it's represented in the resume).
   *
   * @param {{skills?: string[], certifications?: string[], projects?: Array<{technologies?: string[]}>}} [profile]
   * @returns {Array<{term: string, count: number}>} Sorted by count desc, then term A→Z.
   */
  function extractAtsKeywords(profile) {
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

  const api = { extractAtsKeywords };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.JMResumeKeywords = api;
  }
})();
