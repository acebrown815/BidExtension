// Regression test for the actual root cause of a real Auto-Bid bug (found
// only after extensive live debugging — see git history / conversation for
// the two earlier, insufficient fixes this superseded).
//
// After checkPendingAutoBidAutofill() restores currentAnalysis on a page
// reached via an Apply-click continuation (e.g. Dice's application
// wizard), something kept wiping it back to null before
// attachCoverLetterFile() could use it. Guarding ensureBestResumeSelected()
// (the first suspect) wasn't enough: scanResumeMatch() — fired
// fire-and-forget from handleSpaUrlChanged()'s reset block, which runs
// BEFORE checkPendingAutoBidAutofill ever sets the continuation flag —
// was already mid-flight by the time the flag became true. Its own await
// on getConfidentJobDescriptionForRanking() meant it didn't reach its
// switchSlot(top.id, {silent:true}) call until AFTER the continuation had
// already started, so a per-caller guard could never catch it: whichever
// caller happens to still be "in flight" from before the flag existed
// slips through regardless of where you gate its own entry point.
//
// The only reliable fix is a single, central guard inside switchSlot()
// itself — checked at the moment it actually runs, not at whenever its
// caller happened to start — since switchSlot() is what wipes
// currentAnalysis (any silent switch with no cached analysis for the
// resume+URL pair, which there never is on a brand-new wizard URL) AND
// what would otherwise silently swap _activeResumeId away from the
// resume the original page's analysis was actually computed for.
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom (see contentRadioGroupLabel.test.js), so this
// extracts just switchSlot() by source range and evals it with small
// stand-ins for its dependencies.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');
const SRC = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

const START_MARKER = 'async function switchSlot(id, opts) {';
const END_MARKER = '\n\n  // ─── Panel toggle';
const START = SRC.indexOf(START_MARKER);
const END = SRC.indexOf(END_MARKER);
if (START === -1 || END === -1 || END <= START) {
  throw new Error('content.js source anchors moved — update this test\'s extraction markers');
}
const FN_SRC = SRC.slice(START, END);

/**
 * Builds a runnable switchSlot() with stubbed dependencies.
 * @param {Object}   opts
 * @param {boolean}  opts.continuationActive - _autoBidContinuationActive's starting value.
 * @param {string}   opts.activeResumeId - the currently-active resume id.
 * @param {Object}   opts.currentAnalysis - currentAnalysis's starting value.
 * @param {Function} [opts.onStorageGet] - called (with a setContinuationActive
 *   setter) right as chrome.storage.local.get resolves — used to simulate the
 *   flag flipping DURING switchSlot's own internal await, after its entry
 *   check already passed.
 */
function buildSwitchSlot({ continuationActive, activeResumeId, currentAnalysis, onStorageGet }) {
  const factory = new Function( // eslint-disable-line no-new-func
    'startingAnalysis', 'continuationActive', 'activeResumeId', 'onStorageGet',
    `
    let _autoBidContinuationActive = continuationActive;
    let _activeResumeId = activeResumeId;
    let _resumes = [];
    let currentAnalysis = startingAnalysis;
    const shadowRoot = { getElementById: () => null };
    const setContinuationActive = (v) => { _autoBidContinuationActive = v; };
    const chrome = {
      storage: {
        local: {
          get: async () => {
            if (onStorageGet) onStorageGet(setContinuationActive);
            return { resumes: [{ id: 'r1', profile: {} }, { id: 'r2', profile: {} }] };
          },
          set: async () => {},
        },
      },
    };
    function renderSlotSwitcher() {}
    async function getCachedAnalysis() { return null; }
    function renderCachedAnalysis() {}
    function normalizeUrl(u) { return u; }
    function setStatus() {}
    function clearStatus() {}
    ${FN_SRC}
    return {
      switchSlot,
      getState: () => ({ currentAnalysis, _activeResumeId }),
    };
    `,
  );
  return factory(currentAnalysis, continuationActive, activeResumeId, onStorageGet);
}

describe('switchSlot — Auto-Bid continuation guard (the actual fix)', () => {
  it('is a complete no-op while an Auto-Bid continuation is active — the real bug', async () => {
    const restoredAnalysis = { matchScore: 78, company: 'Donato Technologies Inc' };
    const { switchSlot, getState } = buildSwitchSlot({
      continuationActive: true,
      activeResumeId: 'r1',
      currentAnalysis: restoredAnalysis,
    });

    // Simulates scanResumeMatch() deciding — based on the wizard page's own
    // unreliable JD/title extraction — that a DIFFERENT resume should be
    // active, and calling switchSlot exactly as it would mid-continuation.
    await switchSlot('r2', { silent: true });

    const state = getState();
    expect(state.currentAnalysis).toBe(restoredAnalysis); // untouched
    expect(state._activeResumeId).toBe('r1'); // untouched
  });

  it('bails before mutating anything if the continuation flag flips TRUE during its own internal await (the actual live bug)', async () => {
    // This is what really happened: scanResumeMatch() called switchSlot()
    // while _autoBidContinuationActive was still false (entry check
    // passes), then checkPendingAutoBidAutofill() set the flag true WHILE
    // switchSlot() was sitting on its own "await chrome.storage.local.get"
    // call. A guard checked only once, at entry, can never catch this —
    // it has to be re-checked after every await that precedes a mutation.
    const restoredAnalysis = { matchScore: 78 };
    const { switchSlot, getState } = buildSwitchSlot({
      continuationActive: false, // false at the moment switchSlot() is called
      activeResumeId: 'r1',
      currentAnalysis: restoredAnalysis,
      onStorageGet: (setContinuationActive) => setContinuationActive(true), // flips mid-flight
    });

    await switchSlot('r2', { silent: true });

    const state = getState();
    expect(state.currentAnalysis).toBe(restoredAnalysis); // untouched
    expect(state._activeResumeId).toBe('r1'); // untouched — never switched
  });

  it('still switches normally (and wipes currentAnalysis) when no continuation is active', async () => {
    const { switchSlot, getState } = buildSwitchSlot({
      continuationActive: false,
      activeResumeId: 'r1',
      currentAnalysis: { matchScore: 78 },
    });

    await switchSlot('r2', { silent: true });

    const state = getState();
    expect(state.currentAnalysis).toBeNull();
    expect(state._activeResumeId).toBe('r2');
  });
});
