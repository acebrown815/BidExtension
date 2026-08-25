# JobMatch AI — Smoke Test Checklist

Run after each refactor batch. ~5 minutes. Stop at the first failure and revert
the batch (`git revert <sha>`) — every batch is one commit, easy to roll back.

## Prereqs
- Load unpacked from `chrome://extensions` (Developer mode on)
- One resume slot already populated and one valid AI provider key configured

## Steps

1. **Extension loads** — open `chrome://extensions`. JobMatch AI shows no errors.
2. **Panel opens** — visit a LinkedIn job posting. Click the floating ★ button.
   Side panel appears, no console errors.
3. **Analyze** — click **Analyze Job**. Score appears within 30 s.
   Matching skills + missing skills + recommendations all render.
4. **Re-analyze** — click **Re-Analyze**. New score replaces the old one.
5. **Notes save** — type into Notes, switch tabs, come back. Notes persist.
6. **Cover Letter** — click **Cover Letter**. Letter generates. Copy works.
7. **Improve Resume Bullets** — click. Bullet cards appear. Edit one. Toggle
   skill chips on a bullet. Click ↻ to regenerate one bullet.
8. **Generate Tailored Resume** — click. DOCX downloads. Open it — content
   matches what you saw on screen.
9. **AutoFill** — open a Greenhouse job application form (any company on
   `*.greenhouse.io`). Click **AutoFill Application**. Fields fill. No
   answer text (gender / salary / etc.) leaks into DevTools console.
9b. **Resume file upload** — on that same (or another) form with a résumé
    upload widget, confirm the widget shows your resume filename attached
    after AutoFill runs, without you touching it — check both a plain
    native file input (Greenhouse) and a drag-and-drop style uploader
    (Lever/Workday) at least once each. Confirm a **cover letter** upload
    field on the same form is left untouched (should not get the résumé).
    Status message should say "Attached resume (...)".
9c. **Resume file download button** — with a JD scanned (Local Match badge
    visible next to the resume switcher), click the **"⬇ Resume file"**
    button beside it. A file named `Resume_<YourName>.pdf` or `.docx`
    downloads. Open it — it's a valid, uncorrupted copy of your actual
    resume, same format you originally uploaded, and it's byte-identical
    to whatever step 9b just attached to the form.
10. **Mark Applied** — click. Total Applied count increases on the Stats tab
    (there is no in-panel Applied Jobs table in this fork).
11. **SPA navigation** — on LinkedIn, click another job posting in the list.
    Panel resets. New job's title/company/location render. Click Analyze.
    No "wrong job's analysis" flash.
12. **Saved jobs** — bookmark a job. Open Profile → Saved tab. Job appears.
13. **Resume slot switch** — switch from Resume 1 to Resume 2 in the panel.
    Click Analyze again. Score updates with the new resume's profile.
14. **Cross-site** — visit a non-job page (e.g. github.com). Open DevTools
    console. Confirm no `[JobMatch AI]` logs leak. Confirm panel doesn't
    auto-open or auto-fill anything.

## Per-site sanity checks (do at least one of each per batch)

| Site | Smoke check |
|---|---|
| LinkedIn | Analyze + Cover Letter + Mark Applied |
| Indeed | Analyze + Score |
| Greenhouse | AutoFill + Score |
| Lever | AutoFill + Score |
| Workday | AutoFill (often the trickiest) |

If any step fails: capture the console error, note which step, then
`git revert <sha>` and tell me what broke.
