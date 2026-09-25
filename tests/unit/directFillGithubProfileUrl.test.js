// Regression test for a real bug found live on a Greenhouse-hosted careers
// form (job-boards.greenhouse.io/alpaca/...): its "Github/Gitlab Profile
// URL" field was being filled with the user's LinkedIn URL.
//
// Two real, separate issues were found and fixed together:
//
// 1. `profile.github` was never actually populated anywhere in the app —
//    no #pGithub input in profile.html, no `github` key in profileData's
//    default shape, and the AI resume-parser's extraction schema never
//    asked for one either — so directFill.js's profileMap lookup for
//    "github profile url" was always ''. Fixed by wiring up a real
//    `profile.github` field end-to-end (profile.html input, profileData
//    shape, resume-parser schema).
//
// 2. The ACTUAL confirmed root cause of the live bug: with profile.github
//    empty, matchQA() fell through to the saved-Q&A search, and
//    lib/qaMatch.js's qaQuestionMatchesLabel() FALSE-matched the saved
//    "LinkedIn Profile URL" answer against the page's "Github/Gitlab
//    Profile URL" label. The label's "/" gets tokenized into "github" +
//    "gitlab", and after that the only words the two questions share are
//    "profile" and "url" — generic filler present in nearly every
//    "<platform> Profile URL" question, but they hit the matcher's
//    >=2-shared-keyword bar anyway. Fixed by adding 'profile'/'url'/'link'
//    to STOP_WORDS in lib/qaMatch.js (see tests/unit/qaMatch.test.js for
//    the matcher-level regression tests) — this was the actual leak; #1
//    alone would not have stopped it, since Q&A fallback runs regardless
//    of whether profile.github exists.
//
// This file covers the directFill.js integration: once `profile.github`
// exists it's used directly, and separately, a saved LinkedIn Q&A answer
// must never leak into a GitHub field's fallback match.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIRECT_FILL_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'directFill.js');

beforeEach(async () => {
  await import('../../lib/qaMatch.js');
  await import('../../lib/radioGroupLabel.js');
});

function loadDirectFill() {
  const src = fs.readFileSync(DIRECT_FILL_PATH, 'utf8');
  // eslint-disable-next-line no-eval
  (0, eval)(src);
}

const GREENHOUSE_URL_FIELDS_HTML = `
<input id="linkedin-0" type="text" value="">
<label for="linkedin-0">LinkedIn Profile URL</label>
<input id="github-0" type="text" value="">
<label for="github-0">GitHub Profile URL</label>
<input id="website-0" type="text" value="">
<label for="website-0">Portfolio / Personal Website URL</label>
`;

describe('Direct-fill keeps LinkedIn/GitHub/Website URL fields distinct (the actual bug)', () => {
  beforeEach(() => {
    document.body.innerHTML = GREENHOUSE_URL_FIELDS_HTML;
    delete window.__jobMatchDirectFill;
    delete globalThis.JMFieldFilter;
    loadDirectFill();
  });

  it('fills each field with its own profile value when all three are set', async () => {
    const profile = {
      linkedin: 'https://linkedin.com/in/randolph',
      github: 'https://github.com/randolph',
      website: 'https://randolph.dev',
    };
    await window.__jobMatchDirectFill([], profile);
    expect(document.getElementById('linkedin-0').value).toBe('https://linkedin.com/in/randolph');
    expect(document.getElementById('github-0').value).toBe('https://github.com/randolph');
    expect(document.getElementById('website-0').value).toBe('https://randolph.dev');
  });

  it('leaves the GitHub field blank (not the LinkedIn URL) when profile.github is unset', async () => {
    const profile = {
      linkedin: 'https://linkedin.com/in/randolph',
      website: 'https://randolph.dev',
      // no github
    };
    await window.__jobMatchDirectFill([], profile);
    expect(document.getElementById('linkedin-0').value).toBe('https://linkedin.com/in/randolph');
    expect(document.getElementById('github-0').value).toBe(''); // must NOT be the LinkedIn URL
    expect(document.getElementById('website-0').value).toBe('https://randolph.dev');
  });

  // profileMap falling through to '' for 'github profile url' isn't the end
  // of the road — matchQA() then searches the saved Q&A list for a question
  // matching the label, exactly the way it already does for any other
  // field. A user who has manually saved an answer for the built-in
  // "GitHub Profile URL" Q&A question (profile.js's DEFAULT_QA_QUESTIONS)
  // gets it filled from there, with no code changes needed for this case.
  it('falls back to a saved Q&A answer for "GitHub Profile URL" when profile.github is unset', async () => {
    const profile = {
      linkedin: 'https://linkedin.com/in/randolph',
      website: 'https://randolph.dev',
      // no github
    };
    const qaList = [{ question: 'GitHub Profile URL', answer: 'https://github.com/from-qa-answer' }];
    await window.__jobMatchDirectFill(qaList, profile);
    expect(document.getElementById('github-0').value).toBe('https://github.com/from-qa-answer');
    expect(document.getElementById('linkedin-0').value).toBe('https://linkedin.com/in/randolph');
  });
});

// The exact real-world scenario from the bug report: the live Greenhouse
// form's field label is "Github/Gitlab Profile URL*" (with the "/" and a
// required-marker asterisk getElementLabel already strips), profile.github
// is unset, and the user has a saved "LinkedIn Profile URL" Q&A answer —
// the combination that produced the live false match.
describe('Direct-fill: the exact live Greenhouse bug ("Github/Gitlab Profile URL")', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <input id="q_20108341004" type="text" value="">
      <label for="q_20108341004">Github/Gitlab Profile URL<span aria-hidden="true">*</span></label>
      <input id="q_20108342004" type="text" value="">
      <label for="q_20108342004">LinkedIn Profile</label>
    `;
    delete window.__jobMatchDirectFill;
    delete globalThis.JMFieldFilter;
    loadDirectFill();
  });

  it('leaves the GitHub/GitLab field blank rather than filling it with the saved LinkedIn Q&A answer', async () => {
    const profile = {}; // profile.github and profile.linkedin both unset — matches the live report
    const qaList = [{ question: 'LinkedIn Profile URL', answer: 'https://linkedin.com/in/randolph-brown-34286528b' }];
    await window.__jobMatchDirectFill(qaList, profile);
    expect(document.getElementById('q_20108341004').value).toBe(''); // must NOT be the LinkedIn URL
    expect(document.getElementById('q_20108342004').value).toBe('https://linkedin.com/in/randolph-brown-34286528b'); // LinkedIn's own field still fills correctly
  });
});
