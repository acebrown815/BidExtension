// Feature test for a user-requested addition: after AutoFill attaches a
// resume file, show a PERSISTENT confirmation in the panel of which resume
// it actually was — distinct from the resume switcher's "active" pill
// highlighting, which reflects the current SELECTION, not necessarily what
// was physically attached to the form.
//
// Follow-up fix (same feature, real bug): this used to show the
// auto-generated attachment filename (buildActiveResumeFile()'s
// "Resume_<CandidateName>.<ext>"), which depends on the parsed profile's
// `name` field — confirmed live, one resume's candidate name parsed out as
// "Jobboards" (presumably picked up from the original file's own name or
// header), producing the meaningless "Resume_Jobboards.docx" in the panel.
// getActiveResumeDisplayName() now supplies the resume's own recognizable
// list name instead (e.g. "18. Senior Developer", or "... — Tailored"),
// the same name shown on its switcher pill — deliberately allowed to read
// differently than the literal bytes-on-disk filename.
//
// content.js is too large to load wholesale under happy-dom, so this
// extracts getActiveResumeDisplayName() and updateAttachedResumeIndicator()
// by source range and evals them with small stand-ins for their
// dependencies.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');
const SRC = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

const START_MARKER = 'function getActiveResumeDisplayName() {';
const END_MARKER = '\n  /**\n   * Handler for the "⬇ Resume file" button';
const START = SRC.indexOf(START_MARKER);
const END = SRC.indexOf(END_MARKER);
if (START === -1 || END === -1 || END <= START) {
  throw new Error('content.js source anchors moved — update this test\'s extraction markers');
}
const FN_SRC = SRC.slice(START, END);

function buildHarness({ tailoredSlotActive = false, tailoredResumeSlot = null, resumes = [], activeResumeId = null } = {}) {
  document.body.innerHTML = `
    <div class="jm-attached-resume" id="jmAttachedResume" style="display:none">
      Attached to this form: <strong id="jmAttachedResumeName"></strong>
    </div>
  `;
  const factory = new Function( // eslint-disable-line no-new-func
    'shadowRoot', 'tailoredSlotActive', 'tailoredResumeSlot', 'resumes', 'activeResumeId',
    `
    let _tailoredSlotActive = tailoredSlotActive;
    let _tailoredResumeSlot = tailoredResumeSlot;
    let _resumes = resumes;
    let _activeResumeId = activeResumeId;
    ${FN_SRC}
    return { getActiveResumeDisplayName, updateAttachedResumeIndicator };
    `,
  );
  return factory(document, tailoredSlotActive, tailoredResumeSlot, resumes, activeResumeId);
}

describe('getActiveResumeDisplayName', () => {
  it('returns the tailored slot\'s own name when it is active', () => {
    const { getActiveResumeDisplayName } = buildHarness({
      tailoredSlotActive: true,
      tailoredResumeSlot: { name: '18. Senior Developer — Tailored' },
      resumes: [{ id: 'r1', name: '18. Senior Developer' }],
      activeResumeId: 'r1',
    });
    expect(getActiveResumeDisplayName()).toBe('18. Senior Developer — Tailored');
  });

  it('returns the active resume\'s own list name when the tailored slot is not active', () => {
    const { getActiveResumeDisplayName } = buildHarness({
      tailoredSlotActive: false,
      resumes: [{ id: 'r1', name: '18. Senior Developer' }, { id: 'r2', name: 'Other Resume' }],
      activeResumeId: 'r1',
    });
    expect(getActiveResumeDisplayName()).toBe('18. Senior Developer');
  });

  it('falls back to "Resume" when the active resume cannot be found (defensive)', () => {
    const { getActiveResumeDisplayName } = buildHarness({
      tailoredSlotActive: false,
      resumes: [],
      activeResumeId: 'missing',
    });
    expect(getActiveResumeDisplayName()).toBe('Resume');
  });

  it('falls back to the real active resume\'s name if tailoredSlotActive is true but the slot itself is missing (defensive)', () => {
    const { getActiveResumeDisplayName } = buildHarness({
      tailoredSlotActive: true,
      tailoredResumeSlot: null,
      resumes: [{ id: 'r1', name: '18. Senior Developer' }],
      activeResumeId: 'r1',
    });
    expect(getActiveResumeDisplayName()).toBe('18. Senior Developer');
  });
});

describe('updateAttachedResumeIndicator', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('shows the indicator with the given display name', () => {
    const { updateAttachedResumeIndicator } = buildHarness();
    updateAttachedResumeIndicator('18. Senior Developer.docx');

    const el = document.getElementById('jmAttachedResume');
    const nameEl = document.getElementById('jmAttachedResumeName');
    expect(el.style.display).toBe('block');
    expect(nameEl.textContent).toBe('18. Senior Developer.docx');
  });

  it('updates the name (and stays visible) when called again with a different resume', () => {
    const { updateAttachedResumeIndicator } = buildHarness();
    updateAttachedResumeIndicator('Original Resume.docx');
    updateAttachedResumeIndicator('18. Senior Developer — Tailored.docx');

    expect(document.getElementById('jmAttachedResumeName').textContent).toBe('18. Senior Developer — Tailored.docx');
    expect(document.getElementById('jmAttachedResume').style.display).toBe('block');
  });

  it('does nothing when the display name is empty/null (no attachment happened)', () => {
    const { updateAttachedResumeIndicator } = buildHarness();
    updateAttachedResumeIndicator(null);

    expect(document.getElementById('jmAttachedResume').style.display).toBe('none');
    expect(document.getElementById('jmAttachedResumeName').textContent).toBe('');
  });

  it('does not throw when the panel elements are missing (defensive)', () => {
    const { updateAttachedResumeIndicator } = buildHarness();
    document.body.innerHTML = ''; // remove #jmAttachedResume / #jmAttachedResumeName after building
    expect(() => updateAttachedResumeIndicator('Resume.docx')).not.toThrow();
  });
});
