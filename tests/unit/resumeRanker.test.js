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
} from '../../lib/resumeRanker.mjs';

let jsRank, jsScore, jsExtractJDKeywords, jsJdKeywordWeight, jsResumeDepthMultiplier;
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
    // Every keyword here is mentioned once in the JD (weight 1) and listed
    // once in each resume (depth multiplier 1.0, not the 1.15 max) — so
    // each resume's score is its keyword count divided by (7 * 1.15), not
    // a clean N/7: coverage alone caps below 100%, by design (see the
    // "resume-depth weighting" describe block below for why).
    // backend covers python/kubernetes/postgresql/aws/docker = 5 of 7.
    expect(byId.r1).toBeCloseTo(5 / (7 * 1.15), 5);
    // frontend covers react/graphql = 2 of 7.
    expect(byId.r2).toBeCloseTo(2 / (7 * 1.15), 5);
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
  it('weighs a keyword by how many times it appears in the JD text', () => {
    const text = 'python python python experience required, plus some sql';
    expect(jsJdKeywordWeight(text, 'python')).toBe(3);
    expect(jsJdKeywordWeight(text, 'sql')).toBe(1);
  });

  it('caps the weight so one very-repeated word cannot dominate', () => {
    const text = 'react react react react react react react react';
    expect(jsJdKeywordWeight(text, 'react')).toBe(5); // JD_TERM_WEIGHT_CAP
  });

  it('floors at 1 even if somehow asked about a term not actually present', () => {
    expect(jsJdKeywordWeight('go and rust', 'python')).toBe(1);
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
});
