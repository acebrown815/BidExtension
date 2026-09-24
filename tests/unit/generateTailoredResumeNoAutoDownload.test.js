// Regression test for a UX change requested by the user: generating a
// tailored resume used to trigger an automatic browser download the
// instant it finished — that's no longer wanted. The tailored resume
// should just be added as a pill in the resume switcher (as it already
// was), and downloaded on demand later via the existing "Resume file"
// button (downloadActiveResumeFile() -> buildActiveResumeFile(), which
// already reads from _tailoredResumeSlot when the tailored pill is
// active — unaffected by this change).
//
// content.js is too large to load wholesale under happy-dom, so this
// extracts generateTailoredResume() by source range and evals it with
// small stand-ins for its dependencies, using the real DOM (happy-dom) as
// a stand-in shadowRoot so the function's own querySelectorAll/
// getElementById calls work unmodified.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');
const SRC = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

const START_MARKER = 'async function generateTailoredResume() {';
const END_MARKER = '\n  // ─── Custom bullet generator';
const START = SRC.indexOf(START_MARKER);
const END = SRC.indexOf(END_MARKER);
if (START === -1 || END === -1 || END <= START) {
  throw new Error('content.js source anchors moved — update this test\'s extraction markers');
}
const FN_SRC = SRC.slice(START, END);

const PANEL_HTML = `
  <button id="jmTailoredResumeBtn"></button>
  <div id="jmTailoredResumeSection" style="display:none"></div>
  <div id="jmTailoredResumeStatus"></div>
  <div id="jmSummaryPreview">A tailored summary.</div>
  <div id="jmLanguagesPreview">Java, Python</div>
  <div id="jmBulletList">
    <div class="jm-bullet-item">
      <input type="checkbox" class="jm-bullet-toggle" checked>
      <div class="jm-bullet-before">Built things.</div>
      <div class="jm-bullet-after">Built Java things.</div>
    </div>
  </div>
`;

function buildHarness({ sendMessageImpl } = {}) {
  document.body.innerHTML = PANEL_HTML;
  const shadowRoot = document;
  const calls = [];

  const factory = new Function( // eslint-disable-line no-new-func
    'shadowRoot', 'calls', 'sendMessageImpl',
    `
    let currentAnalysis = { title: 'Senior Engineer', company: 'Acme Corp', missingSkills: [] };
    let _activeResumeId = 'r1';
    let _resumes = [{ id: 'r1', name: 'My Resume' }];
    let _tailoredSkillCategories = [];
    let _tailoredResumeSlot = null;
    let _tailoredSlotActive = false;
    async function sendMessage(msg) {
      calls.push({ type: 'sendMessage', msg });
      return sendMessageImpl(msg);
    }
    async function getJobDescriptionForAnalysis() { return 'a job description'; }
    function renderSlotSwitcher() { calls.push({ type: 'renderSlotSwitcher' }); }
    function scrollPanelTo() {}
    function escapeHTML(s) { return s; }
    ${FN_SRC}
    return {
      generateTailoredResume,
      getState: () => ({ _tailoredResumeSlot, _tailoredSlotActive }),
    };
    `,
  );
  return { ...factory(shadowRoot, calls, sendMessageImpl || (async () => ({}))), calls };
}

describe('generateTailoredResume — no automatic download (the actual UX change)', () => {
  let clickSpy;

  beforeEach(() => {
    // Track every <a> click — an automatic download works by appending an
    // <a download> and calling .click() on it, so this is the direct,
    // browser-level signal a download was (or wasn't) triggered.
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  it('does not click an anchor to trigger a download when generation succeeds', async () => {
    const { generateTailoredResume, getState } = buildHarness({
      sendMessageImpl: async (msg) => {
        if (msg.type === 'GENERATE_TAILORED_RESUME') {
          return {
            base64: 'ZmFrZQ==', originalFileName: 'resume.docx',
            replacedCount: 1, totalBullets: 1, insertedCount: 0,
            summaryUpdated: true, languagesUpdated: true,
            newScore: 90, newAnalysis: { matchScore: 90 },
          };
        }
        return {};
      },
    });

    await generateTailoredResume();

    expect(clickSpy).not.toHaveBeenCalled();
    // The tailored slot is still populated and available to select/download later.
    const state = getState();
    expect(state._tailoredResumeSlot).not.toBeNull();
    expect(state._tailoredResumeSlot.base64).toBe('ZmFrZQ==');
    expect(state._tailoredResumeSlot.downloadName).toContain('Acme_Corp');
  });

  it('shows a status message pointing to the "Resume file" button instead of claiming it was downloaded', async () => {
    const { generateTailoredResume } = buildHarness({
      sendMessageImpl: async (msg) => {
        if (msg.type === 'GENERATE_TAILORED_RESUME') {
          return { base64: 'ZmFrZQ==', originalFileName: 'resume.docx', replacedCount: 1, totalBullets: 1, insertedCount: 0 };
        }
        return {};
      },
    });

    await generateTailoredResume();

    const statusHtml = document.getElementById('jmTailoredResumeStatus').innerHTML;
    expect(statusHtml).not.toMatch(/downloaded/i);
    expect(statusHtml).toMatch(/resume file/i);
  });

  it('still populates the tailored slot and re-renders the switcher even without any download', async () => {
    const { generateTailoredResume, getState } = buildHarness({
      sendMessageImpl: async (msg) => {
        if (msg.type === 'GENERATE_TAILORED_RESUME') {
          return { base64: 'ZmFrZQ==', originalFileName: 'resume.docx', replacedCount: 1, totalBullets: 1, insertedCount: 0 };
        }
        return {};
      },
    });

    await generateTailoredResume();

    expect(getState()._tailoredResumeSlot).not.toBeNull();
  });
});
