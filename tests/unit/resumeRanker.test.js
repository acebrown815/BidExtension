/**
 * Tests for the local (no-AI) resume-vs-JD ATS-keyword ranker.
 *
 * Algorithm under test: JD keywords are extracted first (every term from
 * the union of all saved resumes' own ATS keywords — skills,
 * certifications, project technologies, see lib/resumeKeywords.js — that
 * actually appears in the JD text), then each resume is scored by its
 * *weighted* coverage of those JD keywords. This is the "you match N of
 * the M keywords this posting is looking for" reading of ATS matching,
 * not "how many of your own keywords show up in the JD" — with two
 * weights layered on top: a JD keyword mentioned more often in the JD
 * counts for more (capped), and a resume keyword backed up in more than
 * one place (skills + a project, say) earns a depth bonus over a bare
 * single mention. A resume with full-but-shallow coverage (every matched
 * keyword mentioned once in the JD, present exactly once in the resume)
 * scores identically to the pre-weighting algorithm — the weighting only
 * ever adds differentiation on top of that baseline.
 *
 * Covers: JD keyword extraction, scoring math (unweighted-equivalent
 * baseline, JD-emphasis weighting, resume-depth weighting), ranking
 * order, edge cases (empty resumes, empty JD, single-resume ranking),
 * ATS-keyword sourcing (certifications/project technologies count, not
 * just skills), and parity between lib/resumeRanker.js and
 * lib/resumeRanker.mjs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  rankResumes as mjsRank,
  scoreResumeAgainstJD as mjsScore,
  extractJDKeywords as mjsExtractJDKeywords,
  jdKeywordWeight as mjsJdKeywordWeight,
  resumeDepthMultiplier as mjsResumeDepthMultiplier,
  extractRequiredSectionText as mjsExtractRequiredSectionText,
  REQUIRED_SECTION_WEIGHT_MULTIPLIER as mjsRequiredSectionWeightMultiplier,
  isHighValueCategoryTerm as mjsIsHighValueCategoryTerm,
  CATEGORY_WEIGHT_MULTIPLIER as mjsCategoryWeightMultiplier,
  detectSeniorityTier as mjsDetectSeniorityTier,
  seniorityAlignmentMultiplier as mjsSeniorityAlignmentMultiplier,
  SENIORITY_MATCH_BONUS as mjsSeniorityMatchBonus,
  SENIORITY_MISMATCH_PENALTY as mjsSeniorityMismatchPenalty,
} from '../../lib/resumeRanker.mjs';

let jsRank, jsScore, jsExtractJDKeywords, jsJdKeywordWeight, jsResumeDepthMultiplier,
  jsExtractRequiredSectionText, jsRequiredSectionWeightMultiplier,
  jsIsHighValueCategoryTerm, jsCategoryWeightMultiplier,
  jsDetectSeniorityTier, jsSeniorityAlignmentMultiplier,
  jsSeniorityMatchBonus, jsSeniorityMismatchPenalty;
beforeAll(async () => {
  // resumeRanker.js reads globalThis.JMResumeKeywords at load time (to
  // build its own extractAtsKeywords reference) — it MUST be imported
  // first, or resumeRanker.js permanently captures its no-op fallback and
  // every score comes back 0.
  await import('../../lib/resumeKeywords.js');
  await import('../../lib/resumeRanker.js');
  jsRank = globalThis.JMResumeRanker.rankResumes;
  jsScore = globalThis.JMResumeRanker.scoreResumeAgainstJD;
  jsExtractJDKeywords = globalThis.JMResumeRanker.extractJDKeywords;
  jsJdKeywordWeight = globalThis.JMResumeRanker.jdKeywordWeight;
  jsResumeDepthMultiplier = globalThis.JMResumeRanker.resumeDepthMultiplier;
  jsExtractRequiredSectionText = globalThis.JMResumeRanker.extractRequiredSectionText;
  jsRequiredSectionWeightMultiplier = globalThis.JMResumeRanker.REQUIRED_SECTION_WEIGHT_MULTIPLIER;
  jsIsHighValueCategoryTerm = globalThis.JMResumeRanker.isHighValueCategoryTerm;
  jsCategoryWeightMultiplier = globalThis.JMResumeRanker.CATEGORY_WEIGHT_MULTIPLIER;
  jsDetectSeniorityTier = globalThis.JMResumeRanker.detectSeniorityTier;
  jsSeniorityAlignmentMultiplier = globalThis.JMResumeRanker.seniorityAlignmentMultiplier;
  jsSeniorityMatchBonus = globalThis.JMResumeRanker.SENIORITY_MATCH_BONUS;
  jsSeniorityMismatchPenalty = globalThis.JMResumeRanker.SENIORITY_MISMATCH_PENALTY;
});

// A JD whose own ATS keywords (per the resume vocabulary below) are:
// python, kubernetes, postgresql, aws, docker, react, graphql — 7 terms.
// "Terraform" is deliberately absent from every resume's vocabulary, so it
// can never become a JD keyword even though the JD text doesn't mention it
// either — extraction only draws from known resume terms.
const jd = 'We need engineers strong in Python, Kubernetes, PostgreSQL, AWS, ' +
  'Docker, React, and GraphQL. Terraform experience is a bonus.';

const backendResume = {
  id: 'r1',
  name: 'Backend',
  profile: { skills: ['Python', 'Kubernetes', 'PostgreSQL', 'AWS', 'Docker'] },
};

const frontendResume = {
  id: 'r2',
  name: 'Frontend',
  profile: { skills: ['React', 'TypeScript', 'CSS', 'Figma', 'GraphQL'] },
};

const emptySkillsResume = { id: 'r3', name: 'Empty', profile: { skills: [] } };
const noProfileResume = { id: 'r4', name: 'NoProfile' };

describe('extractJDKeywords', () => {
  it('extracts only vocabulary terms (from the resumes) that appear in the JD text', () => {
    const keywords = jsExtractJDKeywords(jd, [backendResume, frontendResume]);
    expect(keywords.sort()).toEqual(
      ['python', 'kubernetes', 'postgresql', 'aws', 'docker', 'react', 'graphql'].sort()
    );
    // typescript/css/figma are in the vocabulary but not mentioned in the JD.
    expect(keywords).not.toContain('typescript');
    expect(keywords).not.toContain('css');
    expect(keywords).not.toContain('figma');
  });

  it('returns [] for empty JD text or no resumes', () => {
    expect(jsExtractJDKeywords('', [backendResume])).toEqual([]);
    expect(jsExtractJDKeywords(jd, [])).toEqual([]);
    expect(jsExtractJDKeywords(jd, [noProfileResume])).toEqual([]);
  });

  it('is case-insensitive and deduplicates a term shared across resumes', () => {
    const resumeA = { id: 'a', name: 'A', profile: { skills: ['AWS'] } };
    const resumeB = { id: 'b', name: 'B', profile: { certifications: ['AWS'] } };
    const keywords = jsExtractJDKeywords('Looking for someone with AWS experience', [resumeA, resumeB]);
    expect(keywords).toEqual(['aws']);
  });
});

describe('rankResumes', () => {
  it('ranks the resume covering more of the JD keywords first', () => {
    const ranked = jsRank(jd, [frontendResume, backendResume]);
    expect(ranked[0].id).toBe('r1');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('gives each resume a score reflecting its weighted fraction of the 7 JD keywords', () => {
    const ranked = jsRank(jd, [backendResume, frontendResume]);
    const byId = Object.fromEntries(ranked.map(r => [r.id, r.score]));
    // Every keyword here is mentioned once in the JD and listed once in
    // each resume (depth multiplier 1.0, not the 1.15 max). Five of the
    // seven keywords — python, kubernetes, postgresql, aws, docker — are
    // also programming-language/database/cloud category terms (see
    // HIGH_VALUE_CATEGORY_TERMS), so each carries weight 2 instead of 1;
    // react and graphql aren't in that list and stay at weight 1. Total JD
    // weight = 5*2 + 2*1 = 12, not a clean 7 — coverage alone caps below
    // 100% regardless (see the "resume-depth weighting" describe block).
    // backend covers all five weight-2 keywords: (2*5)/(12*1.15).
    expect(byId.r1).toBeCloseTo(10 / (12 * 1.15), 5);
    // frontend covers only the two weight-1 keywords: (1*2)/(12*1.15).
    expect(byId.r2).toBeCloseTo(2 / (12 * 1.15), 5);
  });

  it('handles resumes with empty or missing skills without throwing', () => {
    const ranked = jsRank(jd, [emptySkillsResume, noProfileResume]);
    expect(ranked.every(r => r.score === 0)).toBe(true);
  });

  it('handles an empty resumes array', () => {
    expect(jsRank(jd, [])).toEqual([]);
  });

  it('handles empty/null/undefined JD text', () => {
    for (const bad of ['', null, undefined]) {
      const ranked = jsRank(bad, [backendResume, frontendResume]);
      expect(ranked.every(r => r.score === 0)).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    const resume = { id: 'r5', name: 'Case', profile: { skills: ['PYTHON'] } };
    const ranked = jsRank('looking for a python developer', [resume]);
    // Full coverage of the single matched keyword, but only a single
    // (skills-list) mention — depth multiplier 1.0 of the 1.15 max.
    expect(ranked[0].score).toBeCloseTo(1 / 1.15, 5);
  });

  it('counts a matching certification toward JD keyword coverage', () => {
    const certified = {
      id: 'r6',
      name: 'Certified',
      profile: { certifications: ['AWS Certified Solutions Architect'] },
    };
    const uncertified = { id: 'r6b', name: 'Uncertified', profile: { skills: ['COBOL'] } };
    const posting = 'looking for someone aws certified solutions architect experienced';
    const ranked = jsRank(posting, [certified, uncertified]);
    const byId = Object.fromEntries(ranked.map(r => [r.id, r.score]));
    expect(byId.r6).toBeCloseTo(1 / 1.15, 5); // present once (via certifications) — base depth
    expect(byId.r6b).toBe(0);
  });

  it('counts a matching project technology toward JD keyword coverage', () => {
    const withTech = {
      id: 'r7',
      name: 'ProjectTech',
      profile: { projects: [{ technologies: ['Kubernetes'] }] },
    };
    const posting = 'must have hands-on kubernetes experience';
    const ranked = jsRank(posting, [withTech]);
    expect(ranked[0].score).toBeCloseTo(1 / 1.15, 5); // present once (via a project) — base depth
  });

  it('a term repeated across skills/certifications/projects is one JD keyword, not three — and counts toward depth, not toward extra coverage', () => {
    // AWS appears in all three sections of one resume — extractAtsKeywords
    // + the keyword vocabulary dedupe it to a single JD keyword (coverage
    // doesn't multiply), but its resume depth count is 3 (one per
    // section), which DOES earn a partial depth bonus: multiplier(3) =
    // 1 + 2*0.05 = 1.10, still short of the 1.15 max (which needs a 4th
    // occurrence — see the dedicated depth-bonus-reaches-max test below).
    const awsEverywhere = {
      id: 'r8',
      name: 'AwsEverywhere',
      profile: {
        skills: ['AWS'],
        certifications: ['AWS'],
        projects: [{ technologies: ['AWS'] }],
      },
    };
    const ranked = jsRank('we use aws heavily', [awsEverywhere]);
    expect(ranked[0].score).toBeCloseTo(1.10 / 1.15, 5);
  });

  it('a single resume ranked alone still needs depth, not just coverage, to reach 100%', () => {
    // With only one resume in play, the JD-keyword vocabulary is drawn
    // entirely from that resume, so its COVERAGE of "the JD keywords" is
    // necessarily complete once any of its own terms appear in the JD —
    // but backendResume's skills are each listed only once, so depth caps
    // the score below 100% just like any other single-mention resume.
    const ranked = jsRank(jd, [backendResume]);
    expect(ranked[0].score).toBeCloseTo(1 / 1.15, 5);
  });
});

describe('jdKeywordWeight', () => {
  // These tests use deliberately non-category terms (figma, excel) so they
  // stay focused on pure repetition-counting, isolated from the category
  // boost — see the dedicated 'jdKeywordWeight — category weighting'
  // describe block below for python/aws/etc.-specific behavior.
  it('weighs a keyword by how many times it appears in the JD text', () => {
    const text = 'figma figma figma experience required, plus some excel';
    expect(jsJdKeywordWeight(text, 'figma')).toBe(3);
    expect(jsJdKeywordWeight(text, 'excel')).toBe(1);
  });

  it('caps the weight so one very-repeated word cannot dominate', () => {
    const text = 'figma figma figma figma figma figma figma figma';
    expect(jsJdKeywordWeight(text, 'figma')).toBe(5); // JD_TERM_WEIGHT_CAP
  });

  it('floors at 1 even if somehow asked about a term not actually present', () => {
    expect(jsJdKeywordWeight('go and rust', 'excel')).toBe(1);
  });

  it('doubles the weight when the keyword is also in the required section text', () => {
    const text = 'figma experience wanted';
    expect(jsJdKeywordWeight(text, 'figma', 'figma experience wanted')).toBe(2);
  });

  it('does not boost when requiredTextLower is omitted or empty', () => {
    const text = 'figma figma experience';
    expect(jsJdKeywordWeight(text, 'figma')).toBe(2);
    expect(jsJdKeywordWeight(text, 'figma', '')).toBe(2);
  });

  it('applies the required-section boost after the repetition cap, not before', () => {
    const text = 'figma figma figma figma figma figma figma figma';
    // capped repetition weight is 5 (JD_TERM_WEIGHT_CAP), boost doubles that to 10
    expect(jsJdKeywordWeight(text, 'figma', 'figma is required')).toBe(10);
  });
});

describe('jdKeywordWeight — category weighting (programming language / database / cloud / AI)', () => {
  it('doubles the weight for a programming language term', () => {
    expect(jsJdKeywordWeight('python experience needed', 'python')).toBe(2);
  });

  it('doubles the weight for a database term', () => {
    expect(jsJdKeywordWeight('postgresql experience needed', 'postgresql')).toBe(2);
  });

  it('doubles the weight for a cloud platform term', () => {
    expect(jsJdKeywordWeight('aws experience needed', 'aws')).toBe(2);
  });

  it('doubles the weight for an AI/ML term', () => {
    expect(jsJdKeywordWeight('machine learning experience needed', 'machine learning')).toBe(2);
  });

  it('does not boost a term outside the curated category list', () => {
    expect(jsJdKeywordWeight('figma experience needed', 'figma')).toBe(1);
  });

  it('stacks with the required-section boost rather than replacing it', () => {
    const text = 'python experience wanted';
    // base 1 (mentioned once) * required-section x2 * category x2 = 4
    expect(jsJdKeywordWeight(text, 'python', text)).toBe(4);
  });

  it('matches a multi-word resume vocabulary term via whole-word containment', () => {
    // "aws certified solutions architect" isn't itself in the curated list,
    // but it contains "aws" as a whole word — see isHighValueCategoryTerm().
    expect(jsJdKeywordWeight('aws certified solutions architect required', 'aws certified solutions architect')).toBe(2);
  });

  it('does not false-positive match "ai" inside an unrelated word', () => {
    expect(jsJdKeywordWeight('email domain experience', 'email')).toBe(1);
    expect(jsJdKeywordWeight('email domain experience', 'domain')).toBe(1);
  });

  it('the floor of 1 still gets the category boost for a high-value term not actually present', () => {
    // Defensive-floor edge case (real callers only ever ask about JD
    // keywords already confirmed present in the text) — documented here as
    // a natural consequence of the category check being independent of
    // repetition count.
    expect(jsJdKeywordWeight('go and rust', 'python')).toBe(2);
  });
});

describe('rankResumes — category weighting', () => {
  it('a resume matching a category keyword (Python) outranks one matching an equal-mention non-category keyword (Figma), at equal mention counts', () => {
    const jd = 'Looking for someone with Python and Figma experience.';
    const pythonDev = { id: 'py', name: 'Python', profile: { skills: ['Python'] } };
    const figmaDesigner = { id: 'fg', name: 'Figma', profile: { skills: ['Figma'] } };
    const ranked = jsRank(jd, [pythonDev, figmaDesigner]);
    const byId = Object.fromEntries(ranked.map(r => [r.id, r.score]));
    // Both keywords mentioned once in the raw JD text with no section
    // headers — with no category weighting these would score identically.
    // python (category weight 2) clearly outweighs figma (weight 1).
    expect(byId.py).toBeGreaterThan(byId.fg);
    expect(byId.py).toBeCloseTo(2 / (3 * 1.15), 5);
    expect(byId.fg).toBeCloseTo(1 / (3 * 1.15), 5);
  });
});

describe('extractRequiredSectionText', () => {
  it('captures text under a Requirements/Qualifications-style header', () => {
    const jd = [
      'We are looking for a Backend Engineer.',
      '',
      'Requirements:',
      '- 5+ years of Python experience',
      '- Strong AWS knowledge',
      '',
      'Nice to Have:',
      '- Kubernetes',
      '',
      'About Us:',
      'We use React internally.',
    ].join('\n');
    const required = jsExtractRequiredSectionText(jd);
    expect(required).toContain('Python');
    expect(required).toContain('AWS');
    expect(required).not.toContain('Kubernetes');
    expect(required).not.toContain('React');
  });

  it('treats "Preferred Qualifications" as non-required even though it contains "qualifications"', () => {
    const jd = [
      'Preferred Qualifications:',
      '- Rust',
      '- GraphQL',
      '',
      'Required Qualifications:',
      '- Python',
      '- AWS',
    ].join('\n');
    const required = jsExtractRequiredSectionText(jd);
    expect(required).not.toContain('Rust');
    expect(required).not.toContain('GraphQL');
    expect(required).toContain('Python');
    expect(required).toContain('AWS');
  });

  it('returns "" for a JD with no section headers at all', () => {
    const jd = 'We need a Python engineer with AWS and Docker experience for our growing team.';
    expect(jsExtractRequiredSectionText(jd)).toBe('');
  });

  it('does not mistake a sentence merely containing a trigger word for a header', () => {
    const jd = 'Deep Python knowledge required. Some Docker experience is nice to have.';
    // Neither line is a short, standalone header line, so no section is detected.
    expect(jsExtractRequiredSectionText(jd)).toBe('');
  });

  it('handles empty/null/undefined input without throwing', () => {
    expect(jsExtractRequiredSectionText('')).toBe('');
    expect(jsExtractRequiredSectionText(null)).toBe('');
    expect(jsExtractRequiredSectionText(undefined)).toBe('');
  });
});

describe('resumeDepthMultiplier', () => {
  it('returns 0 for a keyword the resume does not have', () => {
    expect(jsResumeDepthMultiplier(0)).toBe(0);
    expect(jsResumeDepthMultiplier(undefined)).toBe(0);
  });

  it('returns exactly 1.0 (no bonus, no penalty) for a single mention', () => {
    expect(jsResumeDepthMultiplier(1)).toBe(1);
  });

  it('adds a bonus for each additional mention, capped at MAX_RESUME_DEPTH_MULTIPLIER', () => {
    expect(jsResumeDepthMultiplier(2)).toBeCloseTo(1.05, 5);
    expect(jsResumeDepthMultiplier(3)).toBeCloseTo(1.10, 5);
    expect(jsResumeDepthMultiplier(4)).toBeCloseTo(1.15, 5);
    // RESUME_DEPTH_BONUS_CAP = 3 extra occurrences — a 5th+ mention adds no more.
    expect(jsResumeDepthMultiplier(10)).toBeCloseTo(1.15, 5);
  });
});

describe('rankResumes — JD-emphasis weighting', () => {
  it('a keyword the JD repeats counts for more than one mentioned once', () => {
    // "python" appears 3x (title + 2 mentions), "docker" appears once —
    // total JD weight 3+1=4, each scaled by the 1.15 max-depth denominator.
    // A resume covering only "docker" should score notably below what a
    // resume covering only "python" gets, since python (weight 3) outweighs
    // docker (weight 1) 3-to-1 — under the old flat scheme this would have
    // been an even 50/50 split.
    const jd = 'Python Engineer. We use Python daily. Deep Python knowledge ' +
      'required. Some Docker experience is nice to have.';
    const pythonDev = { id: 'py', name: 'Python', profile: { skills: ['Python'] } };
    const dockerDev = { id: 'dk', name: 'Docker', profile: { skills: ['Docker'] } };
    const ranked = jsRank(jd, [pythonDev, dockerDev]);
    const byId = Object.fromEntries(ranked.map(r => [r.id, r.score]));
    expect(byId.py).toBeCloseTo(3 / (4 * 1.15), 5); // weight 3 of total weight 4, base depth
    expect(byId.dk).toBeCloseTo(1 / (4 * 1.15), 5); // weight 1 of total weight 4, base depth
    expect(byId.py).toBeGreaterThan(byId.dk);
  });

  it('falls back to a flat weight of 1 per keyword when jdText is omitted', () => {
    const jdKeywords = ['python', 'docker'];
    const resume = { id: 'r', name: 'R', profile: { skills: ['Python'] } };
    // No 3rd argument — matches the pre-weighting call signature.
    expect(jsScore(resume, jdKeywords)).toBeCloseTo(1 / (2 * 1.15), 5);
  });

  it('a resume matching a Requirements-section keyword outranks one matching only a Nice-to-Have keyword, even at equal mention counts', () => {
    const jd = [
      'Backend Engineer',
      '',
      'Requirements:',
      '- Python',
      '',
      'Nice to Have:',
      '- Docker',
    ].join('\n');
    const pythonDev = { id: 'py', name: 'Python', profile: { skills: ['Python'] } };
    const dockerDev = { id: 'dk', name: 'Docker', profile: { skills: ['Docker'] } };
    const ranked = jsRank(jd, [pythonDev, dockerDev]);
    const byId = Object.fromEntries(ranked.map(r => [r.id, r.score]));
    // Both keywords are mentioned once in the raw JD text — with no
    // required-section weighting these would score identically. With it,
    // python (in Requirements, weight 1*2=2) clearly outweighs docker
    // (in Nice to Have, weight 1).
    expect(byId.py).toBeGreaterThan(byId.dk);
    expect(byId.py).toBeCloseTo(2 / (3 * 1.15), 5);
    expect(byId.dk).toBeCloseTo(1 / (3 * 1.15), 5);
  });
});

describe('rankResumes — resume-depth weighting', () => {
  it('a keyword backed by a project scores higher than a bare skill-list mention', () => {
    // JD mentions three keywords once each (uniform JD weight), so any
    // score difference here comes purely from resume-side depth.
    // kubernetesOnly exists purely to seed "kubernetes" into the JD-keyword
    // vocabulary (extractJDKeywords only draws from terms that appear in at
    // least one of the ranked resumes' own ATS keywords) — its own score
    // isn't asserted on.
    const jd = 'Looking for Python, Docker, and Kubernetes experience.';
    const shallow = {
      id: 'shallow', name: 'Shallow',
      profile: { skills: ['Python', 'Docker'] }, // 2 of 3, single mention each
    };
    const deep = {
      id: 'deep', name: 'Deep',
      profile: {
        skills: ['Python', 'Docker'],
        projects: [{ technologies: ['Python', 'Docker'] }], // same 2 of 3, but backed by a project too
      },
    };
    const kubernetesOnly = { id: 'k8s', name: 'K8s', profile: { skills: ['Kubernetes'] } };
    const ranked = jsRank(jd, [shallow, deep, kubernetesOnly]);
    const byId = Object.fromEntries(ranked.map(r => [r.id, r.score]));
    expect(byId.deep).toBeGreaterThan(byId.shallow);
    // Shallow: (1+1)/(3*1.15) — base depth (1.0x) for both matched keywords.
    expect(byId.shallow).toBeCloseTo(2 / (3 * 1.15), 5);
    // Deep: (1.05+1.05)/(3*1.15) — depth bonus for 2 occurrences each.
    expect(byId.deep).toBeCloseTo(2.1 / (3 * 1.15), 5);
  });

  it('reaching 100% requires both full coverage AND max resume depth, not coverage alone', () => {
    const jd = 'Need AWS experience.';
    const shallow = { id: 's', name: 'S', profile: { skills: ['AWS'] } };
    // Backed by 2 projects (plus skills + certifications = 4 total
    // mentions) to actually reach the depth cap (extra = 3), not just
    // "everywhere once" (which would only reach extra = 2, i.e. 1.10, as
    // covered by the "one JD keyword, not three" test above).
    const deep = {
      id: 'd', name: 'D',
      profile: {
        skills: ['AWS'],
        certifications: ['AWS'],
        projects: [{ technologies: ['AWS'] }, { technologies: ['AWS'] }],
      },
    };
    const ranked = jsRank(jd, [shallow, deep]);
    const byId = Object.fromEntries(ranked.map(r => [r.id, r.score]));
    expect(byId.s).toBeCloseTo(1 / 1.15, 5); // full coverage, base depth — NOT 100%
    expect(byId.d).toBe(1); // full coverage AND max depth (4 mentions) — exactly 100%
  });
});

describe('detectSeniorityTier', () => {
  it('detects each tier from representative title wording', () => {
    expect(jsDetectSeniorityTier('Director of Engineering')).toBe(4);
    expect(jsDetectSeniorityTier('VP of Product')).toBe(4);
    expect(jsDetectSeniorityTier('Staff Software Engineer')).toBe(3);
    expect(jsDetectSeniorityTier('Principal Engineer')).toBe(3);
    expect(jsDetectSeniorityTier('Senior Backend Engineer')).toBe(2);
    expect(jsDetectSeniorityTier('Mid-Level Engineer')).toBe(1);
    expect(jsDetectSeniorityTier('Junior Software Engineer')).toBe(0);
    expect(jsDetectSeniorityTier('Software Engineering Intern')).toBe(0);
  });

  it('prefers the more specific/senior tier when a title contains both words', () => {
    // "Senior Staff Engineer" is checked against the STAFF phrases before
    // SENIOR, so it resolves to STAFF (3), not SENIOR (2).
    expect(jsDetectSeniorityTier('Senior Staff Engineer')).toBe(3);
  });

  it('returns null for a title with no recognizable seniority wording', () => {
    expect(jsDetectSeniorityTier('Software Engineer')).toBeNull();
    expect(jsDetectSeniorityTier('Full Stack Developer')).toBeNull();
  });

  it('returns null for missing/blank input', () => {
    expect(jsDetectSeniorityTier('')).toBeNull();
    expect(jsDetectSeniorityTier(undefined)).toBeNull();
    expect(jsDetectSeniorityTier(null)).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(jsDetectSeniorityTier('SENIOR ENGINEER')).toBe(2);
  });

  it('matches whole words only, so "sr" does not match inside an unrelated word', () => {
    // "disruptive" contains the literal substring "sr" — this only stays
    // null if the boundary check is real, not a naive .includes().
    expect(jsDetectSeniorityTier('Disruptive Technology Engineer')).toBeNull();
  });
});

describe('seniorityAlignmentMultiplier', () => {
  const seniorResume = {
    profile: { experience: [{ title: 'Senior Backend Engineer' }, { title: 'Software Engineer' }] },
  };
  const juniorResume = {
    profile: { experience: [{ title: 'Junior Software Engineer' }] },
  };
  const directorResume = {
    profile: { experience: [{ title: 'Director of Engineering' }] },
  };
  const noLevelResume = {
    profile: { experience: [{ title: 'Software Engineer' }] },
  };
  const noExperienceResume = { profile: {} };

  it('gives the bonus when the JD title and the most recent role match tiers exactly', () => {
    expect(jsSeniorityAlignmentMultiplier('Senior Backend Engineer', seniorResume)).toBe(jsSeniorityMatchBonus);
  });

  it('stays neutral when tiers are one apart', () => {
    // Senior (2) vs. Staff (3) — one tier apart.
    expect(jsSeniorityAlignmentMultiplier('Staff Engineer', seniorResume)).toBe(1);
  });

  it('applies the penalty when tiers are two or more apart', () => {
    // Junior (0) vs. Director (4).
    expect(jsSeniorityAlignmentMultiplier('Director of Engineering', juniorResume)).toBe(jsSeniorityMismatchPenalty);
    expect(jsSeniorityAlignmentMultiplier('Junior Software Engineer', directorResume)).toBe(jsSeniorityMismatchPenalty);
  });

  it('stays neutral when the JD title has no recognizable seniority level', () => {
    expect(jsSeniorityAlignmentMultiplier('Software Engineer', juniorResume)).toBe(1);
  });

  it('stays neutral when the resume\'s most recent title has no recognizable seniority level', () => {
    expect(jsSeniorityAlignmentMultiplier('Senior Backend Engineer', noLevelResume)).toBe(1);
  });

  it('stays neutral when the resume has no experience entries at all', () => {
    expect(jsSeniorityAlignmentMultiplier('Senior Backend Engineer', noExperienceResume)).toBe(1);
    expect(jsSeniorityAlignmentMultiplier('Senior Backend Engineer', {})).toBe(1);
  });

  it('uses only the most recent (first) experience entry, not older ones', () => {
    // seniorResume's most recent title is "Senior Backend Engineer" (tier
    // 2); its second, older entry is a plain "Software Engineer" (no
    // tier) — the multiplier must reflect the first entry only.
    expect(jsSeniorityAlignmentMultiplier('Senior Backend Engineer', seniorResume)).toBe(jsSeniorityMatchBonus);
  });
});

describe('scoreResumeAgainstJD / rankResumes — seniority alignment', () => {
  it('is unaffected when jobTitle is omitted (backward compatible)', () => {
    const jdKeywords = jsExtractJDKeywords(jd, [backendResume]);
    expect(jsScore(backendResume, jdKeywords, jd)).toBe(jsScore(backendResume, jdKeywords, jd, undefined));
  });

  it('boosts a resume whose most recent title matches the JD title\'s seniority', () => {
    const seniorBackend = {
      id: 'sb', name: 'Senior Backend',
      profile: { skills: ['Python', 'AWS'], experience: [{ title: 'Senior Backend Engineer' }] },
    };
    const juniorBackend = {
      id: 'jb', name: 'Junior Backend',
      profile: { skills: ['Python', 'AWS'], experience: [{ title: 'Junior Backend Engineer' }] },
    };
    const seniorJd = 'Looking for a Senior Backend Engineer strong in Python and AWS.';
    const ranked = jsRank(seniorJd, [juniorBackend, seniorBackend], 'Senior Backend Engineer');
    const byId = Object.fromEntries(ranked.map(r => [r.id, r.score]));
    // Same keyword coverage on both sides — only the seniority nudge
    // should separate them.
    expect(byId.sb).toBeGreaterThan(byId.jb);
  });

  it('never pushes a score above 1 even with the match bonus applied', () => {
    const perfectResume = {
      id: 'p', name: 'Perfect',
      profile: {
        skills: ['Python'], certifications: ['Python'], projects: [{ technologies: ['Python'] }],
        experience: [{ title: 'Senior Engineer', description: 'Python Python Python Python' }],
      },
    };
    const jdKeywords = jsExtractJDKeywords('Python Python Python Python Python', [perfectResume]);
    const score = jsScore(perfectResume, jdKeywords, 'Python Python Python Python Python', 'Senior Engineer');
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe('lib/resumeRanker.js and lib/resumeRanker.mjs parity', () => {
  const resumes = [backendResume, frontendResume, emptySkillsResume, noProfileResume];

  it('extractJDKeywords produces identical output', () => {
    expect(jsExtractJDKeywords(jd, resumes).sort()).toEqual(mjsExtractJDKeywords(jd, resumes).sort());
  });

  it('rankResumes produces identical output', () => {
    expect(jsRank(jd, resumes)).toEqual(mjsRank(jd, resumes));
  });

  it('scoreResumeAgainstJD produces identical output (flat weight, no jdText)', () => {
    const jdKeywords = jsExtractJDKeywords(jd, resumes);
    expect(jsScore(backendResume, jdKeywords)).toBe(mjsScore(backendResume, jdKeywords));
  });

  it('scoreResumeAgainstJD produces identical output (weighted, with jdText)', () => {
    const jdKeywords = jsExtractJDKeywords(jd, resumes);
    expect(jsScore(backendResume, jdKeywords, jd)).toBe(mjsScore(backendResume, jdKeywords, jd));
  });

  it('jdKeywordWeight produces identical output', () => {
    expect(jsJdKeywordWeight(jd.toLowerCase(), 'python')).toBe(mjsJdKeywordWeight(jd.toLowerCase(), 'python'));
  });

  it('resumeDepthMultiplier produces identical output', () => {
    for (const n of [0, 1, 2, 4, 10]) {
      expect(jsResumeDepthMultiplier(n)).toBe(mjsResumeDepthMultiplier(n));
    }
  });

  it('REQUIRED_SECTION_WEIGHT_MULTIPLIER is the same constant', () => {
    expect(jsRequiredSectionWeightMultiplier).toBe(mjsRequiredSectionWeightMultiplier);
  });

  it('extractRequiredSectionText produces identical output', () => {
    const structuredJd = [
      'Requirements:', '- Python', '- AWS', '',
      'Nice to Have:', '- Kubernetes',
    ].join('\n');
    expect(jsExtractRequiredSectionText(structuredJd)).toBe(mjsExtractRequiredSectionText(structuredJd));
    expect(jsExtractRequiredSectionText(jd)).toBe(mjsExtractRequiredSectionText(jd));
  });

  it('jdKeywordWeight (3-arg, with required-section text) produces identical output', () => {
    const requiredText = 'python is required here';
    expect(jsJdKeywordWeight('python is required here', 'python', requiredText))
      .toBe(mjsJdKeywordWeight('python is required here', 'python', requiredText));
  });

  it('CATEGORY_WEIGHT_MULTIPLIER is the same constant', () => {
    expect(jsCategoryWeightMultiplier).toBe(mjsCategoryWeightMultiplier);
  });

  it('isHighValueCategoryTerm produces identical output', () => {
    for (const term of ['python', 'aws certified solutions architect', 'figma', 'email']) {
      expect(jsIsHighValueCategoryTerm(term)).toBe(mjsIsHighValueCategoryTerm(term));
    }
  });

  it('SENIORITY_MATCH_BONUS and SENIORITY_MISMATCH_PENALTY are the same constants', () => {
    expect(jsSeniorityMatchBonus).toBe(mjsSeniorityMatchBonus);
    expect(jsSeniorityMismatchPenalty).toBe(mjsSeniorityMismatchPenalty);
  });

  it('detectSeniorityTier produces identical output', () => {
    for (const title of ['Director of Engineering', 'Staff Engineer', 'Senior Engineer', 'Software Engineer', '', null]) {
      expect(jsDetectSeniorityTier(title)).toBe(mjsDetectSeniorityTier(title));
    }
  });

  it('seniorityAlignmentMultiplier produces identical output', () => {
    const resume = { profile: { experience: [{ title: 'Senior Backend Engineer' }] } };
    expect(jsSeniorityAlignmentMultiplier('Senior Backend Engineer', resume))
      .toBe(mjsSeniorityAlignmentMultiplier('Senior Backend Engineer', resume));
    expect(jsSeniorityAlignmentMultiplier('Director of Engineering', resume))
      .toBe(mjsSeniorityAlignmentMultiplier('Director of Engineering', resume));
  });

  it('rankResumes produces identical output with a jobTitle argument', () => {
    expect(jsRank(jd, resumes, 'Senior Backend Engineer')).toEqual(mjsRank(jd, resumes, 'Senior Backend Engineer'));
  });
});
