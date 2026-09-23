// Regression test for a real bug: selecting one EEOC custom-ARIA dropdown
// (e.g. "Hispanic/Latino") left the very next sibling dropdown ("Please
// identify your race") completely unfilled with no visible error. Phase 3
// (content.js) already processes custom dropdowns sequentially because
// opening one can affect another still mid-fill, but didn't account for a
// sibling field's own fill triggering the page's own React tree to
// re-render the whole form section — silently detaching and replacing the
// next field's originally-captured trigger element with a brand-new DOM
// node. Every subsequent focus()/click() on that stale, detached node did
// nothing, so the dropdown never even opened.
//
// Fix: fillCustomDropdown() now checks input.isConnected at the top and,
// if detached, re-queries the live element by its (React-stable) id
// before doing anything else.
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom, so this extracts just the new guard clause at
// the top of fillCustomDropdown() by source range, wraps it in a stand-in
// function that returns a marker once past the guard (isolating it from
// the rest of the real function's many other dependencies), and evals it.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');
const SRC = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

const START_MARKER = 'async function fillCustomDropdown(input, questionText) {';
const END_MARKER = '// Some location-autocomplete fields';
const START = SRC.indexOf(START_MARKER);
const END = SRC.indexOf(END_MARKER, START);
if (START === -1 || END === -1 || END <= START) {
  throw new Error('content.js source anchors moved — update this test\'s extraction markers');
}
// Everything from the function's opening brace up to (not including) the
// zip-code special case — i.e. just the new detachment-recovery guard.
const GUARD_SRC = SRC.slice(START, END);

function buildHarness({ inputId, freshElementId, freshInputIsConnected = true }) {
  const warnCalls = [];
  const factory = new Function( // eslint-disable-line no-new-func
    'document', 'warnCalls',
    `
    const console = { warn: (...args) => warnCalls.push(args), log: () => {} };
    ${GUARD_SRC}
      return 'PROCEEDED';
    }
    return { fillCustomDropdown };
    `,
  );

  // A detached input (never appended to document.body) with the given id.
  const detachedInput = document.createElement('input');
  detachedInput.id = inputId;
  Object.defineProperty(detachedInput, 'isConnected', { value: false, configurable: true });

  // Optionally place a "fresh" element with a matching id in the live document.
  if (freshElementId) {
    const fresh = document.createElement('input');
    fresh.id = freshElementId;
    Object.defineProperty(fresh, 'isConnected', { value: freshInputIsConnected, configurable: true });
    document.body.appendChild(fresh);
  }

  const { fillCustomDropdown } = factory(document, warnCalls);
  return { fillCustomDropdown, detachedInput, warnCalls };
}

describe('fillCustomDropdown — recovers from a detached trigger element (the actual bug)', () => {
  afterEach(() => {
    document.body.innerHTML = ''; // each test's "fresh" elements must not leak into the next
  });

  it('re-queries by id and proceeds when a fresh element with the same id exists in the document', async () => {
    const { fillCustomDropdown, detachedInput, warnCalls } = buildHarness({ inputId: 'race', freshElementId: 'race' });
    const result = await fillCustomDropdown(detachedInput, 'Please identify your race');
    expect(result).toBe('PROCEEDED');
    expect(warnCalls).toEqual([]);
  });

  it('logs a warning and bails out when the element is detached and no replacement can be found', async () => {
    const { fillCustomDropdown, detachedInput, warnCalls } = buildHarness({ inputId: 'race', freshElementId: null });
    const result = await fillCustomDropdown(detachedInput, 'Please identify your race');
    expect(result).toBe(false);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0][0]).toContain('trigger element detached');
    expect(warnCalls[0][1]).toBe('race');
  });

  it('proceeds immediately, without any lookup, when the element is already connected (no regression)', async () => {
    const connectedInput = document.createElement('input');
    connectedInput.id = 'hispanic_ethnicity';
    document.body.appendChild(connectedInput);
    const { fillCustomDropdown, warnCalls } = buildHarness({ inputId: 'unused' });
    const result = await fillCustomDropdown(connectedInput, 'Are you Hispanic/Latino?');
    expect(result).toBe('PROCEEDED');
    expect(warnCalls).toEqual([]);
  });
});
