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
let textExcludingForms;

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
  const factory = (0, eval)(`(function () { ${extracted} return { extractJobDescriptionConfident, extractJobDescriptionFromLdJson, jobPostingHtmlToText, textExcludingForms }; })`);
  ({ extractJobDescriptionConfident, extractJobDescriptionFromLdJson, jobPostingHtmlToText, textExcludingForms } = factory());
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

// Regression test for a live bug on a JazzHR/Resumator job board
// (invaluable.applytojob.com): the page has no ATS-specific selector match
// and no JSON-LD, so extractJobDescriptionConfident() fell through to the
// "largest text block" heuristic — and the ONLY landmark on the page is a
// single <main> that wraps BOTH the job description AND the entire
// application form (name/email/resume upload, EEO demographic questions,
// "Human Check", "Submit Application"). Two problems: (1) the form's own
// labels/options got sent to the AI as if they were job requirements, and
// (2) anything that changes the form's rendered state between visits
// (AutoFill filling fields, a "we've received your resume" message
// toggling) changed this "JD" text, which could shift which resumes
// landed in the local top-3 match set — silently orphaning
// previously-cached analyses for resumes that fell out of it, even though
// those cache entries were still perfectly valid. Fix: textExcludingForms()
// hides any nested <form> before reading .innerText.
const JAZZHR_STYLE_MAIN_HTML = `
  <h1>Senior Backend Engineer</h1>
  <p>${'Invaluable is a leading online auction marketplace. '.repeat(10)}</p>
  <form action="/apply" method="POST">
    <label>First Name *</label><input name="firstName">
    <label>Resume *</label>
    <div class="resume-status">We've received your resume. Click here to update it.</div>
    <label>Gender</label>
    <select><option>Decline to answer</option><option>Female</option><option>Male</option></select>
    <button type="submit">Submit Application</button>
  </form>
`;

describe('content.js textExcludingForms / JazzHR-style pages', () => {
  it('excludes a nested <form>\'s text from an element\'s innerText', () => {
    document.body.innerHTML = `<main>${JAZZHR_STYLE_MAIN_HTML}</main>`;
    const text = textExcludingForms(document.querySelector('main'));
    expect(text).toContain('Invaluable is a leading online auction marketplace');
    expect(text).not.toContain('First Name');
    expect(text).not.toContain('Submit Application');
    expect(text).not.toContain('Gender');
  });

  it('restores each form\'s original inline display style afterward', () => {
    document.body.innerHTML = `<main>${JAZZHR_STYLE_MAIN_HTML}</main>`;
    const form = document.querySelector('form');
    form.style.display = 'flex';
    textExcludingForms(document.querySelector('main'));
    expect(form.style.display).toBe('flex');
  });

  it('is a no-op (still returns full text) when there is no nested form', () => {
    document.body.innerHTML = '<main>Just a plain job description, no form here.</main>';
    expect(textExcludingForms(document.querySelector('main'))).toBe('Just a plain job description, no form here.');
  });

  it('extractJobDescriptionConfident excludes the application form on a page where <main> wraps both', () => {
    document.body.innerHTML = `<main>${JAZZHR_STYLE_MAIN_HTML}</main>`;
    const jd = extractJobDescriptionConfident();
    expect(jd).toContain('Invaluable is a leading online auction marketplace');
    expect(jd).not.toContain('Submit Application');
    expect(jd).not.toContain('Gender');
    expect(jd).not.toContain("We've received your resume");
  });

  it('extractJobDescriptionConfident stays stable whether or not the form has already been filled/toggled', () => {
    document.body.innerHTML = `<main>${JAZZHR_STYLE_MAIN_HTML}</main>`;
    const before = extractJobDescriptionConfident();
    // Simulate AutoFill (or the site itself) changing the form's rendered
    // state between visits — this must not change the extracted "JD".
    document.querySelector('input[name="firstName"]').value = 'Jane';
    document.querySelector('.resume-status').textContent = 'Resume attached: resume.pdf';
    const after = extractJobDescriptionConfident();
    expect(after).toBe(before);
  });
});
