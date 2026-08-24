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
});
