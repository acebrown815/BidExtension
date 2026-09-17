// lib/fakeVisible.js is a document_start content script (see manifest.json)
// that makes every page believe it's always visible, regardless of the
// actual browser tab's active/background state. This is needed because
// background.js's Auto-Bid feature opens pending job postings in
// background tabs (active: false, to avoid repeatedly stealing window
// focus while batching), and some ATS platforms (confirmed on Dover,
// app.dover.com) defer their own job-description data fetch until the
// page believes it's actually visible — without this override, the JD
// never renders in time for resume ranking to have anything to score
// against, silently breaking the multi-resume compare feature.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const FAKE_VISIBLE_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'fakeVisible.js');
const source = fs.readFileSync(FAKE_VISIBLE_JS_PATH, 'utf8');

function runFakeVisible() {
  // eslint-disable-next-line no-eval
  (0, eval)(source);
}

describe('lib/fakeVisible.js', () => {
  beforeEach(() => {
    // Reset to real defaults between tests — some environments allow
    // redefining these as configurable, which is exactly what the script
    // relies on.
    try { delete document.hidden; } catch (_) {}
    try { delete document.visibilityState; } catch (_) {}
  });

  it('overrides document.hidden to always report false', () => {
    runFakeVisible();
    expect(document.hidden).toBe(false);
  });

  it('overrides document.visibilityState to always report "visible"', () => {
    runFakeVisible();
    expect(document.visibilityState).toBe('visible');
  });

  it('suppresses a real visibilitychange event from reaching page listeners', () => {
    runFakeVisible();
    let sawEvent = false;
    document.addEventListener('visibilitychange', () => { sawEvent = true; });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sawEvent).toBe(false);
  });

  it('never throws even if run twice (re-defining already-overridden properties)', () => {
    expect(() => { runFakeVisible(); runFakeVisible(); }).not.toThrow();
    expect(document.hidden).toBe(false);
    expect(document.visibilityState).toBe('visible');
  });
});
