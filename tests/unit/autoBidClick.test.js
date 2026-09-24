// Regression/generalization test for autoBidClick() — the shared helper
// every click in Auto-Bid's automated flow now routes through, requested
// by the user after two separate live bugs on Workday's 8-step wizard: a
// tailored resume survived one navigation only to be silently lost on the
// NEXT one, each time at a DIFFERENT specific click that hadn't been
// covered yet. Rather than keep discovering and special-casing each ATS's
// own intermediate dialogs/steps one click at a time, EVERY click Auto-Bid
// performs now stashes pending-autofill state (including an active
// tailored resume slot) first — this isn't limited to Workday.
//
// content.js is too large to load wholesale under happy-dom, so this
// extracts autoBidClick() by source range and evals it with small
// stand-ins for its dependencies.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');
const SRC = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

const START_MARKER = 'async function autoBidClick(el) {';
const END_MARKER = '\n\n  /**\n   * Finds a page\'s "Apply Now"-style';
const START = SRC.indexOf(START_MARKER);
const END = SRC.indexOf(END_MARKER);
if (START === -1 || END === -1 || END <= START) {
  throw new Error('content.js source anchors moved — update this test\'s extraction markers');
}
const FN_SRC = SRC.slice(START, END);

function buildHarness({ currentAnalysis = null, activeResumeId = 'r1', tailoredSlotActive = false, tailoredResumeSlot = null, sendMessageThrows = false } = {}) {
  const sendMessageCalls = [];
  const factory = new Function( // eslint-disable-line no-new-func
    'currentAnalysis', 'activeResumeId', 'tailoredSlotActive', 'tailoredResumeSlot', 'sendMessageCalls', 'sendMessageThrows',
    `
    const _activeResumeId = activeResumeId;
    const _tailoredSlotActive = tailoredSlotActive;
    const _tailoredResumeSlot = tailoredResumeSlot;
    async function sendMessage(msg) {
      sendMessageCalls.push(msg);
      if (sendMessageThrows) throw new Error('boom');
      return {};
    }
    ${FN_SRC}
    return autoBidClick;
    `,
  );
  return { autoBidClick: factory(currentAnalysis, activeResumeId, tailoredSlotActive, tailoredResumeSlot, sendMessageCalls, sendMessageThrows), sendMessageCalls };
}

describe('autoBidClick', () => {
  it('stashes analysis/active resume id via SET_PENDING_AUTOFILL, then clicks the element', async () => {
    const el = document.createElement('a');
    const clickSpy = vi.fn();
    el.addEventListener('click', clickSpy);
    const { autoBidClick, sendMessageCalls } = buildHarness({
      currentAnalysis: { matchScore: 88, company: 'Acme' },
      activeResumeId: 'resume-42',
    });

    await autoBidClick(el);

    expect(sendMessageCalls).toEqual([{
      type: 'SET_PENDING_AUTOFILL',
      analysis: { matchScore: 88, company: 'Acme' },
      activeResumeId: 'resume-42',
      tailoredResumeSlot: null,
    }]);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('includes the active tailored resume slot when one is active', async () => {
    const el = document.createElement('a');
    const tailoredResumeSlot = { name: 'Tailored', base64: 'ZmFrZQ==' };
    const { autoBidClick, sendMessageCalls } = buildHarness({ tailoredSlotActive: true, tailoredResumeSlot });

    await autoBidClick(el);

    expect(sendMessageCalls[0].tailoredResumeSlot).toEqual(tailoredResumeSlot);
  });

  it('sends null for the tailored resume slot when the slot is not active, even if one exists', async () => {
    const el = document.createElement('a');
    const { autoBidClick, sendMessageCalls } = buildHarness({
      tailoredSlotActive: false,
      tailoredResumeSlot: { name: 'Stale tailored slot' },
    });

    await autoBidClick(el);

    expect(sendMessageCalls[0].tailoredResumeSlot).toBeNull();
  });

  it('still clicks the element even if SET_PENDING_AUTOFILL fails (best-effort)', async () => {
    const el = document.createElement('a');
    const clickSpy = vi.fn();
    el.addEventListener('click', clickSpy);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { autoBidClick } = buildHarness({ sendMessageThrows: true });

    await autoBidClick(el);

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
