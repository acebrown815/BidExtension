// Live on Greenhouse (job-boards.greenhouse.io/robotsandpencils/jobs/5447044008):
// the required textarea "Have you specifically used AgentCore, If so, in what
// project/solution?" was left empty (the AI answered NEEDS_USER_INPUT — the
// resume says nothing about AgentCore), so Greenhouse flagged it and Auto-Bid
// correctly refused to submit. Greenhouse marks required fields with
// aria-required="true" (not the HTML `required` attribute), so the AI was also
// told every field was optional.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAutofillPrompt } from '../../aiService.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let runPass2;
beforeAll(() => {
  const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('// ── 2. Text inputs, textareas');
  const end = src.indexOf('// ── 2b. Rippling', start);
  runPass2 = new Function(` // eslint-disable-line no-new-func
    const shouldKeepExistingAnswer = (el) => !!(el.value || '').trim();
    const isWorkdaySelectCompanionInput = () => false;
    const isWorkdayPromptInput = () => false;
    const getFieldLabel = (el) => el.getAttribute('aria-label') || '';
    const isFieldEligible = () => true;
    const isCustomDropdown = () => false;
    const readCustomOptions = () => [];
    const buildSelectOptions = () => ({ optMap: {}, optTexts: [] });
    const seen = new Set();
    const questions = [];
    const _fieldMap = {};
    let qIndex = 0;
    ${src.slice(start, end)}
    return questions;
  `);
});

describe('detectFormFields — aria-required counts as required', () => {
  it('reports Greenhouse\'s aria-required textarea as required to the AI', () => {
    document.body.innerHTML = `
      <div class="field-wrapper field-wrapper--multiline"><div class="text-input-wrapper"><div class="input-wrapper input-wrapper__multi-line">
        <label id="question_18916136008-label" for="question_18916136008">Have you specifically used AgentCore, If so, in what project/solution?<span aria-hidden="true">*</span></label>
        <textarea id="question_18916136008" aria-label="Have you specifically used AgentCore, If so, in what project/solution?" aria-required="true" rows="4"></textarea>
      </div></div></div>
      <input id="preferred_name" aria-label="Preferred First Name" aria-required="false" value="">`;
    const byId = Object.fromEntries(runPass2().map(q => [q.question_id, q]));
    expect(byId.question_18916136008.required).toBe(true);
    expect(byId.question_18916136008.field_type).toBe('textarea');
    expect(byId.preferred_name.required).toBe(false);
  });
});

describe('buildAutofillPrompt — required experience questions get an honest answer, not a blank', () => {
  it('tells the AI to answer a required "have you used X" question honestly instead of NEEDS_USER_INPUT', () => {
    const messages = buildAutofillPrompt({ name: 'Randolph', skills: ['LangChain', 'AWS Bedrock'] }, [], [
      { question_id: 'question_18916136008', question_text: 'Have you specifically used AgentCore, If so, in what project/solution?', field_type: 'textarea', required: true },
    ]);
    const prompt = messages.map(m => m.content).join('\n');
    expect(prompt).toMatch(/"required": true[\s\S]*do NOT return NEEDS_USER_INPUT/);
    expect(prompt).toMatch(/NEVER claim experience, projects or employers the profile does\s+not support/);
    expect(prompt).toContain('"required": true');
  });
});
