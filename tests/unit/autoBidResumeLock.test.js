// Regression test for Auto-Bid keeping the resume its analysis picked across
// Workday's multi-hop apply flow (pae.wd1.myworkdayjobs.com/.../job/US-Remote/
// Software-Engineer-II_R0171825 → "Start Your Application" →
// /en-US/.../apply/autofillWithResume → 6 wizard steps).
//
// analyzeJob() can pick a resume that is NOT the local keyword-ranking's top
// one (it AI-compares the top 3). After a hop, checkPendingAutoBidAutofill()
// restored that id into memory only — then opening the panel ran
// loadResumeState(), which re-read activeResumeId from storage and silently
// overwrote it, and scanResumeMatch()/ensureBestResumeSelected() were free to
// re-rank as soon as the short-lived continuation flag dropped (immediately,
// on Workday's dialog hop). lockAutoBidResumeSelection() pins the choice as a
// manual one and writes it back to storage before the panel reloads it.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');

let FN_SRC;

beforeAll(() => {
  const src = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('  /**\n   * Pins the resume Auto-Bid');
  const end = src.indexOf('  chrome.runtime.onMessage.addListener(', start);
  if (start === -1 || end === -1) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  }
  FN_SRC = src.slice(start, end);
});

const RESUMES = [
  { id: 'keyword-top', profile: { name: 'A' }, rawResumeBase64: 'AAA', resumeFileType: 'pdf' },
  { id: 'ai-picked', profile: { name: 'B' }, rawResumeBase64: 'BBB', resumeFileType: 'docx' },
];

function buildHarness({ storedActive, pendingResumeId }) {
  const store = { resumes: RESUMES, activeResumeId: storedActive };
  const chrome = {
    storage: {
      local: {
        get: async (keys) => Object.fromEntries([].concat(keys).map(k => [k, store[k]])),
        set: async (obj) => { Object.assign(store, obj); },
      },
    },
  };
  const factory = new Function( // eslint-disable-line no-new-func
    'chrome', 'store',
    `
    let _manualResumeSelection = false;
    let _activeResumeId = ${JSON.stringify(storedActive)};
    let currentAnalysis = null;
    let _tailoredResumeSlot = null;
    let _tailoredSlotActive = false;
    let _autoBidContinuationActive = false;
    let _autoBidAutofillRun = false;
    let panelOpen = false;
    const shadowRoot = { getElementById: () => ({ style: {} }) };
    async function sendMessage() {
      return { pending: true, analysis: null, activeResumeId: ${JSON.stringify(pendingResumeId)}, tailoredResumeSlot: null };
    }
    // The real togglePanel() fires loadResumeState(), which re-reads the
    // stored active resume into _activeResumeId.
    function togglePanel() { panelOpen = true; _activeResumeId = store.activeResumeId; }
    function renderSlotSwitcher() {}
    async function waitForDomSettled() {}
    // Workday's "Start Your Application" dialog hop — returns right away.
    const isWorkdayHost = () => false;
    function stopManualStepWatch() {}
    const WORKDAY_DIALOG_WAIT_MS = 0;
    async function clickWorkdayAutofillWithResumeIfPresent() { return true; }
    async function waitForFormFieldsReady() {}
    async function autofillForm() {}
    ${FN_SRC}
    return {
      checkPendingAutoBidAutofill,
      getState: () => ({ _activeResumeId, _manualResumeSelection, _autoBidContinuationActive }),
    };
    `,
  );
  return { ...factory(chrome, store), store };
}

describe('checkPendingAutoBidAutofill — keeps the Auto-Bid resume across a page hop', () => {
  it('restores the AI-picked resume and keeps it after the panel reloads stored state', async () => {
    const { checkPendingAutoBidAutofill, getState, store } = buildHarness({ storedActive: 'keyword-top', pendingResumeId: 'ai-picked' });

    await checkPendingAutoBidAutofill();

    expect(getState()._activeResumeId).toBe('ai-picked');
    expect(store.activeResumeId).toBe('ai-picked');
    expect(store.rawResumeBase64).toBe('BBB');
    expect(store.resumeFileType).toBe('docx');
  });

  it('pins the selection so later re-ranking passes (scanResumeMatch / ensureBestResumeSelected) leave it alone', async () => {
    const { checkPendingAutoBidAutofill, getState } = buildHarness({ storedActive: 'keyword-top', pendingResumeId: 'ai-picked' });

    await checkPendingAutoBidAutofill();

    // The continuation flag is already back to false (Workday's dialog hop
    // returns immediately) — the manual-selection pin is what still holds.
    expect(getState()._autoBidContinuationActive).toBe(false);
    expect(getState()._manualResumeSelection).toBe(true);
  });
});
