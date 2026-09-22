// Tests for highlightPrimaryLanguage() — wraps whole-word occurrences of
// the JD's single primary/mandatory language (from buildBulletRewritePrompt's
// "primaryLanguage" field) in a <mark> so it visually stands out in the
// Improved Resume Bullets list, over every other language/skill mentioned.
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom, so this extracts just the function by source
// range and evals it directly (it's a pure string function — no
// dependencies to stub).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');
const SRC = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

const START_MARKER = 'function highlightPrimaryLanguage(escapedHtml, term) {';
const END_MARKER = '\n\n  // ─── Initialize';
const START = SRC.indexOf(START_MARKER);
const END = SRC.indexOf(END_MARKER);
if (START === -1 || END === -1 || END <= START) {
  throw new Error('content.js source anchors moved — update this test\'s extraction markers');
}
const FN_SRC = SRC.slice(START, END);

// eslint-disable-next-line no-new-func
const highlightPrimaryLanguage = new Function(`${FN_SRC}\nreturn highlightPrimaryLanguage;`)();

describe('highlightPrimaryLanguage', () => {
  it('wraps a whole-word case-insensitive match in a <mark>', () => {
    expect(highlightPrimaryLanguage('Built services using Go and gRPC', 'Go'))
      .toBe('Built services using <mark class="jm-primary-lang">Go</mark> and gRPC');
  });

  it('matches case-insensitively but preserves the original casing in the output', () => {
    expect(highlightPrimaryLanguage('Built services using GO and grpc', 'go'))
      .toBe('Built services using <mark class="jm-primary-lang">GO</mark> and grpc');
  });

  it('highlights every occurrence, not just the first', () => {
    expect(highlightPrimaryLanguage('Go here, Go there, Go everywhere', 'Go'))
      .toBe('<mark class="jm-primary-lang">Go</mark> here, <mark class="jm-primary-lang">Go</mark> there, <mark class="jm-primary-lang">Go</mark> everywhere');
  });

  it('does not match "Go" as a substring of an unrelated word (word-boundary safe)', () => {
    expect(highlightPrimaryLanguage('Went to the Gopher convention', 'Go'))
      .toBe('Went to the Gopher convention');
  });

  it('returns the text unchanged when there is no primary language', () => {
    expect(highlightPrimaryLanguage('Built services using Go', '')).toBe('Built services using Go');
    expect(highlightPrimaryLanguage('Built services using Go', null)).toBe('Built services using Go');
    expect(highlightPrimaryLanguage('Built services using Go', undefined)).toBe('Built services using Go');
  });

  it('escapes a term containing regex-special characters safely', () => {
    expect(highlightPrimaryLanguage('Uses C++ and Go', 'C++'))
      .toBe('Uses <mark class="jm-primary-lang">C++</mark> and Go');
  });

  it('handles a multi-word term like "Objective-C" as one unit', () => {
    expect(highlightPrimaryLanguage('Built apps in Objective-C for years', 'Objective-C'))
      .toBe('Built apps in <mark class="jm-primary-lang">Objective-C</mark> for years');
  });
});
