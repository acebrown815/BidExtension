// Regression test for a real Auto-Bid bug found live: after
// checkPendingAutoBidAutofill() successfully restores currentAnalysis on a
// page reached via an Apply-click continuation (e.g. Dice's application
// wizard, which has no reliable job title/JD extraction of its own),
// autofillForm()'s Step 0 calls ensureBestResumeSelected() — which
// re-ranks resumes against THIS page's own (unreliable) title extraction.
// When that re-ranking picks a "different" top resume than the one
// already active, it calls switchSlot(id, {silent:true}), which
// UNCONDITIONALLY resets currentAnalysis back to null (there's no cached
// analysis yet for that resume+URL pair) — silently destroying the
// just-restored analysis moments before attachCoverLetterFile() needed it.
// Confirmed live via console logging: no second SPA navigation event was
// involved at all — this alone fully explained it.
//
// Fix: ensureBestResumeSelected() now returns immediately (never re-ranks,
// never calls switchSlot) while an Auto-Bid continuation is active — we
// already know exactly which resume the ORIGINAL page's analysis used.
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom (see contentRadioGroupLabel.test.js), so this
// extracts just ensureBestResumeSelected() by source range and evals it
// with small stand-ins for its dependencies.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');
const SRC = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

const START_MARKER = 'async function ensureBestResumeSelected() {';
const END_MARKER = '\n  /**\n   * Builds a File for the currently active resume';
const START = SRC.indexOf(START_MARKER);
const END = SRC.indexOf(END_MARKER);
if (START === -1 || END === -1 || END <= START) {
  throw new Error('content.js source anchors moved — update this test\'s extraction markers');
}
const FN_SRC = SRC.slice(START, END);

/**
 * Builds a runnable ensureBestResumeSelected() with stubbed dependencies.
 * @param {Object} opts
 * @param {boolean} opts.manualSelection - _manualResumeSelection's starting value.
 * @param {boolean} opts.continuationActive - _autoBidContinuationActive's starting value.
 * @param {string}  opts.jd - what getConfidentJobDescriptionForRanking() resolves to.
 * @param {string}  opts.topResumeId - the id rankResumes() should put first.
 * @param {string}  opts.activeResumeId - the currently-active resume id (both storage and in-memory).
 * @param {Array}   opts.calls - array this call pushes tagged events onto.
 */
function buildEnsureBestResumeSelected({
  manualSelection, continuationActive, jd, topResumeId, activeResumeId, calls,
}) {
  global.chrome = {
    storage: {
      local: {
        get: async () => ({
          resumes: [{ id: 'r1' }, { id: 'r2' }],
          activeResumeId,
        }),
      },
    },
  };

  const factory = new Function( // eslint-disable-line no-new-func
    'jd', 'topResumeId', 'activeResumeId', 'calls',
    `
    let _manualResumeSelection = ${manualSelection};
    let _autoBidContinuationActive = ${continuationActive};
    let _activeResumeId = activeResumeId;
    async function getConfidentJobDescriptionForRanking() { return jd; }
    function extractJobTitle() { return 'whatever this page extracts'; }
    function rankResumes() { return [{ id: topResumeId, score: 0.9 }]; }
    async function switchSlot(id, opts) { calls.push({ type: 'switchSlot', id, opts }); _activeResumeId = id; }
    ${FN_SRC}
    return { ensureBestResumeSelected, getActiveResumeId: () => _activeResumeId };
    `,
  );
  return factory(jd, topResumeId, activeResumeId, calls);
}

describe('ensureBestResumeSelected — Auto-Bid continuation guard', () => {
  let calls;

  beforeEach(() => {
    calls = [];
  });

  it('never re-ranks or switches resumes while an Auto-Bid continuation is active (the real bug)', async () => {
    const { ensureBestResumeSelected, getActiveResumeId } = buildEnsureBestResumeSelected({
      manualSelection: false,
      continuationActive: true,
      jd: 'some cached job description',
      topResumeId: 'r2', // ranking WOULD pick a different resume than active...
      activeResumeId: 'r1',
      calls,
    });

    await ensureBestResumeSelected();

    expect(calls).toEqual([]); // switchSlot never called
    expect(getActiveResumeId()).toBe('r1'); // active resume untouched
  });

  it('still re-ranks and switches normally when no continuation is active', async () => {
    const { ensureBestResumeSelected, getActiveResumeId } = buildEnsureBestResumeSelected({
      manualSelection: false,
      continuationActive: false,
      jd: 'some cached job description',
      topResumeId: 'r2',
      activeResumeId: 'r1',
      calls,
    });

    await ensureBestResumeSelected();

    expect(calls).toEqual([{ type: 'switchSlot', id: 'r2', opts: { silent: true } }]);
    expect(getActiveResumeId()).toBe('r2');
  });

  it('still honors a manual resume selection over the continuation guard (both bail out, same result)', async () => {
    const { ensureBestResumeSelected, getActiveResumeId } = buildEnsureBestResumeSelected({
      manualSelection: true,
      continuationActive: false,
      jd: 'some cached job description',
      topResumeId: 'r2',
      activeResumeId: 'r1',
      calls,
    });

    await ensureBestResumeSelected();

    expect(calls).toEqual([]);
    expect(getActiveResumeId()).toBe('r1');
  });
});
