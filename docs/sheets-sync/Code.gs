/**
 * JobMatch AI — Google Sheets Sync web app.
 *
 * Deploy this bound to the Google Sheet you want applied jobs pushed to.
 * The extension POSTs one job at a time; this script validates a shared
 * secret and appends a row. See SETUP.md in this same folder for the full
 * one-time deploy walkthrough.
 *
 * Why a webhook instead of a Google API key: the Sheets API can't write to
 * a private spreadsheet with a bare API key — only OAuth or a script
 * running with the sheet owner's own identity (which is exactly what an
 * Apps Script web app deployed as "Execute as: Me" gives you). This script
 * IS that identity — it's already running as you, in your own Google
 * account, against your own sheet.
 */

// ─── Configuration — edit these two lines ──────────────────────────────────

// Must exactly match the "Shared Secret" you paste into the extension's
// Profile → AI Settings → Google Sheets Sync section. Treat it like a
// password: anyone with your Web App URL *and* this secret can append rows
// to your sheet. Anyone with just the URL (no secret) cannot — every
// request is rejected unless the secret matches.
const SHARED_SECRET = 'REPLACE_WITH_A_LONG_RANDOM_STRING';

// The tab (sheet) applied jobs get appended to. Created automatically
// (with a header row) on the first successful sync if it doesn't exist yet.
const SHEET_NAME = 'Applications';

// ─── Web app entry points ───────────────────────────────────────────────────

/**
 * Handles POST requests from the extension: either a connectivity/secret
 * check ({ test: true }) or an actual job row to append ({ job: {...} }).
 *
 * Sent with Content-Type: text/plain by the extension (avoids a CORS
 * preflight Apps Script web apps don't handle), so the body is parsed from
 * e.postData.contents regardless of the declared content type.
 */
function doPost(e) {
  try {
    const data = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    if (data.secret !== SHARED_SECRET) {
      return jsonResponse({ success: false, error: 'Invalid secret.' });
    }

    if (data.test) {
      // Connectivity + secret check only — confirms the sheet is reachable
      // without writing a fake row into it.
      getOrCreateSheet(data.sheetName);
      return jsonResponse({ success: true, test: true });
    }

    if (data.job) {
      appendJobRow(data.job, data.sheetName);
      return jsonResponse({ success: true });
    }

    if (data.listPending) {
      // Auto-bid pipeline, step 1: the extension pulls rows the user has
      // manually seeded with just a Link (and optionally a Title) — every
      // other tracked column still blank — as a queue of postings it should
      // open and analyze next. A row stops being "pending" the moment any
      // of those columns gets filled in (by a real "Mark as Applied" sync,
      // or by the user editing the sheet directly), so completed jobs never
      // get re-picked.
      return jsonResponse({ success: true, jobs: listPendingJobs(data.sheetName) });
    }

    return jsonResponse({ success: false, error: 'Request had neither test, job, nor listPending.' });
  } catch (err) {
    return jsonResponse({ success: false, error: String(err && err.message || err) });
  }
}

/** Simple health check if you open the Web App URL directly in a browser. */
function doGet(e) {
  return jsonResponse({
    status: 'ok',
    message: 'JobMatch AI Sheets Sync is running. POST job data here — see SETUP.md.',
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const COLUMNS = ['Date', 'Title', 'Link', 'Company', 'Location', 'Salary', 'ResumeNo', 'Score'];

/**
 * Returns the target sheet, creating it (with a header row) if missing.
 * @param {string} [sheetName] Tab name from the extension's "Sheet Tab Name"
 *   field. Falls back to SHEET_NAME when blank/absent, so older extension
 *   versions (or anyone who leaves the field empty) keep working unchanged.
 */
function getOrCreateSheet(sheetName) {
  const name = (sheetName && String(sheetName).trim()) || SHEET_NAME;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(COLUMNS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Builds a Sheets HYPERLINK formula pointing at the given URL, with the URL
 * itself as the visible/clicked-through text. Double quotes are doubled per
 * Sheets formula string-literal escaping — defensive, since a URL containing
 * a raw `"` could otherwise break out of the formula's string argument.
 */
function hyperlinkFormula(url) {
  const escaped = String(url).replace(/"/g, '""');
  return '=HYPERLINK("' + escaped + '","' + escaped + '")';
}

/**
 * Appends one job as a row, in the same column order as COLUMNS.
 * IMPORTANT: this array's order must exactly match your sheet's header row —
 * appendRow fills columns left-to-right positionally, with no awareness of
 * header text, so a mismatched order (or a missing/extra entry) silently
 * shifts every value into the wrong column.
 */
function appendJobRow(job, sheetName) {
  const sheet = getOrCreateSheet(sheetName);
  sheet.appendRow([
    job.date || '',                                         // Date
    job.title || '',                                       // Title
    job.url ? hyperlinkFormula(job.url) : '',                // Link
    job.company || '',                                      // Company
    job.location || '',                                     // Location
    job.salary || '',                                       // Salary
    job.resume || '',                                       // ResumeNo
    typeof job.score === 'number' ? job.score : '',          // Score
  ]);
}

/**
 * Finds rows that have a Link but nothing in Company/Location/Salary/
 * ResumeNo yet — the extension's queue of postings still waiting to be
 * opened and analyzed. Row 1 (the header) is always skipped.
 * @param {string} [sheetName] Same fallback rule as getOrCreateSheet.
 * @returns {Array<{row: number, title: string, link: string}>} `row` is the
 *   1-indexed sheet row (for a human checking the sheet directly) — the
 *   extension itself only needs `link`.
 */
function listPendingJobs(sheetName) {
  const sheet = getOrCreateSheet(sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(2, 1, lastRow - 1, COLUMNS.length).getValues();
  const pending = [];
  values.forEach((row, i) => {
    const [, title, link, company, location, salary, resumeNo] = row;
    const hasLink = link !== '' && link !== null;
    const isUntouched = !company && !location && !salary && !resumeNo;
    if (hasLink && isUntouched) {
      pending.push({ row: i + 2, title: String(title || ''), link: String(link) });
    }
  });
  return pending;
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}