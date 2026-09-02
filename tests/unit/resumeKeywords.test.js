/**
 * Tests for the shared "ATS keywords" extractor.
 *
 * Covers: merging skills/certifications/project-technologies, dedup with
 * occurrence counts, sort order, edge cases, and parity between
 * lib/resumeKeywords.js and lib/resumeKeywords.mjs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { extractAtsKeywords as mjsExtract } from '../../lib/resumeKeywords.mjs';

let jsExtract;
beforeAll(async () => {
  await import('../../lib/resumeKeywords.js');
  jsExtract = globalThis.JMResumeKeywords.extractAtsKeywords;
});

describe('extractAtsKeywords', () => {
  it('merges skills, certifications, and project technologies', () => {
    const profile = {
      skills: ['Python', 'Docker'],
      certifications: ['AWS Certified Solutions Architect'],
      projects: [{ technologies: ['Kubernetes'] }],
    };
    const terms = jsExtract(profile).map(k => k.term);
    expect(terms).toEqual(
      expect.arrayContaining(['Python', 'Docker', 'AWS Certified Solutions Architect', 'Kubernetes'])
    );
    expect(terms).toHaveLength(4);
  });

  it('merges technologies across multiple projects', () => {
    const profile = {
      projects: [
        { technologies: ['React', 'Redux'] },
        { technologies: ['Node.js'] },
      ],
    };
    expect(jsExtract(profile).map(k => k.term)).toEqual(
      expect.arrayContaining(['React', 'Redux', 'Node.js'])
    );
  });

  it('deduplicates a term repeated across sections with an occurrence count', () => {
    const profile = {
      skills: ['AWS'],
      certifications: ['AWS'],
      projects: [{ technologies: ['AWS'] }],
    };
    const result = jsExtract(profile);
    expect(result).toEqual([{ term: 'AWS', count: 3 }]);
  });

  it('sorts by count descending, then term A→Z', () => {
    const profile = {
      skills: ['Zebra', 'Apple', 'AWS'],
      certifications: ['AWS'],
    };
    expect(jsExtract(profile).map(k => k.term)).toEqual(['AWS', 'Apple', 'Zebra']);
  });

  it('trims whitespace and drops empty/blank entries', () => {
    const profile = { skills: ['  Python  ', '', '   ', 'Go'] };
    expect(jsExtract(profile).map(k => k.term)).toEqual(['Go', 'Python']);
  });

  it('returns [] for a missing or empty profile', () => {
    expect(jsExtract(undefined)).toEqual([]);
    expect(jsExtract(null)).toEqual([]);
    expect(jsExtract({})).toEqual([]);
  });

  it('handles a project entry with missing technologies without throwing', () => {
    const profile = { projects: [{ name: 'No tech listed' }, { technologies: ['Go'] }] };
    expect(jsExtract(profile).map(k => k.term)).toEqual(['Go']);
  });
});

describe('extractAtsKeywords — prose scanning (summary + experience descriptions)', () => {
  it('adds occurrences found in the summary text to an already-known term', () => {
    const profile = {
      skills: ['Python'],
      summary: 'Senior engineer with 8 years of Python experience.',
    };
    expect(jsExtract(profile)).toEqual([{ term: 'Python', count: 2 }]);
  });

  it('adds occurrences found across multiple experience bullet descriptions, recency-weighted', () => {
    const profile = {
      skills: ['AWS'],
      experience: [
        { title: 'Engineer', description: 'Migrated services to AWS and built AWS Lambda pipelines.' },
        { title: 'Engineer II', description: 'Managed AWS infrastructure for the team.' },
      ],
    };
    // 1 (skills) + 2*1.0 (index-0 bullet, full weight: "AWS" + "AWS Lambda")
    // + 1*0.85 (index-1 bullet, one role back: 1 - 0.15) = 3.85
    expect(jsExtract(profile)).toEqual([{ term: 'AWS', count: 3.85 }]);
  });

  it('does not introduce a new term found only in prose, never listed structurally', () => {
    const profile = {
      skills: ['Python'],
      summary: 'Also comfortable with Java when needed.',
    };
    expect(jsExtract(profile)).toEqual([{ term: 'Python', count: 1 }]);
  });

  it('matches whole words only, so "Go" does not match inside "Google" or "ongoing"', () => {
    const profile = {
      skills: ['Go'],
      summary: 'Worked at Google on an ongoing migration project.',
    };
    expect(jsExtract(profile)).toEqual([{ term: 'Go', count: 1 }]);
  });

  it('matches a whole word bounded by punctuation, not just spaces', () => {
    const profile = {
      skills: ['Go'],
      summary: 'Languages used: Go, Python, and SQL.',
    };
    expect(jsExtract(profile)).toEqual(
      expect.arrayContaining([{ term: 'Go', count: 2 }])
    );
  });

  it('is case-insensitive when scanning prose', () => {
    const profile = {
      skills: ['python'],
      summary: 'Built several PYTHON microservices.',
    };
    expect(jsExtract(profile)).toEqual([{ term: 'python', count: 2 }]);
  });

  it('ignores prose fields that are missing or blank', () => {
    const profile = { skills: ['Python'], summary: '', experience: [{ description: '' }, {}] };
    expect(jsExtract(profile)).toEqual([{ term: 'Python', count: 1 }]);
  });

  it('does not scan project descriptions, only summary and experience descriptions', () => {
    const profile = {
      skills: ['Python'],
      projects: [{ name: 'API', description: 'A Python-based API built for internal use.' }],
    };
    expect(jsExtract(profile)).toEqual([{ term: 'Python', count: 1 }]);
  });
});

describe('extractAtsKeywords — recency-weighted experience mentions', () => {
  it('weighs the most recent role (index 0) at full weight', () => {
    const profile = {
      skills: ['Python'],
      experience: [{ title: 'Engineer', description: 'Wrote Python services.' }],
    };
    expect(jsExtract(profile)).toEqual([{ term: 'Python', count: 2 }]); // 1 + 1*1.0
  });

  it('weighs each older role less, down to the floor', () => {
    const profile = {
      skills: ['Python'],
      experience: [
        { title: 'Role 0', description: '' },
        { title: 'Role 1', description: 'Python.' }, // weight 1 - 0.15 = 0.85
        { title: 'Role 2', description: 'Python.' }, // weight 1 - 0.30 = 0.70
        { title: 'Role 3', description: 'Python.' }, // weight 1 - 0.45 = 0.55
        { title: 'Role 4', description: 'Python.' }, // weight 1 - 0.60 = 0.40
        { title: 'Role 5', description: 'Python.' }, // floor: max(0.4, 1 - 0.75) = 0.40
      ],
    };
    // 1 (skills) + 0.85 + 0.70 + 0.55 + 0.40 + 0.40 = 3.90 (toBeCloseTo —
    // floating-point addition of these weights lands at 3.8999999999999995)
    const result = jsExtract(profile);
    expect(result).toHaveLength(1);
    expect(result[0].term).toBe('Python');
    expect(result[0].count).toBeCloseTo(3.9, 5);
  });

  it('never discounts an old role to zero — the floor keeps it counting for something', () => {
    const profile = {
      skills: ['Python'],
      experience: Array.from({ length: 10 }, (_, i) => ({ title: `Role ${i}`, description: 'Python.' })),
    };
    const result = jsExtract(profile)[0];
    expect(result.count).toBeGreaterThan(1); // every one of the 10 roles still contributed something
  });

  it('summary mentions stay at full weight regardless of experience order', () => {
    const profile = {
      skills: ['Python'],
      summary: 'Python engineer.',
      experience: [
        { title: 'Role 0', description: '' },
        { title: 'Role 1', description: '' },
        { title: 'Role 2', description: '' },
      ],
    };
    expect(jsExtract(profile)).toEqual([{ term: 'Python', count: 2 }]); // 1 (skills) + 1 (summary, full weight)
  });
});

describe('lib/resumeKeywords.js and lib/resumeKeywords.mjs parity', () => {
  it('produces identical output', () => {
    const profile = {
      skills: ['Python', 'AWS', 'Docker'],
      certifications: ['AWS', 'CKA'],
      projects: [{ technologies: ['Kubernetes', 'AWS'] }],
    };
    expect(jsExtract(profile)).toEqual(mjsExtract(profile));
  });

  it('produces identical output for an empty profile', () => {
    expect(jsExtract({})).toEqual(mjsExtract({}));
  });

  it('produces identical output when prose scanning adds occurrences', () => {
    const profile = {
      skills: ['Python', 'AWS'],
      summary: 'Python engineer who has used AWS extensively.',
      experience: [{ title: 'Eng', description: 'Built AWS pipelines and Python tooling.' }],
    };
    expect(jsExtract(profile)).toEqual(mjsExtract(profile));
  });
});
