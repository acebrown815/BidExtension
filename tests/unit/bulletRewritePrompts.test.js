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

const skillCategories = [
  { label: 'Cloud & DevOps', items: ['AWS', 'Docker'] },
];

describe('buildBulletRewritePrompt — bullet rules', () => {
  it('includes the job description and the missing skills', () => {
    const messages = buildBulletRewritePrompt(profile, skillCategories, 'We need a Go developer with Databricks experience.', ['Go', 'Databricks']);
    const content = messages[0].content;
    expect(content).toContain('We need a Go developer with Databricks experience.');
    expect(content).toContain('Go, Databricks');
  });

  it('includes the current skills section categories', () => {
    const messages = buildBulletRewritePrompt(profile, skillCategories, 'JD text', ['Go']);
    expect(messages[0].content).toContain('Cloud & DevOps: AWS, Docker');
  });

  it('instructs the model to swap out an irrelevant skill mention for a missing one, not just append', () => {
    const messages = buildBulletRewritePrompt(profile, skillCategories, 'JD text', ['Go']);
    expect(messages[0].content).toMatch(/swap it out for the primary language or one of the missing skills/);
  });

  // User-requested: this whole resume — bullets, skills section included —
  // should be freely rewritten (including specific technologies/numbers/
  // results) to target a 90%+ match, in ONE consolidated call. The only
  // facts this pipeline treats as fixed are employer/title/dates, and
  // those aren't part of what this prompt returns at all (see the doc comment).
  it('explicitly allows adjusting technologies/numbers/results, and targets a 90%+ match', () => {
    const messages = buildBulletRewritePrompt(profile, skillCategories, 'JD text', ['Go']);
    const content = messages[0].content;
    expect(content).toMatch(/90%\+/);
    expect(content).not.toMatch(/never fabricate/);
  });

  it('asks the model to rewrite the skills section, allowing categories to be renamed/refocused', () => {
    const messages = buildBulletRewritePrompt(profile, skillCategories, 'JD text', ['Go']);
    expect(messages[0].content).toMatch(/"skillCategories"/);
    expect(messages[0].content).toMatch(/rename it and replace its items/);
  });

  it('asks the model to identify the JD primary/mandatory skill(s) first', () => {
    const messages = buildBulletRewritePrompt(profile, skillCategories, 'JD text', []);
    expect(messages[0].content).toMatch(/PRIMARY or MANDATORY/);
  });

  it('asks for a single "primaryLanguage" field and instructs featuring it across multiple bullets', () => {
    const messages = buildBulletRewritePrompt(profile, skillCategories, 'Senior Golang Developer role.', ['Go']);
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

  it('explicitly allows adjusting technologies/numbers/results, not just lightly rewording', () => {
    const messages = buildSingleBulletRewritePrompt('Built REST APIs using PHP.', 'JD text', [], '', []);
    const content = messages[0].content;
    expect(content).toMatch(/feel free to adjust or add technologies, tools, numbers, and results/);
    expect(content).not.toMatch(/never fabricate/);
  });

  it('falls back to a neutral instruction when there are no missing skills for this bullet', () => {
    const messages = buildSingleBulletRewritePrompt('Built REST APIs using PHP.', 'JD text', [], '', []);
    expect(messages[0].content).toContain('No specific skills to target for this bullet');
  });
});
