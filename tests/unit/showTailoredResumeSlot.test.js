// Tests for showTailoredResumeSlot() — clicking the ephemeral tailored
// resume pill in the switcher shows its Match Score / matching-missing
// skills / recommendations the same way any other resume's analysis is
// shown. Per explicit user direction, this must NOT change
// _activeResumeId — the tailored resume was never saved, so
// background.js has no id to look it up by; AutoFill and the "Resume
// file" download button must keep referring to the real active resume
// underneath.
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom, so this extracts just showTailoredResumeSlot()
// by source range and evals it with small stand-ins for its dependencies.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');
const SRC = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

const START_MARKER = 'function showTailoredResumeSlot() {';
const END_MARKER = '\n\n  /**\n   * Switches the active resume, updates chrome.storage.local';
const START = SRC.indexOf(START_MARKER);
const END = SRC.indexOf(END_MARKER);
if (START === -1 || END === -1 || END <= START) {
  throw new Error('content.js source anchors moved — update this test\'s extraction markers');
}
const FN_SRC = SRC.slice(START, END);

/**
 * Builds a runnable showTailoredResumeSlot() with stubbed dependencies and
 * a `calls` log for the side-effecting functions.
 * @param {Object|null} tailoredSlot - _tailoredResumeSlot's starting value.
 * @param {string} activeResumeId - _activeResumeId's starting value (must stay untouched).
 */
function buildHarness(tailoredSlot, activeResumeId = 'r1') {
  const calls = [];
  const els = {};
  const fakeEl = () => ({ style: {} });
  ['jmMarkApplied', 'jmCoverLetterBtn', 'jmTailoredResumeBtn', 'jmRewriteBulletsBtn'].forEach(id => { els[id] = fakeEl(); });
  const factory = new Function( // eslint-disable-line no-new-func
    'calls', 'els', 'tailoredSlot', 'activeResumeId',
    `
    let _tailoredResumeSlot = tailoredSlot;
    let _tailoredSlotActive = false;
    let _activeResumeId = activeResumeId;
    let currentAnalysis = null;
    const shadowRoot = { getElementById: (id) => els[id] || null };
    function setStatus(msg, kind) { calls.push({ type: 'setStatus', msg, kind }); }
    function clearStatus() { calls.push({ type: 'clearStatus' }); }
    function showJobMeta(title, company, location, salary, jobId, language) {
      calls.push({ type: 'showJobMeta', title, company, location, salary, jobId, language });
    }
    function renderAnalysis(data) { calls.push({ type: 'renderAnalysis', data }); }
    function updateMarkAppliedGating(score) { calls.push({ type: 'updateMarkAppliedGating', score }); }
    function renderSlotSwitcher() { calls.push({ type: 'renderSlotSwitcher' }); }
    ${FN_SRC}
    return {
      showTailoredResumeSlot,
      getState: () => ({ currentAnalysis, _activeResumeId, _tailoredSlotActive }),
    };
    `,
  );
  return { ...factory(calls, els, tailoredSlot, activeResumeId), calls, els };
}

describe('showTailoredResumeSlot', () => {
  it('renders the tailored analysis (score, job meta) without changing _activeResumeId', () => {
    const slot = {
      name: 'Resume 1 — Tailored',
      downloadName: 'resume_acme.docx',
      newScore: 82,
      newAnalysis: { matchScore: 82, matchingSkills: ['Go'], missingSkills: [] },
      jobMeta: { title: 'Senior Golang Developer', company: 'Acme', location: 'Remote', salary: '$150k', jobId: 'j1', language: 'en', url: 'https://x.com' },
    };
    const { showTailoredResumeSlot, getState, calls } = buildHarness(slot, 'r1');

    showTailoredResumeSlot();

    const state = getState();
    expect(state._activeResumeId).toBe('r1'); // untouched — never becomes "the active resume"
    expect(state._tailoredSlotActive).toBe(true);
    expect(state.currentAnalysis.matchScore).toBe(82);
    expect(state.currentAnalysis.resumeName).toBe('Resume 1 — Tailored');

    const jobMetaCall = calls.find(c => c.type === 'showJobMeta');
    expect(jobMetaCall).toEqual({ type: 'showJobMeta', title: 'Senior Golang Developer', company: 'Acme', location: 'Remote', salary: '$150k', jobId: 'j1', language: 'en' });
    const renderCall = calls.find(c => c.type === 'renderAnalysis');
    expect(renderCall.data).toBe(slot.newAnalysis);
    const gatingCall = calls.find(c => c.type === 'updateMarkAppliedGating');
    expect(gatingCall.score).toBe(82);
    expect(calls.some(c => c.type === 'renderSlotSwitcher')).toBe(true);
  });

  it('reveals Mark Applied, Cover Letter, Improve Bullets, and Tailored Resume buttons', () => {
    const slot = {
      name: 'Tailored', downloadName: 'r.docx', newScore: 70,
      newAnalysis: { matchScore: 70 }, jobMeta: {},
    };
    const { showTailoredResumeSlot, els } = buildHarness(slot);

    showTailoredResumeSlot();

    expect(els.jmMarkApplied.style.display).toBe('flex');
    expect(els.jmCoverLetterBtn.style.display).toBe('flex');
    expect(els.jmRewriteBulletsBtn.style.display).toBe('flex');
    expect(els.jmTailoredResumeBtn.style.display).toBe('flex');
  });

  it('shows an error status and does nothing else when there is no slot to show', () => {
    const { showTailoredResumeSlot, getState, calls } = buildHarness(null);

    showTailoredResumeSlot();

    expect(getState().currentAnalysis).toBeNull();
    expect(getState()._tailoredSlotActive).toBe(false);
    expect(calls.some(c => c.type === 'setStatus' && c.kind === 'error')).toBe(true);
    expect(calls.some(c => c.type === 'renderAnalysis')).toBe(false);
  });

  it('shows an error status when the slot exists but has no re-scored analysis (re-score failed)', () => {
    const slot = { name: 'Tailored', downloadName: 'r.docx', newScore: null, newAnalysis: null, jobMeta: {} };
    const { showTailoredResumeSlot, getState, calls } = buildHarness(slot);

    showTailoredResumeSlot();

    expect(getState()._tailoredSlotActive).toBe(false);
    expect(calls.some(c => c.type === 'setStatus' && c.kind === 'error')).toBe(true);
  });
});
