// Regression test for a real bug found live on an Ashby-hosted application
// form: a field labeled "LinkedIn, Github, Personal Website or other
// social profile" is still a single-value `type="url"` input, but the AI
// — trying to be complete since the label lists several platforms —
// answered with BOTH the LinkedIn and GitHub URLs joined together. A
// `type="url"` input's own format validation rejects that outright (it's
// not a single valid URL), so the field showed text yet the ATS's
// submit-time validation reported it as invalid/missing anyway.
//
// The AI prompt now says not to do this (see aiService.js's
// buildAutofillPrompt TEXT/TEXTAREA rules), but that's not a guarantee —
// this tests the deterministic backstop in fillInput() itself: a
// `type="url"` input can only ever hold ONE valid URL, so if the value
// contains more than one URL-shaped token, only the first is kept.
//
// content.js is too large to load wholesale under happy-dom, so this
// extracts just fillInput() by source range and evals it directly.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');
const SRC = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

const START_MARKER = '  function fillInput(input, value) {';
const END_MARKER = '\n\n\n  // ─── Cover letter';
const START = SRC.indexOf(START_MARKER);
const END = SRC.indexOf(END_MARKER);
if (START === -1 || END === -1 || END <= START) {
  throw new Error('content.js source anchors moved — update this test\'s extraction markers');
}
const FN_SRC = SRC.slice(START, END);

// eslint-disable-next-line no-new-func
const fillInput = new Function(`${FN_SRC}\nreturn fillInput;`)();

function makeInput(type) {
  const el = document.createElement('input');
  el.type = type;
  document.body.appendChild(el);
  return el;
}

describe('fillInput — single-URL guard for type="url" inputs (the actual Ashby bug)', () => {
  it('keeps only the first URL when the AI joined two with a comma', () => {
    const el = makeInput('url');
    fillInput(el, 'https://linkedin.com/in/randolph-brown-34286528b, https://github.com/acebrown815');
    expect(el.value).toBe('https://linkedin.com/in/randolph-brown-34286528b');
  });

  it('keeps only the first URL when joined with "and" instead of a comma', () => {
    const el = makeInput('url');
    fillInput(el, 'https://linkedin.com/in/randolph and https://github.com/acebrown815');
    expect(el.value).toBe('https://linkedin.com/in/randolph');
  });

  it('leaves a single valid URL untouched (no regression)', () => {
    const el = makeInput('url');
    fillInput(el, 'https://linkedin.com/in/randolph-brown-34286528b');
    expect(el.value).toBe('https://linkedin.com/in/randolph-brown-34286528b');
  });

  it('does not touch a plain text field even if it happens to contain two URLs', () => {
    const el = makeInput('text');
    fillInput(el, 'https://linkedin.com/in/a, https://github.com/b');
    expect(el.value).toBe('https://linkedin.com/in/a, https://github.com/b');
  });

  // Live on Ashby: "Please provide relevant work samples you'd like to share
  // with the hiring team" (placeholder "https://example.com...") — with no
  // portfolio URL in the profile, the AI wrote a sentence, which the page
  // flagged as an invalid URL.
  it('refuses a prose answer with no URL in it, leaving the field empty', () => {
    const el = makeInput('url');
    const ok = fillInput(el, 'Portfolio/work samples available upon request (e.g., full-stack dashboards, REST/GraphQL API services, and cloud-native deployments).');
    expect(ok).toBe(false);
    expect(el.value).toBe('');
  });

  it('pulls the URL out of prose that contains one', () => {
    const el = makeInput('url');
    expect(fillInput(el, 'You can see my work at https://github.com/acebrown815.')).toBe(true);
    expect(el.value).toBe('https://github.com/acebrown815');
  });

  it('adds https:// to a bare domain answer', () => {
    const el = makeInput('url');
    fillInput(el, 'github.com/acebrown815');
    expect(el.value).toBe('https://github.com/acebrown815');
  });

  it('still fills plain text fields with prose', () => {
    const el = makeInput('text');
    expect(fillInput(el, 'Available upon request.')).toBe(true);
    expect(el.value).toBe('Available upon request.');
  });
});
