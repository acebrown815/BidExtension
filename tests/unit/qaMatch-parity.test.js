/**
 * Parity test: lib/qaMatch.js (content-script IIFE, used by directFill.js)
 * and lib/qaMatch.mjs (service-worker ES module, used by aiService.js) hold
 * the same logic. If the two ever diverge, this test will catch it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { qaQuestionMatchesLabel as mjsMatch } from '../../lib/qaMatch.mjs';

let jsMatch;
beforeAll(async () => {
  await import('../../lib/qaMatch.js');
  jsMatch = globalThis.JMQaMatch.qaQuestionMatchesLabel;
});

const cases = [
  ['Do you need sponsorship?', 'Do you need sponsorship?'],
  ['Do you need sponsorship?', 'Do you expect any sponsorship from us?'],
  ['Do you have sponsorship program management experience?', 'Do you need sponsorship?'],
  ['Are you legally authorized to work in the US?', 'Do you require visa sponsorship to work in this role?'],
  ['Salary expectations', 'What are your salary expectations?'],
  ['Gender', 'I identify my gender as'],
  ['', 'Anything'],
  ['Anything', ''],
];

describe('qaMatch.js ↔ qaMatch.mjs parity', () => {
  it.each(cases)('produces identical output for (%j, %j)', (q, l) => {
    expect(jsMatch(q, l)).toBe(mjsMatch(q, l));
  });
});
