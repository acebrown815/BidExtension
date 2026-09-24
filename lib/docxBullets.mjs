/**
 * DOCX paragraph editing helpers used by the tailored-resume generator.
 *
 * Pulled out of background.js so we can unit-test the matching/replacement
 * logic without spinning up JSZip or chrome.storage. The service worker
 * imports from here; tests import from here.
 *
 * The bug this module fixes (I7 from the audit):
 *   - The old code used `docXml.replace(paraXml, newParaXml)` which replaces
 *     only the first match. When two bullets had identical text across
 *     different roles, both replacements landed on the first paragraph.
 *   - It also didn't decode XML entities before matching, so a bullet
 *     containing "AT&T" would never match `<w:t>AT&amp;T</w:t>`.
 */

const PARAGRAPH_REGEX = /<w:p[ >][\s\S]*?<\/w:p>/g;
const TEXT_RUN_REGEX  = /<w:t[^>]*>([^<]*)<\/w:t>/g;

/** Decode the five named XML entities back to their characters. */
export function decodeXmlEntities(s) {
  return String(s)
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&amp;/g,  '&'); // last so we don't double-decode
}

/** Encode the five named XML entities for safe insertion into <w:t>. */
export function escapeXml(s) {
  return String(s)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}

/**
 * Extracts the visible text content of a <w:p> paragraph by concatenating
 * every <w:t> text run and decoding XML entities.
 */
export function extractParagraphText(paragraphXml) {
  const matches = paragraphXml.match(TEXT_RUN_REGEX) || [];
  const inner = matches
    .map(m => m.replace(/<w:t[^>]*>/, '').replace(/<\/w:t>/, ''))
    .join('');
  return decodeXmlEntities(inner);
}

