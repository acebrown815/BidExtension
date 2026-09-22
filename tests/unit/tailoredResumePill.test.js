// Tests for the ephemeral "Generate Tailored Resume" pill in the resume
// switcher (renderSlotSwitcher). Per explicit user direction, the tailored
// resume is deliberately NOT persisted as a saved resume (no
// chrome.storage.local write, no cross-tab visibility) — it's held in the
// in-memory _tailoredResumeSlot variable and rendered as one extra pill at
// the end of the switcher. Clicking it shows its results (Match Score,
// matching/missing skills, ...) the same way any other resume's does — via
// showTailoredResumeSlot() — and it never calls switchSlot() (that would
// try to make it "the active resume", which it isn't and was never saved as).
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom, so this extracts just renderSlotSwitcher() by
// source range and evals it with small stand-ins for its dependencies.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');
const SRC = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

const START_MARKER = 'function renderSlotSwitcher() {';
const END_MARKER = '\n\n  /**\n   * Updates the "Local Match" badge';
const START = SRC.indexOf(START_MARKER);
const END = SRC.indexOf(END_MARKER);
if (START === -1 || END === -1 || END <= START) {
  throw new Error('content.js source anchors moved — update this test\'s extraction markers');
}
const FN_SRC = SRC.slice(START, END);

/**
 * Builds a runnable renderSlotSwitcher() with a real container element (via
 * happy-dom's global `document`) and stubbed dependencies.
 * @param {Object} opts
 * @param {Array} [opts.resumes] - _resumes.
 * @param {string} [opts.activeResumeId] - _activeResumeId.
 * @param {Object|null} [opts.tailoredSlot] - _tailoredResumeSlot.
 * @param {boolean} [opts.tailoredSlotActive] - _tailoredSlotActive.
 */
function buildHarness({ resumes = [], activeResumeId = null, tailoredSlot = null, tailoredSlotActive = false }) {
  const container = document.createElement('div');
  const calls = [];
  const factory = new Function( // eslint-disable-line no-new-func
    'container', 'calls', 'resumes', 'activeResumeId', 'tailoredSlot', 'tailoredSlotActive',
    `
    let _resumes = resumes;
    let _activeResumeId = activeResumeId;
    let _tailoredResumeSlot = tailoredSlot;
    let _tailoredSlotActive = tailoredSlotActive;
    let _resumeScores = {};
    let _manualResumeSelection = false;
    const shadowRoot = { getElementById: (id) => id === 'jmSwitchPills' ? container : null };
    function getTopMatchIds() { return new Set(); }
    function switchSlot(id) { calls.push({ type: 'switchSlot', id }); }
    function showTailoredResumeSlot() { calls.push({ type: 'showTailoredResumeSlot' }); }
    function updateLocalScoreChip() { calls.push({ type: 'updateLocalScoreChip' }); }
    ${FN_SRC}
    return { renderSlotSwitcher };
    `,
  );
  const { renderSlotSwitcher } = factory(container, calls, resumes, activeResumeId, tailoredSlot, tailoredSlotActive);
  return { renderSlotSwitcher, container, calls };
}

describe('renderSlotSwitcher — ephemeral tailored resume pill', () => {
  it('renders no extra pill when no tailored resume has been generated', () => {
    const { renderSlotSwitcher, container } = buildHarness({
      resumes: [{ id: 'r1', name: 'Resume 1' }],
      activeResumeId: 'r1',
    });
    renderSlotSwitcher();
    expect(container.querySelectorAll('.jm-tailored-pill')).toHaveLength(0);
    expect(container.children).toHaveLength(1);
  });

  it('renders exactly one extra pill, after the saved-resume pills, when a tailored resume exists', () => {
    const { renderSlotSwitcher, container } = buildHarness({
      resumes: [{ id: 'r1', name: 'Resume 1' }, { id: 'r2', name: 'Resume 2' }],
      activeResumeId: 'r1',
      tailoredSlot: { name: 'Resume 1 — Tailored', base64: 'B64', downloadName: 'resume_acme.docx', newScore: 78 },
    });
    renderSlotSwitcher();
    expect(container.children).toHaveLength(3);
    const last = container.children[2];
    expect(last.className).toContain('jm-tailored-pill');
    expect(last.textContent).toContain('Resume 1 — Tailored');
    expect(last.title).toContain('78% match');
  });

  it('clicking the tailored pill shows its results and never calls switchSlot (it is not a saved/selectable resume)', () => {
    const { renderSlotSwitcher, container, calls } = buildHarness({
      resumes: [{ id: 'r1', name: 'Resume 1' }],
      activeResumeId: 'r1',
      tailoredSlot: { name: 'Resume 1 — Tailored', base64: 'BASE64DATA', downloadName: 'resume_acme.docx', newScore: 78 },
    });
    renderSlotSwitcher();
    const pill = container.querySelector('.jm-tailored-pill');
    pill.click();

    expect(calls).toContainEqual({ type: 'showTailoredResumeSlot' });
    expect(calls.some(c => c.type === 'switchSlot')).toBe(false);
  });

  it('omits the score suffix in the tooltip when no re-score is available', () => {
    const { renderSlotSwitcher, container } = buildHarness({
      resumes: [],
      tailoredSlot: { name: 'Tailored', base64: 'B64', downloadName: 'r.docx', newScore: null },
    });
    renderSlotSwitcher();
    const pill = container.querySelector('.jm-tailored-pill');
    expect(pill.title).not.toContain('% match');
  });

  it('is not marked active while the tailored slot is not the one being shown', () => {
    const { renderSlotSwitcher, container } = buildHarness({
      resumes: [{ id: 'r1', name: 'Resume 1' }],
      activeResumeId: 'r1',
      tailoredSlot: { name: 'Tailored', base64: 'B64', downloadName: 'r.docx', newScore: 80 },
      tailoredSlotActive: false,
    });
    renderSlotSwitcher();
    const pill = container.querySelector('.jm-tailored-pill');
    expect(pill.className).not.toContain('active');
    expect(container.children[0].className).toContain('active');
  });

  it('is marked active, and the real resume pill is not, while the tailored slot is being shown', () => {
    const { renderSlotSwitcher, container } = buildHarness({
      resumes: [{ id: 'r1', name: 'Resume 1' }],
      activeResumeId: 'r1',
      tailoredSlot: { name: 'Tailored', base64: 'B64', downloadName: 'r.docx', newScore: 80 },
      tailoredSlotActive: true,
    });
    renderSlotSwitcher();
    const pill = container.querySelector('.jm-tailored-pill');
    expect(pill.className).toContain('active');
    expect(container.children[0].className).not.toContain('active');
  });
});
