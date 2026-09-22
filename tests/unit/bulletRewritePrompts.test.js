/**
 * Tests for buildBulletRewritePrompt and buildSingleBulletRewritePrompt
 * (aiService.js).
 *
 * User-requested behavior: rewriting a bullet — whether via the bulk
 * "Improve Resume Bullets" pass or the per-bullet regenerate button — must
 * genuinely use the current job description and missing skills, and should
 * REPLACE a mention of a skill/technology the job has no use for with one
 * of the missing skills instead of just appending the missing skill
 * alongside it. The previous single-bullet prompt treated missing skills
 * as purely optional ("fine to include NONE of them"), which under-used
 * the JD/missing-skills context it was already given.
 */
import { describe, it, expect } from 'vitest';
import { buildBulletRewritePrompt, buildSingleBulletRewritePrompt } from '../../aiService.js';

const profile = {
  summary: 'Senior engineer with a decade of backend experience.',
  skills: ['PHP', 'Python', 'AWS'],
  experience: [
    { title: 'Senior Engineer', company: 'Acme', description: 'Built REST APIs using PHP and Laravel.' },
  ],
};

describe('buildBulletRewritePrompt — bullet rules', () => {
  it('includes the job description and the missing skills', () => {
    const messages = buildBulletRewritePrompt(profile, 'We need a Go developer with Databricks experience.', ['Go', 'Databricks']);
    const content = messages[0].content;
    expect(content).toContain('We need a Go developer with Databricks experience.');
    expect(content).toContain('Go, Databricks');
  });

  it('instructs the model to replace an irrelevant skill mention with a missing one, not just append', () => {
    const messages = buildBulletRewritePrompt(profile, 'JD text', ['Go']);
    expect(messages[0].content).toMatch(/REPLACE that mention with the primary language or one of the missing skills/);
  });

  it('still prohibits fabricating employer/title/date/number claims', () => {
    const messages = buildBulletRewritePrompt(profile, 'JD text', ['Go']);
    expect(messages[0].content).toMatch(/never fabricate a new employer, title, date, number, or result/);
  });

  it('asks the model to identify the JD primary/mandatory skill(s) first', () => {
    const messages = buildBulletRewritePrompt(profile, 'JD text', []);
    expect(messages[0].content).toMatch(/PRIMARY or MANDATORY/);
  });

  it('asks for a single "primaryLanguage" field and instructs featuring it across multiple bullets', () => {
    const messages = buildBulletRewritePrompt(profile, 'Senior Golang Developer role.', ['Go']);
    const content = messages[0].content;
    expect(content).toContain('"primaryLanguage"');
    expect(content).toMatch(/MORE THAN ONE bullet/);
    expect(content).toMatch(/outweigh every other language\/skill/);
  });
});

describe('buildSingleBulletRewritePrompt — bullet rules', () => {
  it('includes the job description', () => {
    const messages = buildSingleBulletRewritePrompt('Built REST APIs using PHP.', 'Senior Golang Developer role requiring Go.', ['Go'], '', []);
    expect(messages[0].content).toContain('Senior Golang Developer role requiring Go.');
  });

  it('treats missing skills as something to weave in, not merely optional (the actual fix)', () => {
    const messages = buildSingleBulletRewritePrompt('Built REST APIs using PHP.', 'JD text', ['Go'], '', []);
    const content = messages[0].content;
    expect(content).toContain('Go');
    // The old wording explicitly said this was optional and fine to skip
    // entirely — that under-used the missing-skills context it was given.
    expect(content).not.toMatch(/OPTIONAL: You MAY subtly reference/);
    expect(content).not.toMatch(/fine to include NONE of them/);
  });

  it('instructs replacing an irrelevant skill mention with a missing one', () => {
    const messages = buildSingleBulletRewritePrompt('Built REST APIs using PHP.', 'JD text', ['Go'], '', []);
    expect(messages[0].content).toMatch(/REPLACE that mention with one of the missing skills/);
  });

  it('still respects excluded skills', () => {
    const messages = buildSingleBulletRewritePrompt('Built REST APIs using PHP.', 'JD text', ['Go'], '', ['Rust']);
    expect(messages[0].content).toContain('Do NOT mention or reference any of these skills under any circumstances: Rust');
  });

  it('still prohibits fabricating a new employer/title/date/number', () => {
    const messages = buildSingleBulletRewritePrompt('Built REST APIs using PHP.', 'JD text', [], '', []);
    expect(messages[0].content).toMatch(/never fabricate a new employer, title, date, or a result\/number/);
  });

  it('falls back to a neutral instruction when there are no missing skills for this bullet', () => {
    const messages = buildSingleBulletRewritePrompt('Built REST APIs using PHP.', 'JD text', [], '', []);
    expect(messages[0].content).toContain('No specific skills to target for this bullet');
  });
});
