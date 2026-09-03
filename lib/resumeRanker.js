/**
 * Local, no-AI resume-vs-job-description ranker.
 *
 * Algorithm (JD-keywords-first, weighted):
 *   1. Build a keyword vocabulary from every saved resume's own ATS
 *      keywords (skills + certifications + project technologies — see
 *      lib/resumeKeywords.js, the same extraction the Profile tab's "ATS
 *      Keywords" list is built from).
 *   2. Extract the JD's *own* ATS keywords: every vocabulary term that
 *      actually appears in the job description text. This is "what does
 *      this posting ask for", grounded in real skill/cert/tech terms
 *      instead of guessing at free-form NLP over the JD.
 *   3. Score each resume as its *weighted* coverage of those JD keywords,
 *      not a flat count. Two weights apply, and both are needed to reach
 *      100% -- coverage alone is not enough:
 *        - JD emphasis: a keyword the JD repeats several times (e.g.
 *          mentioned in the title, the summary, AND the requirements)
 *          counts for more than one mentioned only once in passing --
 *          capped so one very-repeated word can't dominate the score. On
 *          top of that, a keyword found inside a detected Requirements /
 *          Qualifications section of the JD (as opposed to a Nice to
 *          Have / About Us / Benefits section, or plain prose with no
 *          section headers at all) counts for double -- required skills
 *          should outweigh ones only mentioned in passing. See
 *          extractRequiredSectionText() and REQUIRED_SECTION_WEIGHT_MULTIPLIER.
 *          Independently, a keyword that's a programming language,
 *          database, cloud platform/infra, or AI/ML term (a curated,
 *          non-exhaustive list — see HIGH_VALUE_CATEGORY_TERMS) also counts
 *          for double, stacking with the required-section boost, since
 *          these are almost always genuine hard requirements wherever they
 *          appear.
 *        - Resume depth: a keyword the resume backs up in more than one
 *          place (e.g. listed as a skill AND demonstrated in a project,
 *          or mentioned again in the summary or an experience bullet)
 *          earns more credit than one that's just a bare skill-list
 *          entry. Every JD keyword's MAXIMUM possible credit (full depth)
 *          is what the score is measured against, not just "present or
 *          not" -- so a resume that merely lists every matched keyword
 *          once, with no deeper evidence anywhere, lands around 87%, not
 *          100%. Reaching 100% requires covering every JD keyword *and*
 *          backing each one with real depth (skills + certs + projects).
 *          A mention inside an experience bullet counts for less the
 *          further back that role is (see RECENCY_WEIGHT_DECAY_PER_ROLE
 *          in lib/resumeKeywords.js) -- a skill you used in your current
 *          job should count for more than one you used a decade ago.
 *      This keeps the two signals from being conflated into a single
 *      number that quietly discards one of them: a keyword you don't
 *      have at all, and a keyword you have but only shallowly, both pull
 *      the score down -- just by different amounts -- instead of a
 *      shallow-but-complete resume being indistinguishable from a
 *      deep-and-complete one.
 *   4. Optionally, a job-title seniority signal: if the JD's title (e.g.
 *      "Senior Backend Engineer") and the resume's most recent role title
 *      both carry a recognizable seniority level -- junior, senior,
 *      staff/principal, director+ -- and they match, the resume's score
 *      gets a small bonus; if they're two or more tiers apart (say, the
 *      JD wants a Director and the resume's most recent title is
 *      Junior), it gets a small penalty. One tier apart, or no
 *      recognizable level on either side, leaves the score untouched --
 *      this is a coarse nudge on top of the keyword score, not a
 *      replacement for it. See SENIORITY_TIERS, detectSeniorityTier(),
 *      and seniorityAlignmentMultiplier().
 *
 * Zero AI calls and zero network latency, even with dozens of saved
 * resumes. This is a lightweight heuristic to help the user pick which
 * resume to run the real AI analysis with; it is not a substitute for the
 * AI-generated 0-100 match score.
 *
 * Loaded as a content script before content.js, and after
 * lib/resumeKeywords.js (its dependency) — hangs the API on globalThis.
 * Mirrored at lib/resumeRanker.mjs for tests; a parity test keeps the two
 * copies in sync.
 */
