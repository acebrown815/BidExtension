// Live on ngc.wd1.myworkdayjobs.com: Auto-Bid reached the Review step
// (footer button "Submit") but never clicked it. A Workday application's
// pages didn't share the posting's cache key (".../apply/autofillWithResume",
// often with an "/en-US/" prefix), so on a freshly loaded application page
// there was no analysis — no match score — and auto-submit declined.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeUrlForCache as mjsNormalize } from '../../lib/urlKey.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8').replace(/\r\n/g, '\n');
const slice = (a, b) => {
  const start = SRC.indexOf(a);
  const end = SRC.indexOf(b, start);
  if (start === -1 || end === -1) throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  return SRC.slice(start, end);
};

const POSTING = 'https://ngc.wd1.myworkdayjobs.com/northrop_grumman_external_site/job/United-States-Remote/Principal-Software-Engineer---Insights---Intelligence_R10254773';
const CONTINUE_LINK = 'https://ngc.wd1.myworkdayjobs.com/en-US/northrop_grumman_external_site/job/United-States-Remote/Principal-Software-Engineer---Insights---Intelligence_R10254773/apply';
const APPLY_STEP = CONTINUE_LINK + '/autofillWithResume';

let jsNormalize;
beforeAll(async () => {
  await import('../../lib/urlKey.js');
  jsNormalize = globalThis.JMUrlKey.normalizeUrlForCache;
});

describe('normalizeUrlForCache — a Workday application shares its posting\'s key', () => {
  it.each([
    ['the "Continue Application" link', CONTINUE_LINK],
    ['an application step', APPLY_STEP],
    ['the applyManually step', CONTINUE_LINK + '/applyManually'],
  ])('%s', (_, url) => {
    expect(jsNormalize(url)).toBe(jsNormalize(POSTING));
    expect(mjsNormalize(url)).toBe(mjsNormalize(POSTING));
  });

  it('keeps different postings apart, and leaves other sites alone', () => {
    expect(jsNormalize(POSTING.replace('R10254773', 'R10254774'))).not.toBe(jsNormalize(POSTING));
    expect(jsNormalize('https://acme.com/en-US/jobs/1/apply/step')).toBe('https://acme.com/en-US/jobs/1/apply/step');
  });
});

describe('hasVisibleValidationErrors — status announcements are not errors', () => {
  let hasVisibleValidationErrors;
  beforeAll(() => {
    const code = slice('  function hasVisibleValidationErrors() {', '  /**\n   * A cheap fingerprint of which wizard step');
    hasVisibleValidationErrors = new Function(`${code} return hasVisibleValidationErrors;`)(); // eslint-disable-line no-new-func
  });

  it('ignores Workday\'s "page is loaded" and "successfully uploaded" announcements', () => {
    document.body.innerHTML = '<span role="alert">Review page is loaded</span>'
      + '<div role="alert" aria-live="polite">Resume_Devin.docx successfully uploaded</div>';
    expect(hasVisibleValidationErrors()).toBe(false);
  });

  it('still sees a real error alert', () => {
    document.body.innerHTML = '<span role="alert">Review page is loaded</span><div role="alert">The field Degree is required and must have a value.</div>';
    expect(hasVisibleValidationErrors()).toBe(true);
  });
});

describe('recoverCachedAnalysis — the analysis for a freshly loaded application page', () => {
  let store;
  const load = (activeResumeId) => {
    const code = slice('  async function recoverCachedAnalysis() {', '  async function autoSubmitApplicationIfReady(');
    return new Function('chrome', 'normalizeUrl', 'activeId', ` // eslint-disable-line no-new-func
      let currentAnalysis = null;
      const _activeResumeId = activeId;
      const _autoBidOriginalLink = null;
      const CACHE_STORAGE_KEY = 'jm_analysisCache';
      const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
      ${code}
      return { recoverCachedAnalysis, current: () => currentAnalysis };
    `)({ storage: { local: { get: async (k) => ({ [k]: store }) } } }, jsNormalize, activeResumeId);
  };

  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    store = {
      [jsNormalize(POSTING) + '::r_other']: { analysis: { matchScore: 70 }, timestamp: Date.now() - 1000 },
      [jsNormalize(POSTING) + '::r_best']: { analysis: { matchScore: 88 }, timestamp: Date.now() - 5000 },
      [jsNormalize(POSTING.replace('R10254773', 'R1')) + '::r_best']: { analysis: { matchScore: 99 }, timestamp: Date.now() },
    };
  });

  const withLocation = async (url, fn) => {
    const original = window.location.href;
    Object.defineProperty(window, 'location', { value: new URL(url), configurable: true });
    try { return await fn(); } finally { Object.defineProperty(window, 'location', { value: new URL(original), configurable: true }); }
  };

  it('finds the posting\'s analysis for the selected resume from an application step', async () => {
    await withLocation(APPLY_STEP, async () => {
      const api = load('r_best');
      const analysis = await api.recoverCachedAnalysis();
      expect(analysis.matchScore).toBe(88);
      expect(api.current().url).toBe(APPLY_STEP);
    });
  });

  it('falls back to the most recent analysis for this job', async () => {
    await withLocation(APPLY_STEP, async () => {
      expect((await load('r_unknown').recoverCachedAnalysis()).matchScore).toBe(70);
    });
  });

  it('ignores expired entries', async () => {
    for (const k of Object.keys(store)) store[k].timestamp = Date.now() - 25 * 60 * 60 * 1000;
    await withLocation(APPLY_STEP, async () => {
      expect(await load('r_best').recoverCachedAnalysis()).toBe(null);
    });
  });
});
