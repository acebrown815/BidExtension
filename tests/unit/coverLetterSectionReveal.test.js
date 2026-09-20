// Regression test for a real bug: Auto-Bid's automated flow
// (attachCoverLetterFile() -> buildCoverLetterFile()) genuinely generates
// and attaches a cover letter to the ATS's upload field, and even writes
// the exact text into the panel's `#jmCoverLetterText` element ("Keep the
// panel's Cover Letter section in sync..." says the comment right above
// it) — but never un-hides `#jmCoverLetterSection` itself, which starts as
// `display:none` in the panel's static HTML. The manual "✎ Cover Letter"
// button's own handler (generateCoverLetter()) does both
// (`textContent = text` AND `section.style.display = 'block'`), but
// buildCoverLetterFile() only ever did the first — so a cover letter that
// was genuinely written and attached sat in a hidden DOM node the whole
// time, invisible in the extension panel, with nothing wrong reported.
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom (see contentRadioGroupLabel.test.js), so this
// extracts buildCoverLetterFile() by source range and evals it with small
// stand-ins for its dependencies (currentAnalysis, generateCoverLetterText,
// sendMessage, base64ToBlob, buildContactLine, formatLongDate, shadowRoot).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');
const SRC = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

const START_MARKER = 'async function buildCoverLetterFile() {';
const END_MARKER = "\n  /**\n   * Cover-letter twin of findResumeAttachTrigger()";
const START = SRC.indexOf(START_MARKER);
const END = SRC.indexOf(END_MARKER);
if (START === -1 || END === -1 || END <= START) {
  throw new Error('content.js source anchors moved — update this test\'s extraction markers');
}
const FN_SRC = SRC.slice(START, END);

/** Fake shadowRoot with independent per-id elements, so the test can inspect each one's own state. */
function makeFakeShadowRoot() {
  const els = {
    jmCoverLetterText: { textContent: '' },
    jmCoverLetterSection: { style: { display: 'none' } },
  };
  return { getElementById: (id) => els[id] || null, els };
}

function buildHarness({ analysis, generatedText, sendMessageImpl } = {}) {
  const shadowRoot = makeFakeShadowRoot();
  // eslint-disable-next-line no-eval
  const factory = (0, eval)(`(function (shadowRoot, currentAnalysis, _activeResumeId, generateCoverLetterText, sendMessage, base64ToBlob, buildContactLine, formatLongDate) {
    ${FN_SRC}
    return { buildCoverLetterFile };
  })`);
  const harness = factory(
    shadowRoot,
    analysis,
    'resume-1',
    async () => generatedText,
    sendMessageImpl || (async (msg) => {
      if (msg.type === 'GET_PROFILE') return { name: 'Jane Doe' };
      if (msg.type === 'BUILD_COVER_LETTER_FILE') return { bytesBase64: 'ZmFrZQ==', mime: 'application/pdf' };
      return {};
    }),
    (b64, mime) => new Blob([b64], { type: mime }),
    () => 'jane@example.com',
    () => 'January 1, 2026',
  );
  return { ...harness, shadowRoot };
}

describe('buildCoverLetterFile — panel Cover Letter section reveal', () => {
  it('reveals #jmCoverLetterSection and writes the text, on a successful generate+build', async () => {
    const { buildCoverLetterFile, shadowRoot } = buildHarness({
      analysis: { company: 'Uplight', title: 'Senior Software Engineer' },
      generatedText: 'Dear Hiring Manager, ...',
    });

    const result = await buildCoverLetterFile();

    expect(result).not.toBeNull();
    expect(shadowRoot.els.jmCoverLetterText.textContent).toBe('Dear Hiring Manager, ...');
    expect(shadowRoot.els.jmCoverLetterSection.style.display).toBe('block');
  });

  it('does not reveal the section when there is no analysis yet', async () => {
    const { buildCoverLetterFile, shadowRoot } = buildHarness({
      analysis: null,
      generatedText: 'Dear Hiring Manager, ...',
    });

    const result = await buildCoverLetterFile();

    expect(result).toBeNull();
    expect(shadowRoot.els.jmCoverLetterSection.style.display).toBe('none');
    expect(shadowRoot.els.jmCoverLetterText.textContent).toBe('');
  });

  it('does not reveal the section when the AI returns empty text', async () => {
    const { buildCoverLetterFile, shadowRoot } = buildHarness({
      analysis: { company: 'Uplight', title: 'Senior Software Engineer' },
      generatedText: '   ',
    });

    const result = await buildCoverLetterFile();

    expect(result).toBeNull();
    expect(shadowRoot.els.jmCoverLetterSection.style.display).toBe('none');
  });
});
