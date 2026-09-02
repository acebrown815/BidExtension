# JobMatch AI (BidExtension fork)

**Smart Chrome Extension for Job Seekers** — Analyze any job posting against your resume, get a match score and skill gap analysis, auto-fill applications, generate cover letters (with `.docx` / `.pdf` export), rewrite and tailor resume bullets, and track every job you apply to — including an optional sync of applied jobs to a Google Sheet.

This is a personal fork of [wadekarg/JobMatchAI](https://github.com/wadekarg/JobMatchAI), maintained at [acebrown815/BidExtension](https://github.com/acebrown815/BidExtension). It is **not** the version published on the Chrome Web Store — see [Installation](#installation-developer--local-build) below to load it unpacked. Key differences from the upstream project are called out throughout this document and summarized in [What's Different From Upstream](#whats-different-from-upstream).

![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)
![AI Powered](https://img.shields.io/badge/AI-Powered-blueviolet)
![License](https://img.shields.io/badge/License-MIT-blue)

<p align="center">
  <img src="screenshots/panel-overview.png" alt="JobMatch AI side panel open on a job posting, showing resume list and action buttons" width="900">
</p>
<p align="center"><em>JobMatch AI panel open on a job posting — resume switcher, one-click Analyze, AutoFill, Cover Letter, Improve Resume Bullets, and more.</em></p>

---

## Features

### Job Match Score & Skill Analysis

Upload your resume once. Navigate to any job posting, open the panel, and click **Analyze Job** to get a full breakdown in seconds.

<p align="center">
  <img src="screenshots/analysis-score.png" alt="Analysis results showing match score 75, matching skills, and missing skills" width="900">
</p>
<p align="center"><em>Analysis results — match score with color indicator, matching skills you already have, missing skills to address, and action buttons for every next step.</em></p>

- **Match Score (0–100)** — color-coded indicator so you can tell at a glance whether a role is worth pursuing
- **Matching Skills** — skills from your resume that the job requires
- **Missing Skills** — gaps between your profile and the job description
- **Insights** — a written strengths and gaps summary: what makes you a strong candidate and what to address before applying
- **ATS Keywords** — key terms the applicant tracking system is scanning for
- **Recommendations** — specific, actionable advice to improve your fit for that exact role

Results are cached per URL. You get a consistent score every session — click **Re-Analyze** any time to force a fresh evaluation.

---

### Recommendations & ATS Keywords

<p align="center">
  <img src="screenshots/recommendations-keywords.png" alt="Recommendations panel with detailed suggestions and ATS keyword chips" width="900">
</p>
<p align="center"><em>Recommendations with specific advice on how to strengthen your application, followed by the ATS keyword chips to incorporate into your resume and cover letter.</em></p>

---

### Smart Auto-Fill

Click **AutoFill Application** and the extension scans every field on the page and fills it in two passes: first directly from your saved Q&A answers (no AI call), then it sends whatever's still empty to the AI along with your resume profile and writes those answers straight into the form too — **there is no review/approve step before fields are written** in this fork (see below).

Every field AutoFill touches gets a small "AI" badge pinned to it (hover for "Filled by JobMatch AI — please review"), and a dismissible **"Review before submitting"** warning banner appears in the panel afterward as a reminder to check the form before you hit Submit.

**Resume file upload.** AutoFill also detects résumé/CV file-upload fields (by label/name/`accept`, skipping anything that also reads as a cover letter, portfolio, transcript, or references upload) and attaches a file automatically — no AI call. Specifically:

- **Which resume** — before attaching (and before the Q&A/AI text passes), AutoFill re-confirms the active resume is whichever saved resume scores highest by local ATS-keyword overlap for this job's JD, the same ranking the "★ ... Switch?" hint and Local Match badge use. This re-check exists because the panel's own background auto-select (on opening the panel / navigating to a new posting) is fire-and-forget — clicking AutoFill in the brief window before that finishes could otherwise attach a stale resume. A resume you picked manually for this job is always respected instead.
- **Filename** — attached as a generated name, `Resume_<CandidateName>.<ext>` (e.g. `Resume_Jane-Doe.pdf`), not the filename it was originally uploaded as. The format always matches whatever you actually uploaded — a PDF resume is never converted to DOCX or vice versa.
- **Download it yourself first** — once a resume is scored for the current job (the Local Match badge next to the resume switcher is visible), a **"⬇ Resume file"** button appears right beside it. Click it to download that exact file — same bytes, same generated name AutoFill would attach — so you can open it and confirm it's the right one before trusting AutoFill on a real form.
- It works both on plain `<input type="file">` widgets and on drag-and-drop-style uploaders that listen for a drop event instead of a native file selection, and never overwrites a field that already has a file in it.

⚠️ *This is new, untested-in-production code from this session — verify it on your actual target sites (see `docs/smoke-test.md`, step 9b) before relying on it for real applications.*

<p align="center">
  <img src="screenshots/autofill-form.png" alt="AutoFill in action on a Greenhouse form — panel showing score and action buttons, form fields completed with badges" width="900">
</p>
<p align="center"><em>AutoFill in action — form fields completed using your resume and saved Q&A answers, each marked with an "AI" badge.</em></p>

Works with:
- Standard text inputs and textareas
- Native `<select>` dropdowns
- Custom dropdowns built with React, Angular, or plain JS
- Radio buttons and checkboxes

Sensitive fields (CSRF tokens, tracking IDs, reCAPTCHA, framework internals) are filtered out automatically — they're never sent to the AI and never written to. This filter carves out an explicit exception for known ATS "system field" naming conventions (e.g. Ashby's `_systemfield_name` / `_systemfield_email` / `_systemfield_resume`), since a generic "starts with underscore" heuristic would otherwise mistake an ATS's own built-in Name/Email/Resume fields for internal/CSRF fields and silently skip the entire form.

Always review filled fields one more time before submitting.

---

### Cover Letter Generator

After analyzing a job, click **Cover Letter** in the panel. A tailored letter is generated from the job description and your resume — written specifically for that role and your background, not a generic template.

Export the finished letter as **`.docx`** or **`.pdf`** with one click, complete with your name, contact details, and a clean letterhead. Edit it inline in the panel before exporting, or click ↻ to regenerate.

<p align="center">
  <img src="screenshots/cover-letter-bullets.png" alt="Cover letter generated in the side panel alongside resume bullet rewriter cards" width="900">
</p>
<p align="center"><em>Cover letter generated from your resume and the job description — copy it straight from the panel. Resume bullet cards are visible below for the next step.</em></p>

---

### Resume Bullet Rewriter & Tailored Resume

Click **Improve Resume Bullets** after analyzing a job. The AI rewrites every bullet in your experience section to match the job's language and incorporate the missing skills from your analysis.

<p align="center">
  <img src="screenshots/tailored-resume.png" alt="Resume bullet rewriter showing improved bullets, add bullet area, Generate Tailored Resume button, and downloaded file confirmation" width="900">
</p>
<p align="center"><em>Bullet rewriter with improved bullets, Add a Bullet area, and the Generate Tailored Resume button. The downloaded file name is shown once the DOCX is ready.</em></p>

Each bullet card gives you full control before generating:

- **Edit the improved text directly** — the rewritten bullet is a live editable field. Whatever you type is what goes into the tailored resume.
- **Skills panel** — click the **Skills** button on any bullet to see which missing skills are being woven in. Click individual skill chips to exclude skills you don't want added to that bullet.
- **Regenerate (↻)** — rewrites just that one bullet using only the skills currently selected for it. Regenerate as many times as you like.
- **Include / exclude toggle** — uncheck a bullet to exclude it from the tailored resume. Excluded bullets are faded with strikethrough so you can see exactly what's in and out.
- **Add a custom bullet** — write a new bullet from scratch at the bottom of the list and assign it to a specific experience section. It will be inserted into the tailored resume alongside the rewritten ones.

**Generate Tailored Resume** — once you're satisfied, click the button. The extension:

1. Takes every **checked** bullet — rewritten and custom
2. Replaces the original text in your uploaded DOCX with the improved / edited version
3. Inserts custom bullets into their target experience sections
4. Adds the job's **missing skills** to the skills section of your resume
5. Downloads the result as **`{your_resume_name}_{company}.docx`**

Your original resume file is never modified. The tailored version is always a new download.

---

### Job Notes

Every job has a **Notes** section at the bottom of the panel — a free-text area for observations, interview prep, follow-up reminders, or anything else. Notes save automatically per URL and persist across sessions.

<p align="center">
  <img src="screenshots/notes.png" alt="Notes section at the bottom of the side panel with free-text notes for the current job" width="900">
</p>
<p align="center"><em>Notes section — auto-saved per job URL. Visible at the bottom of the panel on every job page you've visited.</em></p>

---

### Unlimited Resume Profiles & Local Auto-Match

Store as many resume profiles as you want and switch between them with one click directly from the panel — add a new one with the **+** button, or delete one you no longer need. Each resume is independently parsed and stored. Rename any resume to keep them organized — for example, "Backend Eng", "Data Eng", "Lead".

<p align="center">
  <img src="screenshots/profile.png" alt="Profile page with a resume list, upload area, and parsed profile fields" width="900">
</p>
<p align="center"><em>Profile page — named resumes with add/delete controls, drag-and-drop upload (PDF or DOCX), and fully parsed profile fields including contact info, summary, skills, experience, education, projects, and certifications. Autosaves as you edit.</em></p>

With two or more resumes saved, the extension scores every resume against the current job posting locally — by ATS-keyword overlap across skills, certifications, and project technologies — with **no AI call and no network request**. Whichever resume scores highest is auto-selected as the active one before you even click Analyze (a **"★ ... Switch?"** hint and a Local Match badge show the score); picking a resume yourself for that job overrides the auto-selection until you open a different posting. The switcher pills also mark your other top-scoring resumes with a **★**, so with several saved resumes it's obvious at a glance which ones are also worth a look (the active pill skips this — its own highlighted style already marks it as selected). The Profile tab's **ATS Keywords by Resume** card lists the exact terms each resume contributes to this matching.

The match isn't a flat keyword count — three weights are layered on top so it favors what actually matters on the posting: a keyword the JD repeats several times (title, summary, and requirements) counts for more than one mentioned only in passing; a keyword found inside a detected **Requirements / Qualifications section** counts double that again — vs. one only appearing under "Nice to Have", "About Us", or similar; and a keyword that's a **programming language, database, cloud platform, or AI/ML term** (Python, PostgreSQL, AWS, TensorFlow, etc. — a curated, non-exhaustive list) counts double on top of that too, independent of where it appears, since these are almost always genuine hard requirements. All three stack, so a required, JD-repeated, category keyword can weigh many times more than an incidental one. On the resume side, a keyword backed up in more than one place (listed as a skill *and* demonstrated in a project, say — or mentioned again in your summary or an experience bullet's description) earns more credit than a bare skill-list mention, and a mention inside an experience bullet counts for less the further back that role is — a skill you used in your current job outweighs the same skill from a decade-old role, though an old role's mentions are never fully discounted. All of this is needed to reach 100% — a resume that merely lists every required keyword once, with no deeper evidence, lands a bit short of a perfect score.

On top of the keyword score, a small **seniority-alignment nudge** compares the job posting's title against your most recent role's title — if both carry a recognizable level (Junior, Senior, Staff/Principal, Director+) and they match, the resume gets a modest bonus; if they're two or more levels apart (say, the posting wants a Director and your most recent title is Junior), it gets a modest penalty. One level apart, or no recognizable level on either side, leaves the score untouched — this is a coarse nudge on top of the keyword match, not a replacement for it.

The local keyword score is free and instant, but it's still a heuristic — it can occasionally rank resumes differently than the AI would if it actually read them. To close that gap without slowing every click down, clicking **Analyze Job** checks whether the resume about to be analyzed is one of your top-3 local matches (the same three the switcher pills mark with a ★). If it is — and you haven't already manually picked a resume for this job — all of those top-3 resumes are sent to the AI **concurrently** — not one after another — so the wait stays about the same as analyzing a single resume, and the panel automatically switches to whichever one the AI actually scores highest, even if that's not the resume the local heuristic had selected. A resume outside your top 3 is analyzed alone, exactly as before, since there's nothing local ranking says is worth comparing it against. Once you've manually switched to a specific resume for this job — including one of the other two top-3 candidates, to see its own score — clicking Analyze Job always analyzes that one resume alone and never overrides your pick; since every top-3 candidate was cached individually during the compare, checking a runner-up this way is still instant, not a fresh AI call. In fact, switching to a resume that's already been analyzed for the job you're viewing (from that compare, or from a plain earlier Analyze) shows its results the moment you switch — no need to click Analyze Job again just to re-display what's already there. The button reads **Re-Analyze** in that case, so re-running the AI call for that resume is still one click away if you want a fresh answer.

---

### Backup & Restore

**Settings → Backup & Restore** exports your entire setup — profile, resumes, Q&A answers, saved and applied jobs, AI Settings, and Google Sheets sync config — as a single JSON file, and imports it back on another browser or machine. The exported file includes your API key and Sheets sync secret in plain text, so keep it private and only import files you trust.

---

### Common Q&A Answers

Pre-fill answers to hundreds of standard application questions so AutoFill can complete them instantly. Covers work authorization, availability, salary expectations, notice period, sponsorship requirements, EEO and demographic fields, and more. Filter by category to quickly find and update any answer.

**Export / Import** — export your Q&A answers as a JSON file and import it on another browser or computer instead of retyping everything. Importing updates any question that already matches by text and adds the rest; it never removes questions the imported file doesn't mention.

<p align="center">
  <img src="screenshots/qa-answers.png" alt="Q&A Answers tab with category filters and pre-filled answers" width="900">
</p>
<p align="center"><em>Q&A Answers — pre-configured responses with category filtering. Click "Load Common US Job Application Questions" to populate everything at once.</em></p>

---

### Applied Tracking & Google Sheets Sync

Click **Mark as Applied** on any analyzed job and it's recorded locally with its match score, title, company, location, salary, and date — this count feeds the Stats tab's "Total Applied" figure. There is no standalone in-panel "Applied Jobs" table in this fork; instead, applied jobs can be pushed automatically to a Google Sheet:

- **Settings → Google Sheets Sync** — paste the Web App URL from a one-time [Apps Script deployment](docs/sheets-sync/SETUP.md) (`docs/sheets-sync/Code.gs`), set a shared secret, and enable sync. No Google API key is involved — Sheets doesn't support write access with a bare key, so the extension POSTs to a script running under your own Google account instead.
- Every **Mark as Applied** click appends a row — Date, Title, Link, Company, Location, Salary, ResumeNo, Score — to your target tab (or "Applications" by default). The button only flips to the locked "Applied" state once the row is confirmed appended; if sync fails or isn't configured, it stays as "Mark as Applied" so you can retry without creating a duplicate record.
- **Test Sync** in Settings verifies connectivity and your shared secret without adding a row.

See `docs/sheets-sync/SETUP.md` for full setup and troubleshooting steps.

---

### Job Search Stats

The Stats tab gives you a live overview of your search: total jobs analyzed, total applied, average match score, score distribution, and a ranked list of the skills appearing most often in jobs where you had gaps — so you know exactly what to add to your resume next.

<p align="center">
  <img src="screenshots/stats.png" alt="Stats page showing jobs analyzed, applied, average match score, score distribution, and top missing skills" width="900">
</p>
<p align="center"><em>Stats — job search analytics at a glance, including the top skills to add to your resume based on all the jobs you've analyzed.</em></p>

---

### Saved Jobs

Bookmark any job from the panel — including before you've run Analyze. The **Saved Jobs** tab lists every bookmarked job in a table with score badge (or a neutral "Not analyzed" badge for quick-saves with no score yet), title linked back to the posting, company, location, salary, date, and a Delete button.

---

### Draggable Floating Button

The **★ button** that opens the panel can be dragged anywhere on the screen. Its position is saved and restored across page navigations — it stays where you put it.

---

### Three Themes

Switch between **Ocean Blue** (light), **Dark Mode**, and **Warm Amber** using the theme toggle (☀️ 🌙 🌻) in the panel header or profile page. Your preference is saved automatically.

---

## Where It Works

JobMatch AI works on any website with a job posting. It has dedicated extraction and auto-fill support for the most widely used platforms:

| Site | JD Extraction | Salary | Location | Auto-Fill |
|------|:---:|:---:|:---:|:---:|
| LinkedIn | ✓ | ✓ | ✓ | ✓ |
| Indeed | ✓ | ✓ | ✓ | ✓ |
| Glassdoor | ✓ | ✓ | ✓ | ✓ |
| Greenhouse | ✓ | ✓ | ✓ | ✓ |
| Lever | ✓ | ✓ | ✓ | ✓ |
| Workday | ✓ | ✓ | ✓ | ✓ |
| Any other site | ✓* | ✓* | ✓* | ✓ |

\* *Uses universal selectors and regex fallbacks on sites without dedicated support.*

On SPAs like LinkedIn and Indeed, the extension detects navigation between job postings and resets the panel state automatically — no page reload needed.

### Multi-Step Application Flows

Some job boards split the posting and the application form across two URLs of the same SPA — for example Ashby: `jobs.ashbyhq.com/<company>/<id>` is the job description, `jobs.ashbyhq.com/<company>/<id>/application` is the form, reached via a client-side route change with no JD content of its own on the page. Since that route change still resets the panel (new URL → "new job" as far as the panel's state goes — Analyze/Cover Letter/Mark Applied all reset and need re-running), Analyze or AutoFill run directly on the application step would previously have nothing real to work with there.

To fix this, the extension caches the last confidently-extracted job description **per browser tab** (in the background service worker's session storage — memory-only, cleared when you close that tab, never written to disk) whenever it finds one on a page. On a page with no real JD content, Analyze, AutoFill's file-attach, Cover Letter, and bullet rewriting all fall back to that tab's cached JD instead of scraping the application form's own text as if it were the job description. A tab that's never seen a JD — including the application step opened in its **own separate browser tab** rather than reached by clicking through from the posting tab (so it never populated its own cache) — has nothing to fall back to for those AI calls, same as before.

Resume **auto-select** (the silent switch that picks the best-matching saved resume before Analyze or AutoFill runs) is handled more conservatively: it only ever ranks resumes against a confidently-extracted or tab-cached JD, never that last-resort scrape. On a tab with neither, it simply leaves whichever resume is already active alone — which, since the active resume is itself stored in `chrome.storage.local` (shared across all your tabs), is still correctly whatever you picked or analyzed on the posting tab. Before this fix, a tab like Ashby's `.../application` step opened separately could rank resumes against its own scraped form text and silently switch AutoFill to an unrelated resume — this is what "AutoFill using the wrong resume" on a separate application-step tab turned out to be.

### Multi-Tab Resume Isolation

Analyzing or auto-filling several job tabs at once is safe: which resume's profile and file bytes get used for AI calls (Analyze, AutoFill, Cover Letter, bullet rewriting) and file attachment is now resolved per-request from the tab's own auto-selected (or manually chosen) resume ID, not from a single shared "currently active resume" value. Previously that shared value lived in one flat storage key written by every tab's silent best-match auto-selection — two tabs open on jobs that favor different resumes at the same time could race and briefly cause one tab to generate content, or attach a file, from the *other* tab's resume while its own panel still showed the correct one selected. Each tab's request now always carries its own resume ID, so this can no longer happen regardless of how many tabs are analyzing concurrently.

⚠️ *This is also new, untested-in-production code from this session.*

⚠️ *This is also new, untested-in-production code from this session.*

---

## AI Provider — Your Key, Your Data

JobMatch AI uses your own OpenAI API key and calls the OpenAI Chat Completions API directly from the browser. Nothing passes through any external server (other than the optional Google Sheets sync webhook, see above). Your resume, your answers, and your API key are stored locally in Chrome's storage.

<p align="center">
  <img src="screenshots/ai-settings.png" alt="Settings page showing provider dropdown, API key input, model selection, temperature slider, and Test Connection button" width="900">
</p>
<p align="center"><em>Settings — paste your OpenAI API key, pick a model, set temperature, and click Test Connection to verify before saving.</em></p>

This fork supports a **single provider, OpenAI**, unlike upstream JobMatch AI's ten-provider lineup (Anthropic, Google Gemini, Groq, Cerebras, Together AI, OpenRouter, Mistral AI, DeepSeek, Cohere, OpenAI). The provider abstraction (`aiService.js`) is kept generic internally, so another provider could be re-added the same way if needed, but only OpenAI ships today.

Get a key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys). Built-in models include GPT-4.1, GPT-4.1 Mini, GPT-4o, GPT-4o Mini, o4-mini, and o3-mini (default: GPT-4.1).

### Live Model Refresh & Custom Models

- **🔄 Refresh models** — click the refresh button next to the model dropdown and the extension pulls OpenAI's **current** model list directly from the `/models` API. No more being stuck on a deprecated model id.
- **Custom model entry** — pick `Custom…` to paste in any OpenAI model id, including brand-new ones.
- **Saved key** — JobMatch AI remembers your API key locally. A "Clear saved keys" link in Settings wipes it.

---

## Getting Started

### 1. Install and Open

Load the extension unpacked (see [Installation](#installation-developer--local-build) below — this fork isn't published to the Chrome Web Store), then click the toolbar icon or the **★ floating button** on any job page to open the panel.

### 2. Configure AI

Go to **Settings**, paste your OpenAI API key, pick a model, and click **Test Connection**. Click **Save Settings**.

### 3. Upload Your Resume

Go to **Profile**, select or add a resume, and drag & drop your PDF or DOCX. The AI parses it into a structured profile — name, contact info, summary, skills, experience, education, projects, and certifications — all editable. The profile autosaves as you type.

### 4. Pre-fill Q&A (Optional but Recommended)

Go to **Q&A Answers** and click **Load Common US Job Application Questions** to populate standard answers for work authorization, salary, availability, EEO fields, and more. Edit any answer to match your preferences, or import a previously exported Q&A file.

### 5. Analyze a Job

Navigate to any job posting, click the **★ button** to open the panel, and click **Analyze Job**. With two or more resumes saved, the best local ATS-keyword match is auto-selected first. Your match score, insights, skill gaps, ATS keywords, and recommendations are ready in seconds.

### 6. Apply

- Use **AutoFill Application** to complete the form with your resume and Q&A answers
- Generate a **Cover Letter** tailored to the role
- **Improve Resume Bullets** and download a **Tailored Resume** with missing skills added
- Click **Mark as Applied** to log the application (and sync it to Google Sheets, if configured)

### 7. Sync to Google Sheets (Optional)

Go to **Settings → Google Sheets Sync**, follow `docs/sheets-sync/SETUP.md` to deploy the included Apps Script once, then paste the Web App URL and your shared secret and enable sync.

---

## Privacy

- Your resume, API key, and Sheets sync secret are stored **locally** in Chrome's storage — never sent to any server other than OpenAI, and (if you enable it) the Google Apps Script web app you deploy yourself for Sheets sync.
- All AI analysis happens via direct API calls from your browser to OpenAI.
- No analytics, no tracking, no data collection of any kind.

This fork removes upstream JobMatch AI's H1B/PERM sponsorship-data feature, which called a separate third-party H1B data worker — see [What's Different From Upstream](#whats-different-from-upstream). Upstream's privacy policy (linked from the original project) does not describe this fork's Google Sheets sync feature or its narrower AI-provider surface.

---

## Installation (Developer / Local Build)

1. Clone the repository:
   ```bash
   git clone https://github.com/acebrown815/BidExtension.git
   ```
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top-right)
4. Click **Load unpacked** and select the `BidExtension` folder
5. Pin the extension from the puzzle icon in the Chrome toolbar

Run the test suite with `npm test` (or `npm run test:watch`) — see `tests/`.

---

## Project Structure

```
BidExtension/
├── manifest.json              # Chrome MV3 manifest
├── background.js              # Service worker: message routing, AI calls, caching,
│                               #   Sheets sync, backup/restore
├── content.js                 # Side panel UI, job scraping, autofill, notes, badges,
│                               #   local resume auto-match
├── aiService.js                # AI provider abstraction (OpenAI only; retry logic)
├── deterministicMatcher.js    # Rule-based dropdown matching (no AI)
├── directFill.js               # Low-level field filling helpers
├── profile.html / profile.js  # Profile, Q&A, Saved Jobs, Stats, Settings
├── styles.css                  # Content script base styles
├── lib/                        # Shared helpers, each as a classic script (content
│   │                           #   scripts / profile.html) + an .mjs mirror (tests):
│   ├── urlKey.js(.mjs)          #   per-URL storage key normalization
│   ├── fieldFilter.js            #   filters sensitive fields out of autofill
│   ├── resumeKeywords.js(.mjs)   #   ATS keyword extraction from a resume profile
│   ├── resumeRanker.js(.mjs)     #   local, zero-AI resume-vs-JD scoring
│   ├── aiSettingsMigration.mjs   #   migrates older stored AI settings shapes
│   ├── coverLetterDocx.mjs, coverLetterPdf.mjs, coverLetterFilename.mjs, docxBullets.mjs
│   │                             #   cover letter / tailored resume file generation
│   └── visaPhrases.js(.mjs), h1bCache.mjs
│                                 #   unused leftovers from the upstream H1B/visa
│                                 #   feature, which this fork doesn't load or call
├── libs/                       # pdf.js, mammoth.js, jspdf, jszip — third-party
│                               #   libraries for client-side resume/file parsing
├── docs/sheets-sync/           # Code.gs (Apps Script) + SETUP.md for Google Sheets sync
├── docs/smoke-test.md          # Manual QA checklist
├── tests/                      # Vitest unit tests (see package.json's "test" script)
├── icons/                      # Extension icons (16, 48, 128px)
└── screenshots/                # README images
```

---

## What's Different From Upstream

Compared to [wadekarg/JobMatchAI](https://github.com/wadekarg/JobMatchAI), this fork:

- **Removed** the Visa & H1B/PERM sponsorship-data feature entirely (sponsorship phrase detection, USCIS/DOL trend charts, H1B history) — `lib/visaPhrases.js` and the H1B data-worker host permission are gone from the manifest, though the unused source files are still present in `lib/`.
- **Reduced AI providers from ten to one** — only OpenAI is wired up in `aiService.js` and the Settings provider dropdown; the multi-provider registry and per-provider key memory were removed.
- **Removed the resume cap** — resumes are an unlimited, add/delete list instead of exactly 3 fixed slots.
- **Removed AutoFill's review/approve gate** — upstream showed a "Review before fill" panel with a checkbox per proposed answer and an explicit "Apply Selected" click before anything was written; this fork writes AI-proposed answers straight into the form and only shows a "Review before submitting" warning afterward. Fields are still marked with an "AI" badge so you can see what was touched.
- **Added local, zero-AI resume-to-job matching** — auto-selects the best-matching saved resume for the current posting by *weighted* ATS-keyword overlap (`lib/resumeRanker.js`, `lib/resumeKeywords.js`): keywords repeated in the JD count for more, keywords found in a detected Requirements/Qualifications section count double that again, keywords that are a programming language/database/cloud platform/AI-ML term (a curated list — see `HIGH_VALUE_CATEGORY_TERMS`) count double yet again, and resume keywords backed by more than one place (skills + a project, say — or additional mentions found in `profile.summary`/`profile.experience[].description` prose, recency-weighted by how far back that role is — see `RECENCY_WEIGHT_DECAY_PER_ROLE`) outscore a bare skill-list mention. A small seniority-alignment nudge (`detectSeniorityTier`/`seniorityAlignmentMultiplier`) additionally compares the posting's title against the resume's most recent role title. Shows an "ATS Keywords by Resume" breakdown on the Profile tab, and marks up to 3 other top-scoring resumes with a ★ on the switcher pills (skipped for the active pill).
- **Added Google Sheets Sync** — optionally pushes every "Mark as Applied" to a Google Sheet via a self-deployed Apps Script webhook (`docs/sheets-sync/`).
- **Removed the in-panel Applied Jobs table** — applied jobs are still tracked (for the Stats count and Sheets sync) but no longer have a dedicated browsable tab; the **Applied Jobs** tab was replaced by a **Saved Jobs** tab with a fuller table (score, title, company, location, salary, date, delete).
- **Added Backup & Restore** and **Q&A Export/Import** — full-setup and Q&A-only JSON export/import from the Settings and Q&A tabs, respectively.
- **Renamed** the "AI Settings" tab to **Settings** (it now also hosts Google Sheets Sync and Backup & Restore).
- **Added automatic resume file upload to AutoFill** — attaches the active resume's file (as `Resume_<CandidateName>.<ext>`) to résumé/CV upload widgets, no AI call, plus a manual **"⬇ Resume file"** download button next to the Local Match badge to check the exact file first (see Smart Auto-Fill above). Not yet verified against real ATS forms — test before relying on it.
- **Added a per-tab job description cache** so multi-step application flows (a JD page and a separate application-form page on the same site, e.g. Ashby) don't lose the real job description when you navigate between them — see Multi-Step Application Flows above. Not yet verified against real ATS forms — test before relying on it.
- **Made concurrent multi-tab analysis/AutoFill resume-safe** — resume profile/file lookups for AI calls and file attachment are now resolved per-request by resume ID instead of through a single shared "active resume" value, so analyzing several job tabs at once (each auto-selecting a different best-match resume) can no longer cross-contaminate which resume's data one tab uses — see Multi-Tab Resume Isolation above. Not yet verified against real ATS forms — test before relying on it.
- **Analyze Job now compares your top-3 local matches via AI, not just one** — when the resume about to be analyzed is one of the ★-marked top-3 local matches and you haven't manually picked a resume for this job yet, clicking Analyze Job sends all three to the AI *concurrently* (`Promise.allSettled`, not sequential, to keep response time roughly the same as analyzing one) and auto-switches to whichever one the AI itself scores highest — see `analyzeAndPickBest` in `content.js`. A resume outside the top 3 is still analyzed alone, unchanged. Every candidate's result is cached per URL+resume, so re-analyzing or manually switching to a runner-up afterward costs no extra API call and shows that resume's own score instead of re-running the compare and snapping back to the winner.
- **Switching resumes now shows an already-analyzed result immediately** — `switchSlot()` checks the cache for the resume+job you're switching to and, if found, renders it right away (score, insights, skill gaps, recommendations, and the Re-Analyze/Mark Applied/Cover Letter/etc. buttons) instead of resetting to a bare "Analyze Job" button and making you click it again just to redisplay a result already sitting in cache. A resume with no cached result for the current job still resets to "Analyze Job" as before. Shares the same rendering path (`renderCachedAnalysis`) as Analyze Job's own cache hit, so both stay in sync.
- **Fixed a race between Analyze Job and switching resumes mid-analysis** — clicking Analyze Job, then switching to a different resume before the AI call finishes, used to save that result under the *newly selected* resume's cache entry instead of the one actually analyzed, so switching to it later could show a score computed for a different resume entirely. Analyze Job (and the top-3 compare) now capture which resume they're analyzing once, up front, and use that captured id for every cache read/write from then on — never a live re-read after the AI call returns. The Analyze button is also un-stuck the moment you switch: it no longer stays disabled/spinning for a resume you've already navigated away from, and a background analysis finishing for a resume you're no longer viewing no longer overwrites the panel or button state of whichever resume you switched to.
- **Fixed AutoFill silently using the wrong resume on a separate application-step tab** — a job's application form opened in its *own browser tab* (e.g. Ashby's `.../application` route, opened as a separate tab rather than clicked through from the posting) has no real JD text and no per-tab cached JD of its own; the resume auto-select that runs on panel open and before AutoFill used to fall back to scraping the application form's own text as a "JD" and could rank an unrelated resume as the best match, silently switching AutoFill away from whatever resume was actually picked on the posting tab. Resume auto-select (`scanResumeMatch`, `ensureBestResumeSelected`, and Analyze's own auto-select) now uses a stricter JD lookup (`getConfidentJobDescriptionForRanking`) that only trusts a confidently-extracted or tab-cached JD and otherwise leaves the currently active resume alone — which, since it's stored in `chrome.storage.local`, is still correctly whatever you selected on another tab for the same posting. The actual AI calls (Analyze, Cover Letter, bullet rewriting) are unaffected and still use the existing best-effort JD extraction, since those are explicit actions that tolerate imperfect text fine.
- **Fixed AutoFill finding zero fields on Ashby application forms** — `detectFormFields()`'s field-name allowlist (`lib/fieldFilter.js`, C3b) treated *any* field name starting with an underscore as an internal/CSRF field and excluded it. Ashby names every one of its own built-in fields `_systemfield_*` (`_systemfield_name`, `_systemfield_email`, `_systemfield_resume`, `_systemfield_eeoc_gender`, `_systemfield_eeoc_race`, `_systemfield_eeoc_veteran_status`), so on an Ashby application page this excluded literally every field on the form — Name, Email, and the resume upload included — leaving AutoFill with nothing to fill and nothing to attach the resume file to, independent of resume selection. `isSensitiveFieldName` now explicitly exempts the `_systemfield_` prefix before applying the generic underscore heuristic (which still correctly blocks genuinely internal-looking names like `_internal`, `_meta`, `__hidden`).

---

## Contributing

Contributions are welcome.

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/my-improvement`
3. Commit your changes and open a Pull Request

Have an idea but not sure where to start? Open an [issue](https://github.com/acebrown815/BidExtension/issues).

---

## License

MIT
