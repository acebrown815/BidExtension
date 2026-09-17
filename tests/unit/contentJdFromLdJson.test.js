// content.js is a large content script that isn't practical to load
// wholesale under happy-dom (see contentRadioGroupLabel.test.js), so this
// extracts extractJobDescriptionConfident() and its two new helpers by
// source range and evals them in isolation.
//
// Root cause: some ATS platforms (e.g. Dover, app.dover.com) render the job
// description inside CSS-in-JS class names with hashed/generated suffixes
// (e.g. "InboundApplication__JobDescriptionWrapper-gHhUWm",
// "styles__StyledHtmlWrapper-dYYysG") that no fixed selector list can
// anticipate, and don't wrap it in <main>/<article>/[role="main"]/.content/
// #content either — so extractJobDescriptionConfident()'s selector loop AND
// its "largest text block" fallback both found nothing, returning ''.
//
// The consequence was silent and total, several layers up: with no
// confident JD, scanResumeMatch() (content.js) never populates
// _resumeScores, so the ★ top-3-match badges never appear and Analyze
// Job's multi-resume AI compare (analyzeAndPickBest) never triggers — it
// looks like "the extension isn't comparing resumes" with no error anywhere.
//
// The fix: these platforms still emit schema.org JobPosting JSON-LD (for
// Google for Jobs / SEO) containing the full description as HTML, keyed by
// an explicit field name rather than a guessable class/id. This is tried
// as a fallback before the "largest text block" heuristic.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONTENT_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js');

let extractJobDescriptionConfident;
let extractJobDescriptionFromLdJson;
let jobPostingHtmlToText;

beforeAll(() => {
  const src = fs.readFileSync(CONTENT_JS_PATH, 'utf8');
  const startMarker = 'function jobPostingHtmlToText(html) {';
  const endMarker = '/**\n   * Extracts the full job description text from the current page. Tries';
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  }
  const extracted = src.slice(start, end);
  // eslint-disable-next-line no-eval
  const factory = (0, eval)(`(function () { ${extracted} return { extractJobDescriptionConfident, extractJobDescriptionFromLdJson, jobPostingHtmlToText }; })`);
  ({ extractJobDescriptionConfident, extractJobDescriptionFromLdJson, jobPostingHtmlToText } = factory());
});

const DOVER_DESCRIPTION_HTML = '<h2>Company Overview</h2><p>Cooperdyne Tech is a leading technology solutions provider.</p><h2>Key Responsibilities</h2><ul><li><p>Design and develop web applications using .NET 6+ and C#</p></li><li><p>Build and maintain REST APIs and microservices on Azure</p></li></ul>';

function doverPageHtml(descriptionHtml) {
  return `
    <script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org/',
      '@type': 'JobPosting',
      title: 'Senior Full Stack Developer (.NET)',
      description: descriptionHtml,
      hiringOrganization: { '@type': 'Organization', name: 'Cooperdyne Tech' },
    })}</script>
    <div id="root">
      <div class="InboundApplication__JobDescriptionWrapper-gHhUWm kSSTfi">
        <div class="css-ikzlcq">
          <div class="styles__StyledHtmlWrapper-dYYysG hYBBLV MuiBox-root css-0"></div>
        </div>
      </div>
    </div>
  `;
}

describe('content.js jobPostingHtmlToText', () => {
  it('strips tags while inserting newlines/bullets at block boundaries', () => {
    const text = jobPostingHtmlToText(DOVER_DESCRIPTION_HTML);
    expect(text).toContain('Company Overview');
    expect(text).toContain('• Design and develop web applications using .NET 6+ and C#');
    expect(text).toContain('• Build and maintain REST APIs and microservices on Azure');
    // Headings and list items must not run together with no separation
    expect(text).not.toMatch(/OverviewCooperdyne/);
  });

  it('returns empty string for empty/non-string input', () => {
    expect(jobPostingHtmlToText('')).toBe('');
    expect(jobPostingHtmlToText(null)).toBe('');
    expect(jobPostingHtmlToText(undefined)).toBe('');
  });
});

describe('content.js extractJobDescriptionFromLdJson', () => {
  it('finds a top-level JobPosting object\'s description', () => {
    document.body.innerHTML = doverPageHtml(DOVER_DESCRIPTION_HTML);
    const text = extractJobDescriptionFromLdJson();
    expect(text).toContain('Company Overview');
    expect(text).toContain('Design and develop web applications');
  });

  it('finds a JobPosting inside an array of JSON-LD objects', () => {
    document.body.innerHTML = `
      <script type="application/ld+json">${JSON.stringify([
        { '@type': 'Organization', name: 'Cooperdyne Tech' },
        { '@type': 'JobPosting', description: DOVER_DESCRIPTION_HTML },
      ])}</script>
    `;
    expect(extractJobDescriptionFromLdJson()).toContain('Company Overview');
  });

  it('returns empty string when no JobPosting JSON-LD is present', () => {
    document.body.innerHTML = '<div>no structured data here</div>';
    expect(extractJobDescriptionFromLdJson()).toBe('');
  });

  it('returns empty string when the description is too short to be confident', () => {
    document.body.innerHTML = `
      <script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', description: 'short' })}</script>
    `;
    expect(extractJobDescriptionFromLdJson()).toBe('');
  });

  it('never throws on malformed JSON-LD', () => {
    document.body.innerHTML = '<script type="application/ld+json">{not valid json</script>';
    expect(() => extractJobDescriptionFromLdJson()).not.toThrow();
    expect(extractJobDescriptionFromLdJson()).toBe('');
  });
});

describe('content.js extractJobDescriptionConfident — Dover-style pages', () => {
  it('falls back to JSON-LD when no selector or landmark element matches the markup', () => {
    document.body.innerHTML = doverPageHtml(DOVER_DESCRIPTION_HTML);
    const jd = extractJobDescriptionConfident();
    expect(jd).toContain('Company Overview');
    expect(jd.length).toBeGreaterThan(100);
  });

  it('still prefers a matching known-ATS selector over JSON-LD when both are present', () => {
    document.body.innerHTML = `
      <script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', description: '<p>WRONG SOURCE — should not be used</p>'.repeat(10) })}</script>
      <div class="job-description">${'Real selector-matched description. '.repeat(10)}</div>
    `;
    const jd = extractJobDescriptionConfident();
    expect(jd).toContain('Real selector-matched description');
    expect(jd).not.toContain('WRONG SOURCE');
  });

  it('returns empty string when neither selectors, landmarks, nor JSON-LD have a real JD', () => {
    document.body.innerHTML = '<div class="some-random-widget">Not a job description.</div>';
    expect(extractJobDescriptionConfident()).toBe('');
  });
});
