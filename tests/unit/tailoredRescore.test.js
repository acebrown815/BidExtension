/**
 * Tests for buildTailoredProfileForRescoring (lib/tailoredRescore.mjs) —
 * builds the ad-hoc profile used to give the ephemeral tailored-resume pill
 * a real "Match Score" without ever persisting it as a saved resume.
 */
import { describe, it, expect } from 'vitest';
import { buildTailoredProfileForRescoring } from '../../lib/tailoredRescore.mjs';

const profile = {
  summary: 'Backend engineer with 8 years of experience.',
  skills: ['JavaScript', 'Node.js'],
  experience: [
    { title: 'Senior Engineer', company: 'Acme Corp', description: 'Built REST APIs.\nMentored junior engineers.' },
    { title: 'Engineer', company: 'Globex', description: 'Maintained legacy PHP services.' },
  ],
};

describe('buildTailoredProfileForRescoring', () => {
  it('replaces the description of the job a bullet is attributed to', () => {
    const rewrittenBullets = [
      { job: 'Senior Engineer at Acme Corp', original: 'Built REST APIs (slightly different wording)', improved: 'Built and scaled Go microservices handling 10M requests/day' },
    ];
    const out = buildTailoredProfileForRescoring(profile, '', [], rewrittenBullets);
    expect(out.experience[0].description).toContain('Go microservices');
    expect(out.experience[1].description).toBe('Maintained legacy PHP services.');
  });

  it('does not touch a job with no attributed bullets', () => {
    const rewrittenBullets = [
      { job: 'Engineer at Globex', original: 'Maintained legacy PHP services', improved: 'Modernized legacy PHP services onto a microservices architecture' },
    ];
    const out = buildTailoredProfileForRescoring(profile, '', [], rewrittenBullets);
    expect(out.experience[0].description).toBe(profile.experience[0].description);
    expect(out.experience[1].description).toContain('microservices');
  });

  it('uses the new summary when provided, falls back to the original otherwise', () => {
    expect(buildTailoredProfileForRescoring(profile, 'New tailored summary', [], []).summary).toBe('New tailored summary');
    expect(buildTailoredProfileForRescoring(profile, '', [], []).summary).toBe(profile.summary);
  });

  it('adds revised languages to the skills used for scoring, without removing anything', () => {
    const out = buildTailoredProfileForRescoring(profile, '', ['Go', 'JavaScript'], []);
    expect(out.skills).toContain('JavaScript'); // original, kept
    expect(out.skills).toContain('Node.js');     // original, kept — languages is additive only
    expect(out.skills).toContain('Go');          // newly added
  });

  it('does not duplicate a language that is already in the original skills', () => {
    const out = buildTailoredProfileForRescoring(profile, '', ['JavaScript'], []);
    expect(out.skills.filter(s => s === 'JavaScript')).toHaveLength(1);
  });

  it('leaves skills untouched when no languages are provided', () => {
    const out = buildTailoredProfileForRescoring(profile, '', [], []);
    expect(out.skills).toBe(profile.skills);
  });

  it('does not crash on a profile with no experience array', () => {
    const out = buildTailoredProfileForRescoring({ summary: 'x', skills: [] }, 'y', ['Go'], [{ job: 'A at B', original: 'x', improved: 'y' }]);
    expect(out.experience).toBeUndefined();
    expect(out.summary).toBe('y');
    expect(out.skills).toEqual(['Go']);
  });

  // The actual bug: a tailored resume's displayed Match Score stayed
  // identical to the pre-tailoring score no matter how much the skills
  // section itself changed, because the rescore step never saw any of the
  // skillCategories tailoring — only the separate `languages` field.
  describe('skillCategories — the actual bug (rescore was blind to the tailored skills section)', () => {
    it('adds every skillCategories item to the skills used for scoring', () => {
      const skillCategories = [
        { label: 'Java & Backend', items: ['Java', 'Spring Boot', 'Hibernate'] },
        { label: 'Observability', items: ['Splunk', 'Dynatrace'] },
      ];
      const out = buildTailoredProfileForRescoring(profile, '', [], [], skillCategories);
      expect(out.skills).toEqual(expect.arrayContaining(['JavaScript', 'Node.js', 'Java', 'Spring Boot', 'Hibernate', 'Splunk', 'Dynatrace']));
    });

    it('combines languages and skillCategories items without duplicating', () => {
      const skillCategories = [{ label: 'Java & Backend', items: ['Java', 'Spring Boot'] }];
      const out = buildTailoredProfileForRescoring(profile, '', ['Java', 'Go'], [], skillCategories);
      expect(out.skills.filter(s => s === 'Java')).toHaveLength(1); // named in both languages and a category — added once
      expect(out.skills).toEqual(expect.arrayContaining(['Go', 'Java', 'Spring Boot']));
    });

    it('does not duplicate a skillCategories item already in the original skills', () => {
      const skillCategories = [{ label: 'Languages', items: ['JavaScript'] }];
      const out = buildTailoredProfileForRescoring(profile, '', [], [], skillCategories);
      expect(out.skills.filter(s => s === 'JavaScript')).toHaveLength(1);
    });

    it('tolerates a missing or malformed skillCategories argument', () => {
      expect(buildTailoredProfileForRescoring(profile, '', ['Go'], [], undefined).skills).toContain('Go');
      expect(buildTailoredProfileForRescoring(profile, '', ['Go'], [], null).skills).toContain('Go');
      expect(buildTailoredProfileForRescoring(profile, '', ['Go'], [], [{ label: 'Empty' }]).skills).toContain('Go');
    });
  });
});