/** Lowercase + collapse whitespace for fuzzy matching. */
export function normalizeForMatch(str) {
  return String(str || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Replaces all visible text in a <w:p> paragraph with `newText`. The new text
 * goes into the first <w:t> (preserving its formatting attrs); every other
 * <w:t> in the paragraph is emptied. Returns the new paragraph XML.
 */
export function replaceParagraphText(paragraphXml, newText) {
  const escaped = escapeXml(newText);
  let first = true;
  return paragraphXml.replace(/<w:t[^>]*>[^<]*<\/w:t>/g, (match) => {
    if (first) {
      first = false;
      const tag = match.match(/<w:t[^>]*>/)[0];
      const openTag = tag.includes('xml:space') ? tag : '<w:t xml:space="preserve">';
      return openTag + escaped + '</w:t>';
    }
    // Empty out the rest of the runs
    return match.replace(/>[^<]*</, '><');
  });
}

/**
 * Replaces a "Label: items" line's text while preserving the label/items
 * formatting split that's typical of these lines in a real resume — the
 * label run bold, the items run normal weight, as two separate <w:r> runs.
 * replaceParagraphText alone can't do this: it crams the WHOLE new text
 * into just the FIRST run, so if that run happens to be the bold label
 * run (the common case — resumes bold "Skills:"/"Languages:" labels),
 * the entire replaced line — items included — inherits its bold
 * formatting, and the second run just goes empty. Confirmed live: every
 * skill-category line tailoring wrote came out entirely bold because of
 * exactly this.
 *
 * Only splits across two runs when the paragraph actually HAS two or more
 * text runs to split across; a single-run paragraph has no separate
 * "normal weight" run to put the items in, so it falls back to the same
 * whole-line replace replaceParagraphText already does (better to inherit
 * the one run's formatting than to fail outright).
 *
 * @param {string} paragraphXml
 * @param {string} labelText - e.g. "Languages: " (including trailing separator/space)
 * @param {string} itemsText - e.g. "Java, Python, JavaScript"
 * @returns {string} The new paragraph XML.
 */
export function replaceLabeledLineText(paragraphXml, labelText, itemsText) {
  const runCount = (paragraphXml.match(/<w:t[^>]*>[^<]*<\/w:t>/g) || []).length;
  if (runCount < 2) {
    return replaceParagraphText(paragraphXml, labelText + itemsText);
  }
  const escapedLabel = escapeXml(labelText);
  const escapedItems = escapeXml(itemsText);
  let index = 0;
  return paragraphXml.replace(/<w:t[^>]*>[^<]*<\/w:t>/g, (match) => {
    const tag = match.match(/<w:t[^>]*>/)[0];
    const openTag = tag.includes('xml:space') ? tag : '<w:t xml:space="preserve">';
    const thisIndex = index++;
    if (thisIndex === 0) return openTag + escapedLabel + '</w:t>';
    if (thisIndex === 1) return openTag + escapedItems + '</w:t>';
    return match.replace(/>[^<]*</, '><'); // empty out any further runs
  });
}

/**
 * Walks all <w:p> paragraphs in the document and tries to match each input
 * bullet to one. Each paragraph can only be replaced once even if multiple
 * bullets would match it.
 *
 * Returns the modified docXml and the count of successful replacements.
 *
 * @param {string} docXml - Raw word/document.xml.
 * @param {Array<{original: string, improved: string}>} bullets
 * @returns {{ docXml: string, replacedCount: number }}
 */
export function replaceBulletsInDocXml(docXml, bullets) {
  if (!Array.isArray(bullets) || bullets.length === 0) {
    return { docXml, replacedCount: 0 };
  }

  // Collect paragraph spans up front so we can match without re-scanning
  // a mutating string and so we can mark spans as already used.
  PARAGRAPH_REGEX.lastIndex = 0;
  const paragraphs = []; // { start, end, xml, text, used }
  let m;
  while ((m = PARAGRAPH_REGEX.exec(docXml)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    paragraphs.push({
      start, end,
      xml: m[0],
      text: normalizeForMatch(extractParagraphText(m[0])),
      used: false,
    });
  }

  // For each bullet, find the first unused paragraph that matches.
  // Build a list of replacements with positions, then apply right→left so
  // earlier offsets stay valid as we splice in new (possibly longer) text.
  const replacements = []; // { start, end, newXml }
  let replacedCount = 0;

  for (const bullet of bullets) {
    const target = normalizeForMatch(bullet.original);
    if (!target) continue;
    for (const p of paragraphs) {
      if (p.used || !p.text || p.text.length <= 15) continue;
      // Fuzzy match: either side may contain the other (handles minor edits)
      if (p.text.includes(target) || target.includes(p.text)) {
        replacements.push({
          start: p.start,
          end: p.end,
          newXml: replaceParagraphText(p.xml, bullet.improved || ''),
        });
        p.used = true;
        replacedCount++;
        break;
      }
    }
  }

  // Apply replacements right→left so earlier indices remain valid
  replacements.sort((a, b) => b.start - a.start);
  let out = docXml;
  for (const r of replacements) {
    out = out.slice(0, r.start) + r.newXml + out.slice(r.end);
  }

  return { docXml: out, replacedCount };
}

/**
 * Replaces the resume's summary in place, matched fuzzily against the
 * ORIGINAL summary text (the same technique replaceBulletsInDocXml uses for
 * bullets) so the paragraph's own DOCX formatting survives.
 *
 * A "Professional Summary" section is often written as more than one DOCX
 * paragraph (e.g. one narrative paragraph, one "Hands-on experience
 * with..." paragraph). profile.summary holds the whole thing as a single
 * string. Once the starting paragraph is found, if its own text is only
 * PART of the full original summary (rather than containing all of it),
 * this keeps pulling in the immediately-following paragraphs for as long
 * as each one's text is still part of that same original summary block —
 * otherwise the new summary text would land correctly in the first
 * paragraph while a second, stale paragraph of the old summary is left
 * sitting right below it. The new summary text replaces the first
 * paragraph in that span; every other paragraph in the span is emptied
 * rather than left stale.
 *
 * @param {string} docXml
 * @param {string} originalSummary - The un-tailored profile.summary, used as the match anchor.
 * @param {string} newSummary - The AI-rewritten summary to insert.
 * @returns {{ docXml: string, summaryUpdated: boolean }}
 */
export function replaceSummaryInDocXml(docXml, originalSummary, newSummary) {
  if (!newSummary || !originalSummary || normalizeForMatch(originalSummary).length <= 15) {
    return { docXml, summaryUpdated: false };
  }
  const target = normalizeForMatch(originalSummary);

  PARAGRAPH_REGEX.lastIndex = 0;
  const paragraphs = [];
  let m;
  while ((m = PARAGRAPH_REGEX.exec(docXml)) !== null) {
    paragraphs.push({
      start: m.index,
      end: m.index + m[0].length,
      xml: m[0],
      text: normalizeForMatch(extractParagraphText(m[0])),
    });
  }

  const startIdx = paragraphs.findIndex(p => p.text.length > 15 && (p.text.includes(target) || target.includes(p.text)));
  if (startIdx === -1) return { docXml, summaryUpdated: false };

  // Span of paragraph indices that together make up the original summary.
  const spanIndices = [startIdx];
  if (!paragraphs[startIdx].text.includes(target)) {
    // The matched paragraph is only PART of a longer summary (the full
    // original summary contains it, not the other way around) — the
    // summary spans multiple adjacent paragraphs. Keep including following
    // paragraphs while each is empty or still part of that same original
    // summary text, so the whole block gets handled together. The cap of 6
    // is a safety valve, not an expected real length.
    for (let i = startIdx + 1; i < paragraphs.length && spanIndices.length < 6; i++) {
      const t = paragraphs[i].text;
      if (!t) { spanIndices.push(i); continue; } // blank separator paragraph — carry it along
      // Same >15-char guard as the starting match: a short paragraph (a
      // section header like "Experience", or a stray word) can trivially
      // satisfy target.includes(t) just because that word also happens to
      // appear somewhere in the summary's prose — that's not evidence it's
      // actually part of the summary block.
      if (t.length <= 15 || !target.includes(t)) break;
      spanIndices.push(i);
    }
  }

  const first = paragraphs[startIdx];
  const replacements = [{ start: first.start, end: first.end, xml: replaceParagraphText(first.xml, newSummary) }];
  for (let i = 1; i < spanIndices.length; i++) {
    const p = paragraphs[spanIndices[i]];
    if (!p.text) continue; // already empty — nothing to clear
    replacements.push({ start: p.start, end: p.end, xml: replaceParagraphText(p.xml, '') });
  }

  replacements.sort((a, b) => b.start - a.start);
  let out = docXml;
  for (const r of replacements) {
    out = out.slice(0, r.start) + r.xml + out.slice(r.end);
  }

  return { docXml: out, summaryUpdated: true };
}

/**
 * Guards against a real failure mode: the AI asked to "rewrite the
 * summary" sometimes returns a comma/pipe-separated list of skills/
 * keywords instead of prose, which then gets written into the resume's
 * actual Summary paragraph verbatim — confirmed live: a generated resume's
 * Summary section became a duplicate of its Skills line. Rather than trust
 * the AI's own "write flowing sentences" instruction, this checks the
 * shape of what came back and rejects anything that reads like a keyword
 * dump: too short, no sentence-ending punctuation, or too comma-dense
 * relative to its word count for genuine prose.
 *
 * @param {string} text - The AI's candidate summary text.
 * @returns {boolean} true if this looks like real prose, safe to use.
 */
export function looksLikeProseSummary(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < 30) return false;
  if (!/[.!?]/.test(trimmed)) return false; // prose ends its sentences
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 8) return false;
  const commaCount = (trimmed.match(/,/g) || []).length;
  // A skills dump ("React, Node.js, AWS, Docker, ...") has roughly one
  // comma per word; real sentences use far fewer.
  if (commaCount / words.length > 0.4) return false;
  return true;
}

// Matches a paragraph that STARTS with a "Languages"/"Programming
// Languages" section header, immediately followed by either a colon or the
// end of the line — used by replaceLanguagesInDocXml to find the right
// paragraph positionally, and by handleGenerateTailoredResume's general
// missing-skills append to avoid ALSO touching that same paragraph.
export const LANGUAGES_HEADER_RE = /^(programming\s+languages|languages)\s*(:|$)/i;

/**
 * Replaces a resume's "Languages:" (or "Programming Languages:") line
 * outright with a new, per-job list — unlike the general skills paragraph,
 * this is a full replace (not an append), since the whole point is to drop
 * languages this job has no use for, not just add to an ever-growing line.
 * Preserves any label prefix already present (e.g. "Languages: ") and the
 * paragraph's formatting via replaceParagraphText.
 *
 * @param {string} docXml
 * @param {string[]} languages - The AI's revised languages list for this job.
 * @returns {{ docXml: string, languagesUpdated: boolean }}
 */
export function replaceLanguagesInDocXml(docXml, languages) {
  if (!Array.isArray(languages) || languages.length === 0) {
    return { docXml, languagesUpdated: false };
  }
  PARAGRAPH_REGEX.lastIndex = 0;
  let match;
  while ((match = PARAGRAPH_REGEX.exec(docXml)) !== null) {
    const paraXml = match[0];
    const paraText = extractParagraphText(paraXml);
    if (LANGUAGES_HEADER_RE.test(paraText.trim())) {
      const labelMatch = paraText.match(/^[^:]{1,40}:\s*/);
      const label = labelMatch ? labelMatch[0] : '';
      const newParaXml = replaceLabeledLineText(paraXml, label, languages.join(', '));
      const out = docXml.slice(0, match.index) + newParaXml + docXml.slice(match.index + paraXml.length);
      return { docXml: out, languagesUpdated: true };
    }
  }
  return { docXml, languagesUpdated: false };
}

/**
 * Drops entries from an AI-returned skill/language list that are clearly
 * not a short skill/technology name — a full sentence or JD-quoted
 * requirement fragment slipped in instead of a real term. Confirmed live:
 * a job-analysis pass's missingSkills returned genuine short terms like
 * "JMeter" and "Splunk" right alongside long fragments like "Enterprise
 * performance testing for large-scale web/mobile/digital apps", and a
 * languages-list pass returned non-language tool/methodology names like
 * "Load Testing" and "JVM Tuning". Both got written verbatim into a
 * resume's Languages/Skills line via handleGenerateTailoredResume, turning
 * it into an unreadable run-on line. A real skill or language name is
 * always short — nothing legitimate needs more than a handful of words —
 * so this is a cheap, reliable filter regardless of how well any one
 * prompt is worded.
 * @param {string[]} terms
 * @param {number} [maxWords=4]
 * @param {number} [maxChars=40]
 * @returns {string[]}
 */
export function filterPlausibleSkillTerms(terms, maxWords = 4, maxChars = 40) {
  return (terms || []).filter(t => {
    const s = String(t || '').trim();
    if (!s) return false;
    if (s.length > maxChars) return false;
    if (s.split(/\s+/).length > maxWords) return false;
    return true;
  });
}

/**
 * Appends still-missing skills to the first "general" skills paragraph —
 * one that already lists at least 3 of the candidate's known skills — by
 * appending to its last text run (preserving formatting; the first run is
 * often bold, e.g. "Skills:"). An append, not a replace, since existing
 * skills should stay. Skips a paragraph already fully replaced by
 * replaceLanguagesInDocXml (languagesUpdated) so the languages line isn't
 * touched twice. Callers should pass missingSkills already filtered
 * through filterPlausibleSkillTerms — this only bounds how many go into
 * one paragraph (maxAppended) and skips ones already present verbatim.
 *
 * @param {string} docXml
 * @param {string[]} missingSkills - candidate skills to add (already filtered to plausible short terms).
 * @param {string[]} profileSkills - the candidate's full skill list, used to find a "general skills" paragraph.
 * @param {boolean} languagesUpdated - whether replaceLanguagesInDocXml already updated the Languages line this run.
 * @param {number} [maxAppended=6] - upper bound on how many skills get appended to one paragraph.
 * @returns {{ docXml: string, skillsAppended: string[] }}
 */
export function appendMissingSkillsInDocXml(docXml, missingSkills, profileSkills, languagesUpdated, maxAppended = 6) {
  if (!Array.isArray(missingSkills) || missingSkills.length === 0 || !Array.isArray(profileSkills) || profileSkills.length === 0) {
    return { docXml, skillsAppended: [] };
  }
  PARAGRAPH_REGEX.lastIndex = 0;
  let match;
  while ((match = PARAGRAPH_REGEX.exec(docXml)) !== null) {
    const paraXml = match[0];
    const paraText = extractParagraphText(paraXml);
    if (languagesUpdated && LANGUAGES_HEADER_RE.test(paraText.trim())) continue;
    const skillsFound = profileSkills.filter(s => paraText.toLowerCase().includes(s.toLowerCase()));
    if (skillsFound.length < 3) continue;

    const newSkills = missingSkills
      .filter(s => !paraText.toLowerCase().includes(s.toLowerCase()))
      .slice(0, maxAppended);
    if (newSkills.length === 0) return { docXml, skillsAppended: [] };

    const escaped = escapeXml(', ' + newSkills.join(', '));
    const lastTIndex = paraXml.lastIndexOf('</w:t>');
    if (lastTIndex === -1) return { docXml, skillsAppended: [] };
    const newParaXml = paraXml.substring(0, lastTIndex) + escaped + paraXml.substring(lastTIndex);
    const out = docXml.slice(0, match.index) + newParaXml + docXml.slice(match.index + paraXml.length);
    return { docXml: out, skillsAppended: newSkills };
  }
  return { docXml, skillsAppended: [] };
}

/** Escapes a string for literal use inside a `new RegExp(...)` pattern. */
function escapeRegExpLiteral(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A single skill-category line: a short label ("Languages", "Python &
// Backend", "Cloud & DevOps", ...), a colon, then a comma-separated list.
// Deliberately generic (no hardcoded label names) since resumes vary
// widely in what they call each category.
const SKILL_CATEGORY_LINE_RE = /^([A-Za-z][A-Za-z0-9 &/+#.'-]{1,38}):\s*(.+)$/;

// Standalone section-header paragraphs that start a resume's skills
// section — matched as the WHOLE paragraph text, not a substring, so a
// bullet that merely mentions "core competencies" mid-sentence is never
// mistaken for the section header.
const SKILLS_SECTION_HEADER_RE = /^(technical\s+)?skills$|^core\s+competencies$/i;

/**
 * Extracts every "Label: item1, item2, ..." skill-category line from a
 * resume's SKILLS section, in document order. Finds the section by its own
 * standalone header paragraph ("Skills", "Technical Skills", "Core
 * Competencies") and keeps consuming subsequent paragraphs for as long as
 * each one matches the category-line shape, stopping at the first
 * paragraph that doesn't (the next section, a blank line, anything else) —
 * so this never runs away into unrelated resume content.
 *
 * @param {string} docXml
 * @returns {Array<{label: string, items: string[]}>}
 */
export function extractSkillCategoriesFromDocXml(docXml) {
  PARAGRAPH_REGEX.lastIndex = 0;
  const paragraphTexts = [];
  let match;
  while ((match = PARAGRAPH_REGEX.exec(docXml)) !== null) {
    paragraphTexts.push(extractParagraphText(match[0]).trim());
  }

  const headerIdx = paragraphTexts.findIndex(t => SKILLS_SECTION_HEADER_RE.test(t));
  if (headerIdx === -1) return [];

  const categories = [];
  for (let i = headerIdx + 1; i < paragraphTexts.length; i++) {
    const text = paragraphTexts[i];
    if (!text) continue;
    const lineMatch = text.match(SKILL_CATEGORY_LINE_RE);
    if (!lineMatch) break;
    const items = lineMatch[2].split(',').map(s => s.trim()).filter(Boolean);
    if (items.length === 0) continue;
    categories.push({ label: lineMatch[1].trim(), items });
  }
  return categories;
}

/**
 * Replaces one skill-category paragraph — found by matching its ORIGINAL
 * label — with a new label and item list. Matching by the original label
 * (rather than by content) is what lets a category be renamed (e.g.
 * "Python & Backend" -> "Java & Backend" for a Java-focused job) while
 * still reliably finding the right paragraph to replace.
 *
 * @param {string} docXml
 * @param {string} originalLabel
 * @param {string} newLabel
 * @param {string[]} newItems
 * @returns {{ docXml: string, updated: boolean }}
 */
export function replaceSkillCategoryInDocXml(docXml, originalLabel, newLabel, newItems) {
  if (!originalLabel || !Array.isArray(newItems) || newItems.length === 0) {
    return { docXml, updated: false };
  }
  const labelRe = new RegExp('^' + escapeRegExpLiteral(originalLabel) + '\\s*:', 'i');
  PARAGRAPH_REGEX.lastIndex = 0;
  let match;
  while ((match = PARAGRAPH_REGEX.exec(docXml)) !== null) {
    const paraXml = match[0];
    const paraText = extractParagraphText(paraXml).trim();
    if (!labelRe.test(paraText)) continue;
    const label = (newLabel && String(newLabel).trim()) || originalLabel;
    const newParaXml = replaceLabeledLineText(paraXml, label + ': ', newItems.join(', '));
    const out = docXml.slice(0, match.index) + newParaXml + docXml.slice(match.index + paraXml.length);
    return { docXml: out, updated: true };
  }
  return { docXml, updated: false };
}

/**
 * Applies an AI-tailored skills-section rewrite to a DOCX. revisedCategories
 * is matched POSITIONALLY to originalCategories (both are expected to be
 * the same categories in the same order — the AI is asked to return every
 * category it was given, even unchanged ones) rather than by label, since
 * the whole point is to allow a category's label to change (e.g. dropping
 * an irrelevant language's category in favor of the job's actual one).
 * Every item list is sanitized through filterPlausibleSkillTerms and
 * capped at maxItemsPerCategory, so a bad AI response can't turn a
 * category into a run-on line — the same protection already applied to
 * missingSkills in appendMissingSkillsInDocXml above.
 *
 * @param {string} docXml
 * @param {Array<{label: string, items: string[]}>} originalCategories
 * @param {Array<{label?: string, items?: string[]}>} revisedCategories
 * @param {number} [maxItemsPerCategory=20]
 * @returns {{ docXml: string, updatedLabels: string[] }}
 */
export function applySkillCategoryRevisions(docXml, originalCategories, revisedCategories, maxItemsPerCategory = 20) {
  const updatedLabels = [];
  (revisedCategories || []).forEach((revised, i) => {
    const original = (originalCategories || [])[i];
    if (!original || !revised) return;
    const items = filterPlausibleSkillTerms(revised.items).slice(0, maxItemsPerCategory);
    if (items.length === 0) return;
    const newLabel = (revised.label && String(revised.label).trim()) || original.label;
    const result = replaceSkillCategoryInDocXml(docXml, original.label, newLabel, items);
    if (result.updated) {
      docXml = result.docXml;
      updatedLabels.push(newLabel);
    }
  });
  return { docXml, updatedLabels };
}
