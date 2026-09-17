# Google Sheets Sync — one-time setup

This lets JobMatch AI push every job you mark "Applied" to a Google Sheet
automatically. It works via a small Apps Script web app that runs under
your own Google account — no Google API key involved (Sheets doesn't
support writing to a private spreadsheet with a bare key).

## 1. Create (or pick) the spreadsheet

Open [sheets.google.com](https://sheets.google.com) and create a new
spreadsheet (or open an existing one you want applied jobs added to). The
script will create an "Applications" tab in it automatically the first time
it runs — you don't need to set up columns yourself.

## 2. Open the Apps Script editor

In the spreadsheet: **Extensions → Apps Script**. This opens a script
editor already bound to this specific spreadsheet.

## 3. Paste the script

Delete the placeholder `function myFunction() {}` in `Code.gs` and paste in
the full contents of `Code.gs` from this folder.

## 4. Set your shared secret

Near the top of the script, change:

```js
const SHARED_SECRET = 'REPLACE_WITH_A_LONG_RANDOM_STRING';
```

to a long random string only you know — a password manager's "generate
password" feature works well. You'll paste this same value into the
extension in step 7. Anyone who has both your Web App URL *and* this secret
could append rows to your sheet, so don't share it.

## 5. Save and deploy

- Click the save icon (or Ctrl/Cmd+S).
- Click **Deploy → New deployment**.
- Click the gear icon next to "Select type" and choose **Web app**.
- Fill in:
  - **Execute as:** Me (your Google account)
  - **Who has access:** Anyone
    (This does *not* mean anyone can write to your sheet — every request
    still has to include your `SHARED_SECRET`, or the script rejects it.
    "Anyone" here just means Google won't additionally require the caller
    to be signed in with a Google account, which the extension isn't.)
- Click **Deploy**.
- The first time, Google will show an "Authorize access" prompt — this is
  Google asking *you* to confirm the script can edit *your own* spreadsheet.
  Click through it (you may see an "unverified app" warning since this is
  your own personal script, not published — click **Advanced → Go to
  (project name)** to proceed).
- Copy the **Web app URL** it gives you — looks like
  `https://script.google.com/macros/s/AKfycb.../exec`.

## 6. Re-deploying after edits

If you ever change `Code.gs` later, editing it alone isn't enough — Apps
Script web apps are versioned. Use **Deploy → Manage deployments → edit
(pencil icon) → New version → Deploy** to push the updated code live at the
same URL.

## 7. Configure the extension

In the JobMatch AI extension: **Profile → Settings → Google Sheets
Sync**:

- Paste the Web App URL from step 5 into **Web App URL**.
- Optionally, type a tab name into **Sheet Tab Name** if you want applied
  jobs appended to a specific tab in the spreadsheet. Leave it blank to use
  the default "Applications" tab — the script creates whichever tab you
  name (with a header row) automatically the first time it runs, the same
  way it does for the default.
- Paste the same string from step 4 into **Shared Secret**.
- Check **Enable Google Sheets sync**.
- Click **Save Sheets Settings**.
- Click **Test Sync** — it should say "Sync successful!" without adding any
  row to your sheet (the test call is a connectivity/secret check only).

From then on, every "Mark as Applied" click also appends a row to your
target tab (the one you named in **Sheet Tab Name**, or "Applications" if
left blank), in this exact column order: Date, Title, Link (a
clickable link to the job posting), Company, Location, Salary, ResumeNo
(whichever saved resume was active for that job's analysis), Score (the AI
match score). If you customize the sheet layout, `appendJobRow` in
`Code.gs` must list its values in the SAME order as your header row —
`appendRow` fills columns positionally with no awareness of header text, so
a mismatched order silently shifts every value into the wrong column.

Note: the side panel's button only switches to the locked "Applied" state
once the row is *confirmed* appended to your sheet. If the sync fails (or
Sheets Sync isn't enabled/configured yet), the button stays as "Mark as
Applied" so you can click it again after fixing your settings — it reuses
the same local record and retries the sync rather than adding a duplicate.

## Troubleshooting

- **"Sync failed: Invalid secret."** — the secret in the extension doesn't
  match `SHARED_SECRET` in the script. Re-check both, remembering to
  re-deploy (step 6) if you changed the script after your last deploy.
- **"Apps Script returned HTTP ..."** — the Web App URL is wrong, or the
  deployment was deleted/disabled. Re-copy the URL from **Deploy → Manage
  deployments**.
- **Sync succeeds but no matching tab appears** — check you pasted the
  script into the Apps Script project that's actually bound to the
  spreadsheet you're looking at (Extensions → Apps Script always opens the
  one bound to the currently open sheet). Also double-check the tab name
  in the extension's **Sheet Tab Name** field for typos — a mismatched
  name just creates a new tab with that name rather than an error.

## Auto-Bid: analyzing pending jobs (Beta)

Once the sheet is set up, you can seed it with jobs to review: add rows
with just a **Link** (and optionally a Title), leaving Company, Location,
Salary, and ResumeNo blank. In the extension's **Auto-Bid** tab, click
**Analyze Pending Jobs** — the extension opens up to 10 such rows' Links in
new background tabs (one after another, not all at once, to avoid bursting
the network or the AI provider's rate limit) and runs Analyze Job on each
automatically. Tabs are opened in the background rather than stealing your
window focus — `lib/fakeVisible.js` makes each page believe it's visible
regardless, since some ATS platforms (Dover, confirmed) otherwise defer
loading the job description until their tab is actually visible, which
would make resume matching unreliable for a background-tab automation like
this one.

If a job's analysis scores above 75% — the same threshold that already
gates the "Mark as Applied" button — the extension also autofills that
page's application form automatically, using whichever resume actually won
the analysis (the same AutoFill logic a manual click runs). A job at or
below 75%, or a page with no application form on it (e.g. a JD-only
overview page), is left as analysis-only; nothing is ever submitted either
way. Review each result yourself — including the autofilled form, if there
is one — and click **Mark as Applied** to record it, the same as any other
job — that's what fills in a row's Company/Location/Salary/ResumeNo/Score
and makes it stop counting as
pending. Click the button again to pick up the next batch.

If you deployed `Code.gs` before this feature existed, you must re-deploy
(step 6 above) to pick up the `listPending` support — otherwise "Analyze
Next Pending Job" fails with "Request had neither test, job, nor
listPending."

- **A row gets added but most columns are blank, or values land under the
  wrong header** — almost always means `Code.gs`'s `doPost`/`appendJobRow`
  doesn't match what the extension actually sends. Two common causes: (1)
  reading fields off the POST body directly (`data.title`) instead of off
  the nested `job` object the extension sends (`data.job.title`) — see the
  shape below; (2) `appendRow`'s array not being in the same left-to-right
  order as your header row, which silently shifts every value one or more
  columns over. The extension POSTs
  `{ secret, job: { title, company, location, salary, url, resume, score,
  date, id } }` for a real "Mark as Applied", and `{ secret, test: true }`
  (no `job`) for the Settings page's "Test Sync" button — a script that
  doesn't check for `test` and skip appending will add a near-empty row
  (just today's date, from the `new Date()` fallback) every time someone
  clicks Test Sync.
