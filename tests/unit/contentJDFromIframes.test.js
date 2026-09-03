// Regression test for the "0% ATS keyword match for every resume" bug on
// job postings that embed the real job description inside a cross-origin
// <iframe> — e.g. Greenhouse's job-boards.greenhouse.io/embed/job_app
// widget, used by many company career pages (reported live on
// https://www.precisely.com/careers-and-culture/us-jobs/job/?gh_jid=... ).
//
// Root cause: extractJobDescriptionConfident() only ever calls
// document.querySelector() against the CURRENT document. When the real JD
// text lives inside a cross-origin iframe, the top frame's document has no
// access to that iframe's DOM at all (browser same-origin policy — no
// selector fix can work around this). getConfidentJobDescriptionForRanking()
// — the function that feeds rankResumes() and drives the "Auto-selected...
// X% ATS keyword match" status/badges — had no fallback for this case and
// simply returned '', which scanResumeMatch() treats as "no JD", yielding a
// silent 0%/blank score for every saved resume.
//
// Fix: getJDFromIframes() asks the background service worker to broadcast
// an EXTRACT_JD_IN_FRAME request to every subframe of the tab (manifest.json's
// "all_frames": true means content.js is separately injected into that
// iframe too, and CAN read its own document there) and relay back the best
// match. getConfidentJobDescriptionForRanking()/getJobDescriptionForAnalysis()
// now try this before giving up (or falling back to the cross-tab cache /
// body-text scrape).
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom (see contentRadioGroupLabel.test.js), so this
// extracts just the JD-extraction functions by source range and evals them
// in isolation, with a stubbed `chrome.runtime.sendMessage`.
import {
  describe, it, expect, beforeEach, vi,
} from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');

let extractJobDescriptionConfident;
let getJobDescriptionForAnalysis;
let getConfidentJobDescriptionForRanking;
let getJDFromIframes;

// The routing map this test's fake chrome.runtime.sendMessage consults —
// reset before each test.
let routes;

beforeEach(() => {
  const src = fs.readFileSync(CONTENT_JS_PATH, 'utf8');

  const sendMessageStart = src.indexOf('function sendMessage(msg) {');
  const sendMessageEnd = src.indexOf('\n  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {');
  if (sendMessageStart === -1 || sendMessageEnd === -1 || sendMessageEnd <= sendMessageStart) {
    throw new Error('content.js source anchors moved — update this test\'s sendMessage extraction markers');
  }
  const sendMessageSrc = src.slice(sendMessageStart, sendMessageEnd);

  const jdStart = src.indexOf('function extractJobDescriptionConfident() {');
  const jdEnd = src.indexOf('/** @returns {string} The job title extracted from the page, or \'\'. */');
  if (jdStart === -1 || jdEnd === -1 || jdEnd <= jdStart) {
    throw new Error('content.js source anchors moved — update this test\'s JD-extraction extraction markers');
  }
  const jdSrc = src.slice(jdStart, jdEnd);

  const extracted = `${sendMessageSrc}\n${jdSrc}`;
  // eslint-disable-next-line no-eval
  const factory = (0, eval)(`(function () { ${extracted} return {
    extractJobDescriptionConfident, getJobDescriptionForAnalysis,
    getConfidentJobDescriptionForRanking, getJDFromIframes,
  }; })`);
  ({
    extractJobDescriptionConfident, getJobDescriptionForAnalysis,
    getConfidentJobDescriptionForRanking, getJDFromIframes,
  } = factory());

  routes = {};
  global.chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      sendMessage: (msg, cb) => {
        const handler = routes[msg.type];
        if (!handler) return cb({ success: false, error: `no route stubbed for ${msg.type}` });
        Promise.resolve()
          .then(() => handler(msg))
          .then((data) => cb({ success: true, data }))
          .catch((err) => cb({ success: false, error: err.message }));
      },
    },
  };
});

describe('getJDFromIframes / getConfidentJobDescriptionForRanking — cross-origin iframe JD (Greenhouse embed)', () => {
  it('falls back to a subframe\'s JD when the top frame has no confident JD of its own', async () => {
    document.body.innerHTML = '<div id="grnhse_app"></div>'; // the real content is in a cross-origin iframe we can't see
    const iframeJd = 'Senior Software Engineer (Ruby on Rails) — '.repeat(10); // >100 chars
    routes.GET_JD_FROM_FRAMES = () => ({ jd: iframeJd });

    expect(extractJobDescriptionConfident()).toBe(''); // nothing visible in the top document — reproduces the bug's starting condition
    await expect(getJDFromIframes()).resolves.toBe(iframeJd);
    await expect(getConfidentJobDescriptionForRanking()).resolves.toBe(iframeJd);
  });

  it('prefers the top frame\'s own confident JD and never asks the background worker for frames', async () => {
    document.body.innerHTML = `<div class="job-description">${'Real top-frame JD text. '.repeat(10)}</div>`;
    const spy = vi.fn(() => ({ jd: 'should not be used' }));
    routes.GET_JD_FROM_FRAMES = spy;

    const result = await getConfidentJobDescriptionForRanking();
    expect(result).toContain('Real top-frame JD text.');
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls through to this tab\'s cached JD (pre-existing behavior, unchanged) when no frame has a confident JD either', async () => {
    document.body.innerHTML = '<div id="grnhse_app"></div>';
    routes.GET_JD_FROM_FRAMES = () => ({ jd: '' });
    routes.GET_CACHED_TAB_JD = () => ({ jd: 'this tab\'s cached JD from an earlier step' });

    await expect(getConfidentJobDescriptionForRanking()).resolves.toBe('this tab\'s cached JD from an earlier step');
  });

  it('returns \'\' when neither this frame, any subframe, nor the tab cache has a JD', async () => {
    document.body.innerHTML = '<div id="grnhse_app"></div>';
    routes.GET_JD_FROM_FRAMES = () => ({ jd: '' });
    routes.GET_CACHED_TAB_JD = () => ({ jd: '' });

    await expect(getConfidentJobDescriptionForRanking()).resolves.toBe('');
  });

  it('getJobDescriptionForAnalysis() also picks up the iframe JD, and caches it for later steps of the posting', async () => {
    document.body.innerHTML = '<div id="grnhse_app"></div>';
    const iframeJd = 'Full posting text from the embedded Greenhouse iframe. '.repeat(5);
    routes.GET_JD_FROM_FRAMES = () => ({ jd: iframeJd });
    const cacheSpy = vi.fn(() => ({}));
    routes.CACHE_TAB_JD = cacheSpy;

    await expect(getJobDescriptionForAnalysis()).resolves.toBe(iframeJd);
    expect(cacheSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'CACHE_TAB_JD', jd: iframeJd }));
  });

  it('falls back to the cross-tab cache when neither this frame nor any subframe has a confident JD (getJobDescriptionForAnalysis)', async () => {
    document.body.innerHTML = '<div id="grnhse_app"></div>';
    routes.GET_JD_FROM_FRAMES = () => ({ jd: '' });
    routes.GET_CACHED_TAB_JD = () => ({ jd: 'cached JD from an earlier step of this same posting' });

    await expect(getJobDescriptionForAnalysis()).resolves.toBe('cached JD from an earlier step of this same posting');
  });
});
