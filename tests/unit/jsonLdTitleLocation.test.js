// Regression test for a real bug: on Workday-hosted job postings
// (confirmed on https://gdit.wd5.myworkdayjobs.com/.../job/...), the
// visible <h1> title and location are 100% client-rendered — fetching the
// raw page (no JS executed) shows <title></title> is empty and there is
// no data-automation-id anywhere in the initial HTML at all. Meanwhile the
// full job description IS already available immediately via schema.org
// JSON-LD (and <meta property="og:description">), which
// extractJobDescriptionConfident() already used as a fallback — so
// waitForJobDescriptionReady() (which only checks JD readiness) returns
// almost instantly while the title/location are still genuinely blank
// everywhere else on the page, and Auto-Bid's automated analysis proceeds
// with a correct JD but an empty title/location.
//
// extractCompany() already had a JSON-LD fallback for hiringOrganization.name
// for this exact reason; extractJobTitle()/extractLocation() didn't. Fix:
// both now also fall back to <meta property="og:title"> / JSON-LD
// (title, jobLocation.address) via the new findJobPostingLdJson() helper.
//
// content.js is a large content script that isn't practical to load
// wholesale under happy-dom (see contentRadioGroupLabel.test.js), so this
// extracts findJobPostingLdJson()/extractJobTitle()/extractLocation() by
// source range (non-contiguous in the file, concatenated here) and evals
// them together.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');

let combinedSrc;

beforeAll(() => {
  const src = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

  const ldStart = src.indexOf('function findJobPostingLdJson() {');
  const ldEnd = src.indexOf("/**\n   * Like `el.innerText`,");
  if (ldStart === -1 || ldEnd === -1 || ldEnd <= ldStart) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers (findJobPostingLdJson)');
  }

  const titleStart = src.indexOf('function extractJobTitle() {');
  const titleEnd = src.indexOf('/**\n   * Extracts company name using multiple strategies in priority order.');
  if (titleStart === -1 || titleEnd === -1 || titleEnd <= titleStart) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers (extractJobTitle)');
  }

  const locStart = src.indexOf('function extractLocation() {');
  const locEnd = src.indexOf('/**\n   * @returns {string} Human-language requirements extracted from the page');
  if (locStart === -1 || locEnd === -1 || locEnd <= locStart) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers (extractLocation)');
  }

  combinedSrc = [
    src.slice(ldStart, ldEnd),
    src.slice(titleStart, titleEnd),
    src.slice(locStart, locEnd),
  ].join('\n');
});

function buildHarness() {
  // eslint-disable-next-line no-eval
  const factory = (0, eval)(`(function () {
    ${combinedSrc}
    return { findJobPostingLdJson, extractJobTitle, extractLocation };
  })`);
  return factory();
}

// Trimmed structure matching the real Workday apply page — empty <title>,
// no matching DOM selector for title/location, but a full JobPosting
// JSON-LD block plus an og:title meta tag, both present in the raw HTML
// before any client JS runs.
function makeWorkdayPage() {
  document.title = '';
  document.head.innerHTML = `
    <meta property="og:title" content="Senior Full Stack Developer">
    <script type="application/ld+json">
      {
        "@type": "JobPosting",
        "title": "Senior Full Stack Developer",
        "description": "<p>We are seeking a highly skilled Senior Developer...</p>",
        "hiringOrganization": { "@type": "Organization", "name": "GD Information Technology, Inc." },
        "jobLocation": {
          "@type": "Place",
          "address": {
            "@type": "PostalAddress",
            "addressLocality": "USA VA Home Office (VAHOME)",
            "addressCountry": "United States of America"
          }
        }
      }
    </script>
  `;
  document.body.innerHTML = `<div id="app"></div>`; // the entire visible page is still an empty SPA shell
}

describe('extractJobTitle — Workday: title unrenderable, og:title/JSON-LD available immediately', () => {
  it('falls back to og:title when no selector matches and <title> is empty', () => {
    makeWorkdayPage();
    const { extractJobTitle } = buildHarness();
    expect(extractJobTitle()).toBe('Senior Full Stack Developer');
  });

  it('falls back to JSON-LD title when og:title is also absent', () => {
    makeWorkdayPage();
    document.head.querySelector('meta[property="og:title"]').remove();
    const { extractJobTitle } = buildHarness();
    expect(extractJobTitle()).toBe('Senior Full Stack Developer');
  });

  it('still returns "" (not a false match) when neither the DOM, og:title, nor JSON-LD have anything usable', () => {
    document.title = '';
    document.head.innerHTML = '';
    document.body.innerHTML = '<div id="app"></div>';
    const { extractJobTitle } = buildHarness();
    expect(extractJobTitle()).toBe('');
  });
});

describe('extractLocation — Workday: JSON-LD jobLocation fallback', () => {
  it('builds a readable location string from JSON-LD when no selector matches', () => {
    makeWorkdayPage();
    const { extractLocation } = buildHarness();
    expect(extractLocation()).toBe('USA VA Home Office (VAHOME), United States of America');
  });

  it('takes the first entry when jobLocation is an array of Places', () => {
    document.title = '';
    document.head.innerHTML = `
      <script type="application/ld+json">
        {
          "@type": "JobPosting",
          "jobLocation": [
            { "@type": "Place", "address": { "addressLocality": "Remote", "addressCountry": "USA" } },
            { "@type": "Place", "address": { "addressLocality": "Reston, VA" } }
          ]
        }
      </script>
    `;
    document.body.innerHTML = `<div id="app"></div>`;
    const { extractLocation } = buildHarness();
    expect(extractLocation()).toBe('Remote, USA');
  });

  it('returns "" when there is no JSON-LD and no matching selector', () => {
    document.title = '';
    document.head.innerHTML = '';
    document.body.innerHTML = '<div id="app"></div>';
    const { extractLocation } = buildHarness();
    expect(extractLocation()).toBe('');
  });
});

describe('findJobPostingLdJson', () => {
  it('finds a JobPosting inside a top-level @graph-style array', () => {
    document.head.innerHTML = `
      <script type="application/ld+json">
        [
          { "@type": "Organization", "name": "Unrelated" },
          { "@type": "JobPosting", "title": "Backend Engineer" }
        ]
      </script>
    `;
    document.body.innerHTML = '';
    const { findJobPostingLdJson } = buildHarness();
    const postings = findJobPostingLdJson();
    expect(postings.length).toBe(1);
    expect(postings[0].title).toBe('Backend Engineer');
  });

  it('does not throw on malformed JSON and returns an empty array', () => {
    document.head.innerHTML = `<script type="application/ld+json">{ not valid json </script>`;
    document.body.innerHTML = '';
    const { findJobPostingLdJson } = buildHarness();
    expect(findJobPostingLdJson()).toEqual([]);
  });
});