(function () {
  'use strict';

  function normalize(text) {
    return String(text || '').toLowerCase();
  }

  // Defensive fallback (mirrors content.js's own pattern for JMResumeRanker)
  // so a load-order mistake degrades to "everyone scores 0" instead of a
  // hard throw.
  const extractAtsKeywords = (globalThis.JMResumeKeywords && globalThis.JMResumeKeywords.extractAtsKeywords)
    || (() => []);

  /**
   * Union of every resume's own ATS keywords, lowercased and deduplicated.
   * This is the candidate pool "extract JD keywords" scans the JD text
   * against — it keeps keyword extraction grounded in real terms already
   * known from the user's resumes rather than free-form NLP.
   * @param {Array<{profile?: object}>} resumes
   * @returns {Map<string, string>} lowercase term -> canonical (first-seen) term
   */
  function buildKeywordVocabulary(resumes) {
    const vocab = new Map();
    (resumes || []).forEach(r => {
      extractAtsKeywords(r && r.profile).forEach(k => {
        const lower = normalize(k.term).trim();
        if (lower.length > 1 && !vocab.has(lower)) vocab.set(lower, k.term);
      });
    });
    return vocab;
  }

  /**
   * Extracts the JD's own ATS keywords: every term from the resume keyword
   * vocabulary that appears in the JD text as a whole word/phrase — bounded
   * by non-alphanumeric characters or the string's edges on both sides, via
   * containsWholeWord() below — not merely as a substring buried inside an
   * unrelated word (e.g. the short term "go" must not match inside "going",
   * "good", or "organize"; "ai" must not match inside "email" or "domain").
   * @param {string} jdText raw job description text
   * @param {Array<object>} resumes resumes to draw the keyword vocabulary from
   * @returns {string[]} matched terms, lowercased
   */
  function extractJDKeywords(jdText, resumes) {
    const jdTextLower = normalize(jdText);
    if (!jdTextLower) return [];
    const vocab = buildKeywordVocabulary(resumes);
    const matched = [];
    vocab.forEach((canonical, lower) => {
      if (containsWholeWord(jdTextLower, lower)) matched.push(lower);
    });
    return matched;
  }

  // A JD keyword's weight is how many times it's mentioned in the JD text,
  // capped so one very-repeated word (often just a common word that happens
  // to also be a skill name) can't swamp every other keyword's contribution.
  const JD_TERM_WEIGHT_CAP = 5;

  /**
   * Counts whole-word/phrase occurrences of needleLower in haystackLower —
   * same word-boundary rule as containsWholeWord/extractJDKeywords, so a
   * short or generic term isn't over-counted just because it happens to sit
   * inside other words in the JD text. Mirrors
   * lib/resumeKeywords.js's countWholeWordOccurrences: the trailing boundary
   * is a lookahead (zero-width) rather than a consumed character, so
   * back-to-back occurrences separated by a single delimiter (e.g.
   * "ai ai ai") are still all counted — a fully-consuming pattern on both
   * sides would eat the shared delimiter on the first match and miss the
   * next one.
   */
  function countOccurrences(haystackLower, needleLower) {
    if (!needleLower) return 0;
    const re = new RegExp('(?:^|[^a-z0-9])' + escapeRegExp(needleLower) + '(?=$|[^a-z0-9])', 'g');
    const matches = haystackLower.match(re);
    return matches ? matches.length : 0;
  }

  // Section headers used to find the "required skills / qualifications"
  // part of a JD's text, so a keyword mentioned there can be weighted more
  // heavily than one only mentioned in passing, or under a "nice to
  // have"/"about us"/"benefits" section (see
  // REQUIRED_SECTION_WEIGHT_MULTIPLIER below). Each phrase is matched at
  // the START of a line, after trimming and stripping a trailing
  // colon/dash — and the line must be short (<= MAX_HEADER_LINE_LEN) — so
  // a real sentence that happens to use one of these words (e.g. "Deep
  // Python knowledge required.") can't be mistaken for an actual section
  // header. Order matters: NON_REQUIRED is checked first, since a header
  // like "Preferred Qualifications" would otherwise also match the bare
  // "qualifications" required-trigger.
  const REQUIRED_HEADER_PHRASES = [
    'required qualifications', 'minimum qualifications', 'basic qualifications',
    'requirements', 'qualifications', 'required skills', 'skills required',
    'technical requirements', 'must have', 'must-have',
    "what you'll need", 'what you need', "what you'll bring", 'what you bring',
    "what we're looking for", 'what we are looking for', 'who you are',
    'your background', 'ideal candidate', 'you have', "you'll need", 'you should have',
  ];
  const NON_REQUIRED_HEADER_PHRASES = [
    'nice to have', 'preferred qualifications', 'preferred skills', 'bonus points',
    'bonus if', 'about us', 'about the company', 'about the role', 'about the team',
    'benefits', 'perks', 'what we offer', 'compensation', 'salary',
    'equal opportunity', 'eeo', 'our mission', 'our values', 'how to apply',
    'application process', 'responsibilities', "what you'll do", 'the role',
    'day to day', 'day-to-day', 'culture', 'diversity',
  ];
  const MAX_HEADER_LINE_LEN = 50;

  /** True if `line`, trimmed and stripped of a trailing colon/dash, starts
   * with one of `phrases` at a word boundary and isn't too long to
   * plausibly be a section header rather than a full sentence. */
  function matchesHeader(line, phrases) {
    const t = line.trim().replace(/[:\-–—]+$/, '').trim().toLowerCase();
    if (!t || t.length > MAX_HEADER_LINE_LEN) return false;
    return phrases.some(p => {
      if (t === p) return true;
      if (!t.startsWith(p)) return false;
      const next = t.charAt(p.length);
      return next === '' || /[^a-z]/.test(next);
    });
  }

  /**
   * Best-effort extraction of the "required skills / qualifications"
   * portion of a JD's text. Scans line by line for header-like lines and
   * accumulates the text of every "required" block until the next header
   * of either kind. A JD with no headers at all (e.g. one unstructured
   * paragraph) returns '' — callers treat that as "no boost available",
   * falling back to plain repetition weighting, not as an error.
   * @param {string} jdText raw job description text — line breaks matter,
   *   see content.js's extractJobDescriptionConfident() (.innerText
   *   preserves most block-level structure)
   * @returns {string} concatenated text of all detected required-ish
   *   sections, or '' if none were found
   */
  function extractRequiredSectionText(jdText) {
    const lines = String(jdText || '').split(/\r?\n/);
    let inRequired = false;
    const collected = [];
    for (const line of lines) {
      if (matchesHeader(line, NON_REQUIRED_HEADER_PHRASES)) {
        inRequired = false;
        continue;
      }
      if (matchesHeader(line, REQUIRED_HEADER_PHRASES)) {
        inRequired = true;
        continue;
      }
      if (inRequired) collected.push(line);
    }
    return collected.join('\n');
  }

  // A keyword mentioned inside a detected Requirements/Qualifications
  // section counts for double, on top of its repetition weight — this is
  // the "give more weight to required skills, highlighted as
  // qualifications" signal. Applied after JD_TERM_WEIGHT_CAP, so a
  // keyword's max possible weight is
  // JD_TERM_WEIGHT_CAP * REQUIRED_SECTION_WEIGHT_MULTIPLIER.
  const REQUIRED_SECTION_WEIGHT_MULTIPLIER = 2;

  // Curated (non-exhaustive) list of concrete technical categories that are
  // almost always genuine hard requirements wherever they show up in a JD:
  // programming languages, databases, cloud platforms/infrastructure, and
  // AI/ML. A JD keyword matching one of these gets an extra weight boost —
  // independent of, and stacking with, the required-section boost above —
  // on top of plain repetition. This is a fixed list, not automatic
  // classification: a real term missing from it just doesn't get this
  // particular boost, it can still earn credit from repetition and/or the
  // required-section signal on its own. Extend this list directly if a
  // category term you use is missing.
  const HIGH_VALUE_CATEGORY_TERMS = [
    // Programming languages
    'python', 'java', 'javascript', 'typescript', 'c++', 'c#', 'golang', 'go',
    'rust', 'ruby', 'php', 'swift', 'kotlin', 'scala', 'matlab', 'perl',
    'objective-c', 'dart', 'elixir', 'haskell', 'clojure', 'lua', 'bash',
    'shell', 'powershell', 'sql', 'html', 'css', 'groovy', 'fortran', 'cobol',
    'vba', 'assembly',
    // Databases
    'mysql', 'postgresql', 'postgres', 'mongodb', 'sqlite', 'oracle',
    'sql server', 'mssql', 'redis', 'cassandra', 'dynamodb', 'mariadb',
    'elasticsearch', 'neo4j', 'cosmosdb', 'cosmos db', 'firebase', 'firestore',
    'snowflake', 'bigquery', 'redshift', 'couchdb', 'supabase', 'nosql',
    'db2', 'sybase', 'teradata', 'clickhouse', 'cockroachdb', 'influxdb',
    'timescaledb',
    // Cloud platforms & infrastructure
    'aws', 'amazon web services', 'azure', 'microsoft azure', 'gcp',
    'google cloud', 'google cloud platform', 'heroku', 'digitalocean',
    'cloudflare', 'ibm cloud', 'oracle cloud', 'alibaba cloud', 'kubernetes',
    'k8s', 'docker', 'terraform', 'cloudformation', 'lambda', 'ec2', 's3',
    'azure functions', 'cloud run', 'app engine', 'openshift', 'serverless',
    'ecs', 'eks', 'aks',
    // AI / ML
    'machine learning', 'deep learning', 'artificial intelligence', 'ai',
    'ml', 'nlp', 'natural language processing', 'computer vision',
    'tensorflow', 'pytorch', 'keras', 'scikit-learn', 'sklearn', 'openai',
    'llm', 'large language model', 'gpt', 'generative ai', 'langchain',
    'hugging face', 'huggingface', 'neural network', 'neural networks',
    'reinforcement learning', 'mlops', 'chatgpt', 'transformers', 'xgboost',
    'opencv',
  ];
  const HIGH_VALUE_CATEGORY_SET = new Set(HIGH_VALUE_CATEGORY_TERMS);

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** True if `needle` appears in `haystack` bounded by non-alphanumeric
   * characters (or the string's edges) on both sides — so e.g. "ai" matches
   * inside "ai engineer" or "gen ai" but not inside "email" or "domain". */
  function containsWholeWord(haystack, needle) {
    if (!haystack || !needle) return false;
    const re = new RegExp('(^|[^a-z0-9])' + escapeRegExp(needle) + '($|[^a-z0-9])');
    return re.test(haystack);
  }

  /**
   * True if `termLower` is, contains, or is contained in (as a whole word/
   * phrase) one of HIGH_VALUE_CATEGORY_TERMS — so both a short resume
   * vocabulary term like "aws" and a longer one like "aws certified
   * solutions architect" or "amazon web services (aws)" match.
   * @param {string} termLower
   * @returns {boolean}
   */
  function isHighValueCategoryTerm(termLower) {
    if (HIGH_VALUE_CATEGORY_SET.has(termLower)) return true;
    for (const cat of HIGH_VALUE_CATEGORY_TERMS) {
      if (containsWholeWord(termLower, cat) || containsWholeWord(cat, termLower)) return true;
    }
    return false;
  }

  // Multiplier applied when a JD keyword matches HIGH_VALUE_CATEGORY_TERMS.
  // Stacks with REQUIRED_SECTION_WEIGHT_MULTIPLIER (e.g. a programming
  // language mentioned inside a Requirements section gets both), and with
  // JD_TERM_WEIGHT_CAP applied first — so the max possible single-keyword
  // weight is JD_TERM_WEIGHT_CAP * REQUIRED_SECTION_WEIGHT_MULTIPLIER *
  // CATEGORY_WEIGHT_MULTIPLIER = 5 * 2 * 2 = 20.
  const CATEGORY_WEIGHT_MULTIPLIER = 2;

  /**
   * How much this JD keyword should count toward the score: its repetition
   * count in the JD text (capped), doubled if it's also mentioned inside a
   * detected Requirements/Qualifications section, and doubled again if it's
   * a programming language / database / cloud platform / AI-ML term (see
   * HIGH_VALUE_CATEGORY_TERMS) — the two boosts are independent and stack.
   * Every kw passed in here was matched via a substring check against this
   * same jdTextLower, so it occurs at least once; the `|| 1` floor is just
   * defense against that invariant ever being violated by a future caller.
   * @param {string} jdTextLower
   * @param {string} termLower
   * @param {string} [requiredTextLower] lowercased output of
   *   extractRequiredSectionText(jdText) — omit (or pass '') to skip the
   *   required-section boost entirely, e.g. when no section was detected.
   * @returns {number} weight >= 1
   */
  function jdKeywordWeight(jdTextLower, termLower, requiredTextLower) {
    let weight = Math.min(countOccurrences(jdTextLower, termLower), JD_TERM_WEIGHT_CAP) || 1;
    if (requiredTextLower && containsWholeWord(requiredTextLower, termLower)) {
      weight *= REQUIRED_SECTION_WEIGHT_MULTIPLIER;
    }
    if (isHighValueCategoryTerm(termLower)) {
      weight *= CATEGORY_WEIGHT_MULTIPLIER;
    }
    return weight;
  }

  // A resume keyword backed up in more than one place (e.g. the skills
  // list AND a project's technologies) earns more credit than the base
  // 1.0x for simply having it once — each additional occurrence beyond the
  // first adds RESUME_DEPTH_BONUS_PER_EXTRA, up to RESUME_DEPTH_BONUS_CAP
  // extra occurrences, for a maximum of MAX_RESUME_DEPTH_MULTIPLIER. That
  // maximum is what each keyword's credit is measured AGAINST (see
  // scoreResumeAgainstJD) — not just 1.0x — so merely having a keyword
  // caps out below 100% on its own; reaching the max requires real depth.
  const RESUME_DEPTH_BONUS_PER_EXTRA = 0.05;
  const RESUME_DEPTH_BONUS_CAP = 3;
  const MAX_RESUME_DEPTH_MULTIPLIER = 1 + RESUME_DEPTH_BONUS_PER_EXTRA * RESUME_DEPTH_BONUS_CAP; // 1.15

  /**
   * @param {number} occurrenceCount how many places in the resume mention
   *   this term (lib/resumeKeywords.js's `count`) — 0 if absent.
   * @returns {number} multiplier: 0 if absent, else 1.0 .. MAX_RESUME_DEPTH_MULTIPLIER
   */
  function resumeDepthMultiplier(occurrenceCount) {
    if (!occurrenceCount || occurrenceCount <= 0) return 0;
    const extra = Math.min(occurrenceCount - 1, RESUME_DEPTH_BONUS_CAP);
    return 1 + extra * RESUME_DEPTH_BONUS_PER_EXTRA;
  }

  // Coarse seniority levels, purely inferred from job-title wording — not
  // a substitute for actually reading a role's real scope. Checked in
  // this order (most senior/specific first) so e.g. "Senior Staff
  // Engineer" resolves to STAFF, not SENIOR. A title with none of these
  // phrases (e.g. a bare "Software Engineer") is treated as "no signal"
  // rather than guessed at as mid-level — plenty of genuinely mid-level
  // titles carry no level word at all, and guessing wrong would be worse
  // than staying neutral.
  const SENIORITY_TIERS = [
    { tier: 4, phrases: ['director', 'vice president', 'vp', 'head of', 'chief', 'cto', 'ceo', 'coo', 'executive'] },
    { tier: 3, phrases: ['principal', 'staff', 'distinguished', 'lead', 'architect'] },
    { tier: 2, phrases: ['senior', 'sr'] },
    { tier: 1, phrases: ['mid-level', 'mid level', 'mid-senior'] },
    { tier: 0, phrases: ['intern', 'internship', 'entry level', 'entry-level', 'junior', 'jr', 'associate', 'trainee', 'apprentice'] },
  ];

  /**
   * Best-effort seniority tier (0 = intern/junior .. 4 = director+) from a
   * short piece of title text, or null if nothing recognizable is found.
   * Deliberately only ever called on a job title / role title, not a full
   * JD or bullet description — those are long enough that a word like
   * "lead" showing up in unrelated prose ("you will lead initiatives")
   * would produce a false signal.
   * @param {string} titleText
   * @returns {number|null}
   */
  function detectSeniorityTier(titleText) {
    const t = normalize(titleText);
    if (!t) return null;
    for (const { tier, phrases } of SENIORITY_TIERS) {
      if (phrases.some(p => containsWholeWord(t, p))) return tier;
    }
    return null;
  }

  // How much a seniority match/mismatch nudges the final score, applied as
  // a multiplier on top of the keyword-based score above — a small, coarse
  // adjustment, not a replacement for it. One tier apart (e.g. Senior vs.
  // Staff) is treated as close enough to be neutral; two or more tiers
  // apart (e.g. Junior vs. Director) is treated as a real mismatch.
  const SENIORITY_MATCH_BONUS = 1.08;
  const SENIORITY_MISMATCH_PENALTY = 0.9;

  /**
   * @param {string} jobTitle JD's job title text.
   * @param {{profile?: {experience?: Array<{title?: string}>}}} resume
   * @returns {number} multiplier to apply to the keyword-based score: 1.0
   *   (neutral) when either side has no recognizable seniority level or
   *   they're at most one tier apart, SENIORITY_MATCH_BONUS when they
   *   match exactly, SENIORITY_MISMATCH_PENALTY when they're 2+ tiers apart.
   */
  function seniorityAlignmentMultiplier(jobTitle, resume) {
    const jdTier = detectSeniorityTier(jobTitle);
    if (jdTier === null) return 1;
    const experience = (resume && resume.profile && resume.profile.experience) || [];
    // Most recent role is assumed to be first, per standard resume
    // convention (also relied on by RECENCY_WEIGHT_DECAY_PER_ROLE in
    // lib/resumeKeywords.js) — a resume listing roles oldest-first would
    // throw this off, but that ordering is rare in practice.
    const resumeTier = experience.length ? detectSeniorityTier(experience[0] && experience[0].title) : null;
    if (resumeTier === null) return 1;
    const diff = Math.abs(jdTier - resumeTier);
    if (diff === 0) return SENIORITY_MATCH_BONUS;
    if (diff === 1) return 1;
    return SENIORITY_MISMATCH_PENALTY;
  }

  /**
   * Scores a single resume against a JD's own ATS keywords (as produced by
   * extractJDKeywords), weighted by JD emphasis and resume depth — see the
   * file doc comment. Each JD keyword's actual credit (0 if missing, up to
   * MAX_RESUME_DEPTH_MULTIPLIER if deeply represented) is measured against
   * its own MAXIMUM possible credit, not just against "present or not" —
   * so both an entirely-missing keyword and a merely-once-mentioned one
   * pull the score below 100%, by different amounts, instead of the depth
   * signal disappearing the moment coverage is complete.
   * @param {{profile?: {skills?: string[], certifications?: string[], experience?: Array<{title?: string}>, projects?: Array<{technologies?: string[]}>}}} resume
   * @param {string[]} jdKeywordsLower lowercased JD keywords, e.g. from extractJDKeywords()
   * @param {string} [jdText] raw JD text, used to weight each keyword by how
   *   often the JD repeats it. Falling back to a flat weight of 1 per
   *   keyword when omitted keeps this backward-compatible with any caller
   *   that doesn't have the raw text handy.
   * @param {string} [jobTitle] JD's job title text, used only for the
   *   seniority-alignment nudge (see seniorityAlignmentMultiplier). Omitting
   *   it skips that adjustment entirely — backward-compatible.
   * @returns {number} 0..1 — 1 only when every JD keyword is present AND
   *   at maximum resume depth (times the seniority-match bonus, if any).
   */
  function scoreResumeAgainstJD(resume, jdKeywordsLower, jdText, jobTitle) {
    if (!jdKeywordsLower || !jdKeywordsLower.length) return 0;
    const jdTextLower = normalize(jdText);
    // '' when jdText has no detected Requirements/Qualifications section
    // (or wasn't supplied at all) — jdKeywordWeight() treats that as "no
    // boost".
    const requiredTextLower = jdTextLower ? normalize(extractRequiredSectionText(jdText)) : '';

    const resumeCounts = new Map();
    extractAtsKeywords(resume && resume.profile).forEach(k => {
      resumeCounts.set(normalize(k.term).trim(), k.count);
    });

    let numerator = 0;
    let denominator = 0;
    for (const kw of jdKeywordsLower) {
      const weight = jdTextLower ? jdKeywordWeight(jdTextLower, kw, requiredTextLower) : 1;
      // Denominator uses each keyword's MAXIMUM possible credit, not just
      // its base weight — this is what makes 100% require depth, not just
      // coverage. Mathematically numerator can never exceed denominator
      // (resumeDepthMultiplier is bounded by the same MAX), so the
      // Math.min below is a defensive floor, not something that should
      // ever actually trigger.
      denominator += weight * MAX_RESUME_DEPTH_MULTIPLIER;
      numerator += weight * resumeDepthMultiplier(resumeCounts.get(kw));
    }
    const rawScore = denominator > 0 ? Math.min(1, numerator / denominator) : 0;
    if (!jobTitle) return rawScore;
    return Math.min(1, rawScore * seniorityAlignmentMultiplier(jobTitle, resume));
  }

  /**
   * Ranks all resumes against a job description, best match first. See the
   * file doc comment for the algorithm: JD keywords are extracted first
   * (from the union of all resumes' ATS keywords that appear in the JD),
   * then every resume is scored by its weighted coverage of that keyword
   * set (plus the seniority-alignment nudge, if a job title is supplied).
   * @param {string} jdText
   * @param {Array<{id: string, name: string, profile?: {skills?: string[], certifications?: string[], experience?: Array<{title?: string}>, projects?: Array<{technologies?: string[]}>}}>} resumes
   * @param {string} [jobTitle] JD's job title text — optional, see
   *   scoreResumeAgainstJD's jobTitle param.
   * @returns {Array<{id: string, name: string, score: number}>}
   */
  function rankResumes(jdText, resumes, jobTitle) {
    const jdKeywords = extractJDKeywords(jdText, resumes);
    return (resumes || [])
      .map(r => ({ id: r.id, name: r.name, score: scoreResumeAgainstJD(r, jdKeywords, jdText, jobTitle) }))
      .sort((a, b) => b.score - a.score);
  }

  const api = {
    rankResumes, scoreResumeAgainstJD, extractJDKeywords, buildKeywordVocabulary,
    jdKeywordWeight, resumeDepthMultiplier, MAX_RESUME_DEPTH_MULTIPLIER,
    extractRequiredSectionText, REQUIRED_SECTION_WEIGHT_MULTIPLIER,
    isHighValueCategoryTerm, CATEGORY_WEIGHT_MULTIPLIER,
    detectSeniorityTier, seniorityAlignmentMultiplier,
    SENIORITY_MATCH_BONUS, SENIORITY_MISMATCH_PENALTY,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.JMResumeRanker = api;
  }
})();
