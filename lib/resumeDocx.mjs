/**
 * Pure builder for the OOXML parts of a plain, ATS-friendly resume .docx
 * built from a parsed resume profile (the JSON aiService.js's
 * buildResumeParsePrompt produces). Returns { [zipPath]: xmlString } for the
 * service worker to zip with JSZip — same pattern as coverLetterDocx.mjs.
 *
 * Used when the resume selected for a job has no original file saved with
 * it — only DOCX uploads keep their bytes (profile.js), so a resume imported
 * from a PDF, added blank, or migrated from the old slot storage has none.
 * AutoFill uploads this instead of leaving a required Resume/CV field empty
 * — confirmed on Greenhouse (thenewyorktimes), where "Resume/CV is
 * required" stayed while the AI cover letter beside it attached fine.
 *
 * Layout (US Letter, 0.75in margins, Calibri): name, contact line, then
 * Summary, Skills, Experience, Education, Certifications, Projects — each
 * only when present. Dates sit on a right-aligned tab stop.
 */

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const CALIBRI  = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>';
const SZ       = (pt) => `<w:sz w:val="${Math.round(pt * 2)}"/>`;
const TEXT_W   = 12240 - 1080 * 2; // page width minus margins, in twips

const str = (v) => (v == null ? '' : String(v)).trim();

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** One <w:r>; `\t` becomes a tab. */
function run(text, rPr = '') {
  const inner = String(text).split('\t')
    .map((seg, i) => (i ? '<w:tab/>' : '') + (seg ? `<w:t xml:space="preserve">${escapeXml(seg)}</w:t>` : ''))
    .join('');
  return `<w:r><w:rPr>${CALIBRI}${rPr}</w:rPr>${inner}</w:r>`;
}

function para(runs, pPr = '') {
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs}</w:p>`;
}

const AFTER = (twips) => `<w:spacing w:before="0" w:after="${twips}"/>`;

/**
 * Splits a free-text description into bullet lines: existing line breaks /
 * bullet characters, otherwise the text as one line.
 * @param {string} text
 * @returns {string[]}
 */
export function descriptionLines(text) {
  return str(text)
    .split(/\r?\n|\s*[•▪●◦]\s+/)
    .map(l => l.replace(/^[-*–]\s+/, '').trim())
    .filter(Boolean);
}

function heading(title) {
  return para(run(title.toUpperCase(), `<w:b/>${SZ(11.5)}`),
    '<w:keepNext/><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr>' +
    '<w:spacing w:before="200" w:after="80"/>');
}

function body(text, rPr = '') {
  return para(run(text, SZ(10.5) + rPr), AFTER(60));
}

function bullet(text) {
  return para(run('•\t', SZ(10.5)) + run(text, SZ(10.5)),
    '<w:tabs><w:tab w:val="left" w:pos="270"/></w:tabs><w:ind w:left="270" w:hanging="270"/>' + AFTER(20));
}

/** Bold left text with right-aligned grey dates. */
function titleRow(left, right) {
  const runs = run(left, `<w:b/>${SZ(10.5)}`) + (right ? run('\t' + right, `${SZ(10.5)}<w:color w:val="555555"/>`) : '');
  return para(runs, `<w:keepNext/><w:tabs><w:tab w:val="right" w:pos="${TEXT_W}"/></w:tabs><w:spacing w:before="100" w:after="0"/>`);
}

function buildBodyXml(profile) {
  const p = profile || {};
  const out = [];

  if (str(p.name)) out.push(para(run(str(p.name), `<w:b/>${SZ(18)}`), AFTER(40)));
  const contact = [p.email, p.phone, p.location, p.linkedin, p.github, p.website].map(str).filter(Boolean).join('  |  ');
  if (contact) out.push(para(run(contact, `${SZ(9.5)}<w:color w:val="555555"/>`), AFTER(80)));

  if (str(p.summary)) { out.push(heading('Summary')); out.push(body(str(p.summary))); }

  const skills = (Array.isArray(p.skills) ? p.skills : []).map(str).filter(Boolean);
  if (skills.length) { out.push(heading('Skills')); out.push(body(skills.join(', '))); }

  const experience = Array.isArray(p.experience) ? p.experience : [];
  if (experience.length) {
    out.push(heading('Experience'));
    for (const exp of experience) {
      out.push(titleRow([str(exp.title), str(exp.company)].filter(Boolean).join(' — '), str(exp.dates)));
      if (str(exp.location)) out.push(para(run(str(exp.location), `<w:i/>${SZ(10)}<w:color w:val="555555"/>`), AFTER(20)));
      for (const line of descriptionLines(exp.description)) out.push(bullet(line));
    }
  }

  const education = Array.isArray(p.education) ? p.education : [];
  if (education.length) {
    out.push(heading('Education'));
    for (const ed of education) {
      out.push(titleRow([str(ed.degree), str(ed.school)].filter(Boolean).join(' — '), str(ed.dates)));
      if (str(ed.details)) out.push(body(str(ed.details)));
    }
  }

  const certs = (Array.isArray(p.certifications) ? p.certifications : []).map(str).filter(Boolean);
  if (certs.length) { out.push(heading('Certifications')); certs.forEach(c => out.push(bullet(c))); }

  const projects = Array.isArray(p.projects) ? p.projects : [];
  if (projects.length) {
    out.push(heading('Projects'));
    for (const proj of projects) {
      out.push(titleRow(str(proj.name), ''));
      if (str(proj.description)) out.push(body(str(proj.description)));
      const tech = (Array.isArray(proj.technologies) ? proj.technologies : []).map(str).filter(Boolean).join(', ');
      if (tech) out.push(body('Technologies: ' + tech, '<w:i/>'));
    }
  }

  return out.join('');
}

/**
 * @param {object} profile - parsed resume profile
 * @returns {Object<string, string>} zip path → XML
 */
export function buildResumeDocxParts(profile) {
  const documentXml = XML_DECL +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body>' +
        buildBodyXml(profile) +
        '<w:sectPr>' +
          '<w:pgSz w:w="12240" w:h="15840"/>' +
          '<w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/>' +
        '</w:sectPr>' +
      '</w:body>' +
    '</w:document>';

  const contentTypesXml = XML_DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';

  const rootRelsXml = XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  const documentRelsXml = XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';

  return {
    '[Content_Types].xml':          contentTypesXml,
    '_rels/.rels':                  rootRelsXml,
    'word/_rels/document.xml.rels': documentRelsXml,
    'word/document.xml':            documentXml,
  };
}
