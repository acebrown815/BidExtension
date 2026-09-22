// Regression test for a real bug: after clicking the ephemeral tailored
// resume pill (showTailoredResumeSlot shows its Match Score without ever
// making it _activeResumeId — there's no id to give it, it was never
// saved), both the "Resume file" download button AND AutoFill's actual
// resume attachment kept using the REAL active resume's ORIGINAL file,
// because buildActiveResumeFile() only ever knew about _activeResumeId.
//
// Fix: buildActiveResumeFile() now checks _tailoredSlotActive first and
// returns a File built from _tailoredResumeSlot's own base64 directly when
// it's the one on screen — bypassing GET_RAW_RESUME entirely. This is
// also what lets Auto-Bid "continue using" a resume it auto-tailors (see
// autoAnalyzeAndMaybeAutofill): once it sets _tailoredSlotActive, the
// actual AutoFill attachment (attachResumeFile -> buildActiveResumeFile)
// uses the tailored bytes for the rest of that application.
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom, so this extracts just buildActiveResumeFile()
// by source range and evals it with small stand-ins for its dependencies.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');
const SRC = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

const START_MARKER = 'async function buildActiveResumeFile() {';
const END_MARKER = '\n\n  /**\n   * Finds a button/link that looks like it opens a resume-attach menu';
const START = SRC.indexOf(START_MARKER);
const END = SRC.indexOf(END_MARKER);
if (START === -1 || END === -1 || END <= START) {
  throw new Error('content.js source anchors moved — update this test\'s extraction markers');
}
const FN_SRC = SRC.slice(START, END);

/**
 * Builds a runnable buildActiveResumeFile() with stubbed dependencies and
 * a `calls` log.
 * @param {Object} opts
 * @param {boolean} [opts.tailoredSlotActive]
 * @param {Object|null} [opts.tailoredSlot] - _tailoredResumeSlot.
 * @param {Object|null} [opts.rawResume] - what GET_RAW_RESUME resolves to.
 * @param {Object|null} [opts.profile] - what GET_PROFILE resolves to.
 * @param {boolean} [opts.throwOnTailoredBlob] - make base64ToBlob throw for the tailored path only.
 */
function buildHarness({ tailoredSlotActive = false, tailoredSlot = null, rawResume = null, profile = null, throwOnTailoredBlob = false }) {
  const calls = [];
  const factory = new Function( // eslint-disable-line no-new-func
    'calls', 'tailoredSlotActive', 'tailoredSlot', 'rawResume', 'profile', 'throwOnTailoredBlob',
    `
    let _tailoredSlotActive = tailoredSlotActive;
    let _tailoredResumeSlot = tailoredSlot;
    let _activeResumeId = 'real-resume-id';
    async function sendMessage(msg) {
      calls.push({ type: 'sendMessage', msg });
      if (msg.type === 'GET_RAW_RESUME') return rawResume;
      if (msg.type === 'GET_PROFILE') return profile;
      return null;
    }
    function sanitizeFileNameSegment(s) { return (s || '').replace(/[^a-zA-Z0-9-]/g, '-'); }
    function base64ToBlob(base64, mimeType) {
      calls.push({ type: 'base64ToBlob', base64, mimeType });
      if (throwOnTailoredBlob && base64 === (tailoredSlot && tailoredSlot.base64)) {
        throw new Error('boom');
      }
      return new Blob([base64], { type: mimeType });
    }
    ${FN_SRC}
    return { buildActiveResumeFile };
    `,
  );
  const { buildActiveResumeFile } = factory(calls, tailoredSlotActive, tailoredSlot, rawResume, profile, throwOnTailoredBlob);
  return { buildActiveResumeFile, calls };
}

describe('buildActiveResumeFile', () => {
  it('returns the TAILORED file (not the original) when the tailored slot is being shown (the actual bug)', async () => {
    const { buildActiveResumeFile, calls } = buildHarness({
      tailoredSlotActive: true,
      tailoredSlot: { base64: 'TAILORED_BASE64', downloadName: 'resume_acme_tailored.docx' },
      rawResume: { rawResumeBase64: 'ORIGINAL_BASE64', fileType: 'docx' },
    });

    const result = await buildActiveResumeFile();

    expect(result.fileName).toBe('resume_acme_tailored.docx');
    expect(calls.some(c => c.type === 'sendMessage')).toBe(false); // GET_RAW_RESUME/GET_PROFILE never called
    expect(calls.find(c => c.type === 'base64ToBlob').base64).toBe('TAILORED_BASE64');
  });

  it('still returns the real active resume file when the tailored slot is not active (no regression)', async () => {
    const { buildActiveResumeFile, calls } = buildHarness({
      tailoredSlotActive: false,
      tailoredSlot: { base64: 'TAILORED_BASE64', downloadName: 'resume_acme_tailored.docx' },
      rawResume: { rawResumeBase64: 'ORIGINAL_BASE64', fileType: 'docx' },
      profile: { name: 'Jane Doe' },
    });

    const result = await buildActiveResumeFile();

    expect(result.fileName).toBe('Resume_Jane-Doe.docx');
    expect(calls.some(c => c.type === 'sendMessage' && c.msg.type === 'GET_RAW_RESUME')).toBe(true);
  });

  it('falls back to the real active resume when tailoredSlotActive is true but there is no slot (defensive)', async () => {
    const { buildActiveResumeFile } = buildHarness({
      tailoredSlotActive: true,
      tailoredSlot: null,
      rawResume: { rawResumeBase64: 'ORIGINAL_BASE64', fileType: 'pdf' },
      profile: { name: 'Jane Doe' },
    });

    const result = await buildActiveResumeFile();

    expect(result.fileName).toBe('Resume_Jane-Doe.pdf');
  });

  it('falls back to the real active resume if building the tailored File object throws', async () => {
    const { buildActiveResumeFile } = buildHarness({
      tailoredSlotActive: true,
      tailoredSlot: { base64: 'TAILORED_BASE64', downloadName: 'resume_acme_tailored.docx' },
      rawResume: { rawResumeBase64: 'ORIGINAL_BASE64', fileType: 'docx' },
      profile: { name: 'Jane Doe' },
      throwOnTailoredBlob: true,
    });

    const result = await buildActiveResumeFile();

    expect(result.fileName).toBe('Resume_Jane-Doe.docx');
  });

  it('returns null when there is no saved resume file and the tailored slot is not active', async () => {
    const { buildActiveResumeFile } = buildHarness({ tailoredSlotActive: false, rawResume: { rawResumeBase64: null } });
    expect(await buildActiveResumeFile()).toBeNull();
  });
});
