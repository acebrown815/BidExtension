/**
 * Builds the ad-hoc "tailored" profile object used to re-score a resume
 * after Improve Resume Bullets / Generate Tailored Resume have rewritten
 * its summary, languages, and bullets — pulled out of background.js's
 * handleGenerateTailoredResume so the job-to-bullet attribution logic is
 * unit-testable without JSZip or chrome.storage.
 */
import { normalizeForMatch } from './docxBullets.mjs';

/**
 * Builds an ad-hoc, never-persisted "tailored" profile reflecting the
 * summary/languages/bullet edits, so it can be re-scored against the job
 * description with the same buildJobAnalysisPrompt used for the original
 * score — letting the ephemeral tailored-resume pill show a real "Match
 * Score" the same way any saved resume's does.
 *
 * Each experience entry's description is rebuilt from the bullets
 * attributed to that job — matching each bullet's own "job" label
 * fuzzily against "{title} at {company}" — rather than by splicing
 * bullet.original into the stored description as an exact substring.
 * Description text stored in a parsed profile rarely matches an AI-echoed
 * "original" bullet byte-for-byte (whitespace, punctuation, line breaks),
 * so an exact-substring splice would silently fail far more often than
 * not, leaving the re-scored profile all but identical to the original.
 *
 * Revised languages are ADDED to the skills used for scoring rather than
 * replacing the flat skills list outright — profile.skills mixes every
 * category (languages, frameworks, cloud, ...) with no structure telling
 * us which entries were "languages" in the first place, so there's no
 * clean way to subtract from it. Since the score only cares about which
 * skills are present, adding is enough; nothing needs removing here (the
 * DOCX-level Languages line is trimmed separately, for readability, not
 * for scoring).
 *
 * @param {Object} profile - The original (saved) resume profile.
 * @param {string} newSummary - AI-rewritten summary (falls back to the original if empty).
 * @param {string[]} languages - AI-revised programming-languages list for this job.
 * @param {Array<{job: string, original: string, improved: string}>} rewrittenBullets
 * @returns {Object} A shallow-cloned profile with summary/skills/experience updated for scoring.
 */
export function buildTailoredProfileForRescoring(profile, newSummary, languages, rewrittenBullets) {
  const bullets = Array.isArray(rewrittenBullets) ? rewrittenBullets : [];
  const langs = Array.isArray(languages) ? languages.filter(Boolean) : [];
  const originalSkills = Array.isArray(profile.skills) ? profile.skills : [];
  const originalSkillsLower = new Set(originalSkills.map(s => String(s).toLowerCase().trim()));
  const addedLanguages = langs.filter(l => !originalSkillsLower.has(String(l).toLowerCase().trim()));

  return {
    ...profile,
    summary: newSummary || profile.summary,
    skills: addedLanguages.length > 0 ? [...originalSkills, ...addedLanguages] : originalSkills,
    experience: Array.isArray(profile.experience)
      ? profile.experience.map(exp => {
          const jobLabel = normalizeForMatch(`${exp.title || ''} at ${exp.company || ''}`);
          const bulletsForJob = bullets.filter(b => {
            const bJob = normalizeForMatch(b.job || '');
            return bJob && jobLabel && (jobLabel.includes(bJob) || bJob.includes(jobLabel));
          });
          if (bulletsForJob.length === 0) return exp;
          const description = bulletsForJob.map(b => b.improved).filter(Boolean).join('\n');
          return description ? { ...exp, description } : exp;
        })
      : profile.experience,
  };
}
