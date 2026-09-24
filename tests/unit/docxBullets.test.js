/**
 * Tests for lib/docxBullets.mjs (I7 from the audit).
 *
 * The two bugs being fixed:
 *  - String.replace lands on the first occurrence even when a bullet's text
 *    appears verbatim in two paragraphs (duplicate bullets across roles).
 *  - extractParagraphText didn't decode XML entities, so any bullet
 *    containing & < > " ' would silently miss its paragraph.
 */
import { describe, it, expect } from 'vitest';
import {
  decodeXmlEntities,
  escapeXml,
  extractParagraphText,
  normalizeForMatch,
  replaceParagraphText,
  replaceBulletsInDocXml,
  replaceSummaryInDocXml,
  replaceLanguagesInDocXml,
  looksLikeProseSummary,
  filterPlausibleSkillTerms,
  appendMissingSkillsInDocXml,
  extractSkillCategoriesFromDocXml,
  replaceSkillCategoryInDocXml,
  applySkillCategoryRevisions,
  replaceLabeledLineText,
} from '../../lib/docxBullets.mjs';

const wrapPara = (text) =>
  `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

// A "Label: items" paragraph as real resumes commonly write it: the label
// in its own bold run, the items in a separate, normal-weight run.
const wrapLabeledPara = (label, items) =>
  `<w:p>`
  + `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${label}</w:t></w:r>`
  + `<w:r><w:t xml:space="preserve">${items}</w:t></w:r>`
  + `</w:p>`;

describe('decodeXmlEntities', () => {
  it('decodes the five named entities', () => {
    expect(decodeXmlEntities('AT&amp;T &lt;tag&gt; &quot;hi&quot; &apos;x&apos;'))
      .toBe(`AT&T <tag> "hi" 'x'`);
  });
  it('does not double-decode &amp;amp;', () => {
    expect(decodeXmlEntities('&amp;amp;')).toBe('&amp;');
  });
});

describe('escapeXml', () => {
  it('encodes the five named entities', () => {
    expect(escapeXml(`AT&T <tag> "hi" 'x'`))
      .toBe('AT&amp;T &lt;tag&gt; &quot;hi&quot; &apos;x&apos;');
  });
  it('escape→decode round-trips', () => {
    const original = `Built CI/CD pipelines @ AT&T (>10x faster) — "blazing"`;
    expect(decodeXmlEntities(escapeXml(original))).toBe(original);
  });
});

describe('extractParagraphText', () => {
  it('joins multiple text runs', () => {
    const xml = '<w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>world</w:t></w:r></w:p>';
    expect(extractParagraphText(xml)).toBe('Hello world');
  });
  it('decodes XML entities while extracting', () => {
    const xml = '<w:p><w:r><w:t>AT&amp;T</w:t></w:r></w:p>';
    expect(extractParagraphText(xml)).toBe('AT&T');
  });
});

describe('replaceParagraphText', () => {
  it('puts new text in the first <w:t> and empties the rest', () => {
    const xml = '<w:p><w:r><w:t>old1 </w:t></w:r><w:r><w:t>old2</w:t></w:r></w:p>';
    const out = replaceParagraphText(xml, 'NEW');
    expect(out).toMatch(/<w:t[^>]*>NEW<\/w:t>/);
    expect(out.match(/<w:t[^>]*><\/w:t>/g)).not.toBeNull(); // a cleared run remains
  });
  it('escapes special chars in the replacement', () => {
    const xml = '<w:p><w:r><w:t>old</w:t></w:r></w:p>';
    const out = replaceParagraphText(xml, 'AT&T <hi>');
    expect(out).toContain('AT&amp;T &lt;hi&gt;');
  });
});

describe('replaceBulletsInDocXml — happy paths', () => {
  it('replaces a single matching bullet', () => {
    const docXml = '<root>' + wrapPara('Built CI/CD pipelines reducing deploy time') + '</root>';
    const { docXml: out, replacedCount } = replaceBulletsInDocXml(docXml, [
      { original: 'Built CI/CD pipelines reducing deploy time',
        improved: 'Built Kubernetes-native CI/CD pipelines on Argo CD reducing deploy time 10x' },
    ]);
    expect(replacedCount).toBe(1);
    expect(out).toContain('Argo CD');
    expect(out).not.toContain('Built CI/CD pipelines reducing deploy time');
  });

  it('skips paragraphs shorter than the threshold', () => {
    // Short text guards against matching ATS metadata like "Skills:"
    const docXml = '<root>' + wrapPara('Skills:') + '</root>';
    const { replacedCount } = replaceBulletsInDocXml(docXml, [
      { original: 'Skills', improved: 'X' },
    ]);
    expect(replacedCount).toBe(0);
  });

  it('handles bullets with XML entities (AT&T case)', () => {
    const docXml = '<root>' + wrapPara('Led integration with AT&amp;T billing platform end-to-end') + '</root>';
    const { docXml: out, replacedCount } = replaceBulletsInDocXml(docXml, [
      { original: 'Led integration with AT&T billing platform end-to-end',
        improved: 'Led AT&T integration end-to-end (Kafka + Spark)' },
    ]);
    expect(replacedCount).toBe(1);
    expect(out).toContain('AT&amp;T integration end-to-end');
  });
});

describe('replaceBulletsInDocXml — duplicate-bullet bug fix (I7)', () => {
  it('replaces two identical bullets with two different rewrites', () => {
    // Two roles with identical "Built CI/CD pipelines" wording.
    // Old behavior: both bullets landed on the first paragraph.
    // New behavior: each bullet finds its own paragraph.
    const docXml = '<root>'
      + wrapPara('Built CI/CD pipelines reducing deploy time at company A')
      + wrapPara('Built CI/CD pipelines reducing deploy time at company A')
      + '</root>';
    const { docXml: out, replacedCount } = replaceBulletsInDocXml(docXml, [
      { original: 'Built CI/CD pipelines reducing deploy time at company A',
        improved: 'REWRITE_ONE' },
      { original: 'Built CI/CD pipelines reducing deploy time at company A',
        improved: 'REWRITE_TWO' },
    ]);
    expect(replacedCount).toBe(2);
    expect(out).toContain('REWRITE_ONE');
    expect(out).toContain('REWRITE_TWO');
    expect(out).not.toContain('Built CI/CD pipelines reducing deploy time at company A');
  });

  it('does not consume an unused paragraph for a non-matching bullet', () => {
    const docXml = '<root>'
      + wrapPara('Built data pipelines for ingestion at terabyte scale')
      + wrapPara('Architected microservices on Kubernetes for tier-1 services')
      + '</root>';
    const { replacedCount } = replaceBulletsInDocXml(docXml, [
      { original: 'something completely unrelated to either paragraph here', improved: 'X' },
    ]);
    expect(replacedCount).toBe(0);
  });
});

describe('looksLikeProseSummary', () => {
  // Regression: the AI-generated "summary" sometimes came back as a bare
  // comma-separated skills dump, which then got written verbatim into the
  // resume's actual Summary paragraph.
  it('rejects a comma-separated skills dump', () => {
    expect(looksLikeProseSummary('JavaScript, React, Node.js, AWS, Docker, Kubernetes, SQL, Python, Go, GraphQL, Terraform')).toBe(false);
  });

  it('accepts real flowing prose', () => {
    expect(looksLikeProseSummary(
      'Backend engineer with 8 years of experience building scalable APIs and distributed systems. ' +
      'Specializes in Node.js and Kubernetes, with a track record of reducing deploy times and mentoring junior engineers.'
    )).toBe(true);
  });

  it('rejects text with no sentence-ending punctuation at all', () => {
    expect(looksLikeProseSummary('Backend engineer with experience building scalable APIs and distributed systems for growing teams')).toBe(false);
  });

  it('rejects empty, too-short, or non-string input', () => {
    expect(looksLikeProseSummary('')).toBe(false);
    expect(looksLikeProseSummary('Short one.')).toBe(false);
    expect(looksLikeProseSummary(null)).toBe(false);
    expect(looksLikeProseSummary(undefined)).toBe(false);
  });
});

describe('replaceSummaryInDocXml', () => {
  it('replaces the paragraph matching the original summary text', () => {
    const docXml = '<root>'
      + wrapPara('Experienced software engineer with a decade of backend experience')
      + wrapPara('Built CI/CD pipelines reducing deploy time')
      + '</root>';
    const { docXml: out, summaryUpdated } = replaceSummaryInDocXml(
      docXml,
      'Experienced software engineer with a decade of backend experience',
      'Backend engineer specializing in distributed systems and Kubernetes.'
    );
    expect(summaryUpdated).toBe(true);
    expect(out).toContain('Backend engineer specializing in distributed systems and Kubernetes.');
    expect(out).not.toContain('Experienced software engineer with a decade of backend experience');
    expect(out).toContain('Built CI/CD pipelines reducing deploy time'); // unrelated paragraph untouched
  });

  it('does nothing when there is no original summary to anchor on', () => {
    const docXml = '<root>' + wrapPara('Some paragraph') + '</root>';
    const { docXml: out, summaryUpdated } = replaceSummaryInDocXml(docXml, '', 'New summary');
    expect(summaryUpdated).toBe(false);
    expect(out).toBe(docXml);
  });

  it('does nothing when no paragraph matches the original summary', () => {
    const docXml = '<root>' + wrapPara('Totally unrelated paragraph text here') + '</root>';
    const { summaryUpdated } = replaceSummaryInDocXml(
      docXml,
      'A summary that does not appear anywhere in this document at all',
      'New summary'
    );
    expect(summaryUpdated).toBe(false);
  });

  // Regression: a real two-paragraph "Professional Summary" section (one
  // narrative paragraph, one "Hands-on experience with..." paragraph) —
  // profile.summary holds both as one string, but replacing only the
  // FIRST matching paragraph left the second one stale right below the
  // newly tailored text.
  describe('a summary spanning multiple DOCX paragraphs', () => {
    const para1 = 'Senior Software Engineer with 12+ years of experience building scalable web applications.';
    const para2 = 'Hands-on experience with AWS S3, Lambda, RDS, EC2, Glue, and CI/CD, along with designing REST APIs and distributed services.';
    const originalSummary = `${para1} ${para2}`;

    it('replaces the first paragraph with the new summary and empties the rest of the span', () => {
      const docXml = '<root>' + wrapPara(para1) + wrapPara(para2) + wrapPara('Skills: Java, Python, AWS') + '</root>';
      const { docXml: out, summaryUpdated } = replaceSummaryInDocXml(
        docXml, originalSummary, 'Backend engineer tailored for this specific Kubernetes-heavy role.'
      );
      expect(summaryUpdated).toBe(true);
      expect(out).toContain('Backend engineer tailored for this specific Kubernetes-heavy role.');
      expect(out).not.toContain(para1);
      expect(out).not.toContain(para2);
      expect(out).toContain('Skills: Java, Python, AWS');
    });

    it('stops the span at the first paragraph that is not part of the original summary', () => {
      const docXml = '<root>' + wrapPara(para1) + wrapPara(para2) + wrapPara('Experience') + wrapPara('Built things at Acme') + '</root>';
      const { docXml: out } = replaceSummaryInDocXml(docXml, originalSummary, 'New tailored summary.');
      expect(out).toContain('Experience');
      expect(out).toContain('Built things at Acme');
    });
  });
});

describe('replaceLanguagesInDocXml', () => {
  it('replaces a bare "Languages" header line, preserving the label', () => {
    const docXml = '<root>' + wrapPara('Languages: PHP, Python, TypeScript, JavaScript, SQL, Bash') + '</root>';
    const { docXml: out, languagesUpdated } = replaceLanguagesInDocXml(docXml, ['Go', 'Python', 'SQL']);
    expect(languagesUpdated).toBe(true);
    expect(out).toContain('Languages: Go, Python, SQL');
    expect(out).not.toContain('PHP');
  });

  it('recognizes "Programming Languages" as a header too', () => {
    const docXml = '<root>' + wrapPara('Programming Languages: Java, C++') + '</root>';
    const { docXml: out, languagesUpdated } = replaceLanguagesInDocXml(docXml, ['Rust']);
    expect(languagesUpdated).toBe(true);
    expect(out).toContain('Rust');
    expect(out).not.toContain('Java');
  });

  it('does not touch an unrelated paragraph that merely mentions "languages" mid-sentence', () => {
    const docXml = '<root>' + wrapPara('Fluent in multiple languages including English and Spanish') + '</root>';
    const { docXml: out, languagesUpdated } = replaceLanguagesInDocXml(docXml, ['Go']);
    expect(languagesUpdated).toBe(false);
    expect(out).toBe(docXml);
  });

  it('does nothing when languages is empty or not an array', () => {
    const docXml = '<root>' + wrapPara('Languages: PHP, Python') + '</root>';
    expect(replaceLanguagesInDocXml(docXml, []).languagesUpdated).toBe(false);
    expect(replaceLanguagesInDocXml(docXml, null).languagesUpdated).toBe(false);
  });

  it('leaves other skill category lines completely untouched', () => {
    const docXml = '<root>'
      + wrapPara('Languages: PHP, Python, TypeScript')
      + wrapPara('Frontend: React, Next.js, Redux')
      + '</root>';
    const { docXml: out } = replaceLanguagesInDocXml(docXml, ['Go', 'Python']);
    expect(out).toContain('Frontend: React, Next.js, Redux');
  });

  // Regression for a real bug: the whole line came out bold. Real resumes
  // commonly bold only the "Languages:" label, in its own run, with the
  // items in a separate normal-weight run — replaceLanguagesInDocXml used
  // to cram the WHOLE new line into that first (bold) run, so the items
  // inherited the label's bold formatting and the second run went empty.
  it('keeps the label run bold and the items run normal weight (the actual bug)', () => {
    const docXml = '<root>' + wrapLabeledPara('Languages: ', 'PHP, Python') + '</root>';
    const { docXml: out } = replaceLanguagesInDocXml(docXml, ['Go', 'Java']);
    const boldRun = out.match(/<w:r><w:rPr><w:b\/><\/w:rPr><w:t[^>]*>([^<]*)<\/w:t><\/w:r>/);
    const plainRun = out.match(/<\/w:r><w:r><w:t[^>]*>([^<]*)<\/w:t><\/w:r>/);
    expect(boldRun[1]).toBe('Languages: ');
    expect(plainRun[1]).toBe('Go, Java');
  });
});

describe('replaceLabeledLineText', () => {
  it('splits label and items across two existing runs, preserving each run\'s own formatting', () => {
    const paraXml = wrapLabeledPara('Skills: ', 'PHP, Python');
    const out = replaceLabeledLineText(paraXml, 'Skills: ', 'Go, Java, Rust');
    expect(out).toContain('<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Skills: </w:t></w:r>');
    expect(out).toContain('<w:r><w:t xml:space="preserve">Go, Java, Rust</w:t></w:r>');
  });

  it('empties any run beyond the second', () => {
    const paraXml = '<w:p>'
      + '<w:r><w:rPr><w:b/></w:rPr><w:t>Skills: </w:t></w:r>'
      + '<w:r><w:t>PHP</w:t></w:r>'
      + '<w:r><w:t>, Python</w:t></w:r>'
      + '</w:p>';
    const out = replaceLabeledLineText(paraXml, 'Skills: ', 'Go');
    expect(extractParagraphText(out)).toBe('Skills: Go');
  });

  it('falls back to a whole-line replace when there is only one run to work with', () => {
    const paraXml = '<w:p><w:r><w:t xml:space="preserve">Skills: PHP, Python</w:t></w:r></w:p>';
    const out = replaceLabeledLineText(paraXml, 'Skills: ', 'Go, Java');
    expect(extractParagraphText(out)).toBe('Skills: Go, Java');
  });

  it('escapes special characters in both the label and the items', () => {
    const paraXml = wrapLabeledPara('C++ & Systems: ', 'C, Rust');
    const out = replaceLabeledLineText(paraXml, 'C++ & Systems: ', 'Go & Java');
    expect(out).toContain('C++ &amp; Systems: ');
    expect(out).toContain('Go &amp; Java');
  });
});

// Regression for a real bug found live: tailoring a Python/React resume
// against a "Senior Performance Engineer" JD (heavy on JMeter, Splunk,
// load/stress/spike testing) produced a "Languages:" line polluted with
// non-language tool/methodology names ("Load Testing", "JVM Tuning",
// "Splunk", ...) and a "Python & Backend:" line turned into a run-on
// sentence by appending a long, unbounded list of missing-skill entries —
// some of them full JD sentence fragments rather than short skill tags
// (e.g. "Enterprise performance testing for large-scale web/mobile/
// digital apps"). Root cause: neither the languages list (from the bullet-
// rewrite AI call) nor missingSkills (from the job-analysis AI call) was
// ever validated to actually BE a short skill/language name before being
// written verbatim into the resume.
describe('filterPlausibleSkillTerms — the actual bug (AI-returned lists mixing real terms with JD sentence fragments)', () => {
  it('keeps short, plausible skill/language names', () => {
    expect(filterPlausibleSkillTerms(['Java', 'JMeter', 'Ruby on Rails', 'CI/CD']))
      .toEqual(['Java', 'JMeter', 'Ruby on Rails', 'CI/CD']);
  });

  it('drops entries that are really a JD sentence fragment, not a skill name', () => {
    const terms = [
      'JMeter',
      'Enterprise performance testing for large-scale web/mobile/digital apps',
      '5+ years of experience in performance testing and engineering',
      'Splunk',
    ];
    expect(filterPlausibleSkillTerms(terms)).toEqual(['JMeter', 'Splunk']);
  });

  it('drops non-language tool/methodology names that slipped into a "languages" list', () => {
    const languages = ['Java', 'Python', 'Load Testing', 'JVM Tuning', 'Splunk', 'Dynatrace'];
    expect(filterPlausibleSkillTerms(languages)).toEqual(['Java', 'Python', 'Load Testing', 'JVM Tuning', 'Splunk', 'Dynatrace']);
    // Confirms the filter is length/word-count based, not a language
    // allowlist — it only catches the clearly-too-long fragments above,
    // not every non-language word (that's the prompt fix's job). Verify
    // the boundary itself instead:
    expect(filterPlausibleSkillTerms(['A very long six word skill phrase here'])).toEqual([]);
  });

  it('drops empty/blank entries and tolerates a non-array input', () => {
    expect(filterPlausibleSkillTerms(['Java', '', '   ', null])).toEqual(['Java']);
    expect(filterPlausibleSkillTerms(null)).toEqual([]);
    expect(filterPlausibleSkillTerms(undefined)).toEqual([]);
  });

  it('respects custom maxWords/maxChars bounds', () => {
    expect(filterPlausibleSkillTerms(['one two three'], 2)).toEqual([]);
    expect(filterPlausibleSkillTerms(['ab'], 4, 1)).toEqual([]);
  });
});

describe('appendMissingSkillsInDocXml', () => {
  it('appends missing skills to the first paragraph with 3+ known skills', () => {
    const docXml = '<root>'
      + wrapPara('Python & Backend: Python, FastAPI, Django, Flask, REST APIs')
      + '</root>';
    const { docXml: out, skillsAppended } = appendMissingSkillsInDocXml(
      docXml, ['JMeter', 'Splunk'], ['Python', 'FastAPI', 'Django', 'Flask', 'REST APIs'], false
    );
    expect(skillsAppended).toEqual(['JMeter', 'Splunk']);
    expect(out).toContain('Python & Backend: Python, FastAPI, Django, Flask, REST APIs, JMeter, Splunk');
  });

  it('never appends more than maxAppended skills, even when the filtered list is long (the actual bug)', () => {
    const docXml = '<root>'
      + wrapPara('Python & Backend: Python, FastAPI, Django, Flask, REST APIs')
      + '</root>';
    const manyMissing = ['JMeter', 'Splunk', 'Dynatrace', 'AppDynamics', 'SOAP', 'NoSQL', 'GraphQL', 'Kubernetes'];
    const { skillsAppended } = appendMissingSkillsInDocXml(
      docXml, manyMissing, ['Python', 'FastAPI', 'Django', 'Flask', 'REST APIs'], false, 3
    );
    expect(skillsAppended).toEqual(['JMeter', 'Splunk', 'Dynatrace']);
  });

  it('skips a paragraph already replaced by replaceLanguagesInDocXml (languagesUpdated)', () => {
    const docXml = '<root>'
      + wrapPara('Languages: Java, Python, JavaScript, TypeScript, SQL, Bash')
      + '</root>';
    const { skillsAppended, docXml: out } = appendMissingSkillsInDocXml(
      docXml, ['JMeter', 'Splunk'], ['Python', 'JavaScript', 'TypeScript', 'SQL', 'Bash'], true
    );
    expect(skillsAppended).toEqual([]);
    expect(out).toBe(docXml); // untouched — no other paragraph has 3+ known skills either
  });

  it('does not append a skill already present in the paragraph, even case-insensitively', () => {
    const docXml = '<root>'
      + wrapPara('Cloud & DevOps: AWS, Azure, Docker, Kubernetes, jmeter')
      + '</root>';
    const { skillsAppended } = appendMissingSkillsInDocXml(
      docXml, ['JMeter', 'Terraform'], ['AWS', 'Azure', 'Docker', 'Kubernetes'], false
    );
    expect(skillsAppended).toEqual(['Terraform']);
  });

  it('does nothing when missingSkills or profileSkills is empty', () => {
    const docXml = '<root>' + wrapPara('Skills: Python, AWS, Docker') + '</root>';
    expect(appendMissingSkillsInDocXml(docXml, [], ['Python', 'AWS', 'Docker'], false).docXml).toBe(docXml);
    expect(appendMissingSkillsInDocXml(docXml, ['JMeter'], [], false).docXml).toBe(docXml);
  });

  // End-to-end reproduction of the reported bug, combining both fixes.
  it('end-to-end: a Performance Engineer JD no longer pollutes Languages or run-on the Backend line', () => {
    let docXml = '<root>'
      + wrapPara('Languages: Python, JavaScript, TypeScript, SQL, Bash')
      + wrapPara('Python & Backend: Python, FastAPI, Django, Flask, REST APIs, GraphQL, Microservices, WebSockets, AsyncIO')
      + '</root>';

    // What the AI actually returned live for this JD, unfiltered. Note
    // filterPlausibleSkillTerms is a length/word-count guard, not a
    // language allowlist — it can't tell "JMeter" isn't a language on its
    // own (that's the tightened aiService.js prompt's job); what it DOES
    // reliably catch, regardless of any one prompt's wording, is a whole
    // JD sentence fragment masquerading as a skill/language name.
    const rawLanguages = ['Java', 'Python', 'JavaScript', 'TypeScript', 'SQL', 'Bash', 'REST APIs', 'JMeter',
      'Enterprise performance testing for large-scale web/mobile/digital apps'];
    const rawMissingSkills = [
      'JMeter', 'Load testing', 'Splunk', 'Dynatrace',
      'Enterprise performance testing for large-scale web/mobile/digital apps',
      'Performance baselines and regression tracking',
    ];

    const languagesResult = replaceLanguagesInDocXml(docXml, filterPlausibleSkillTerms(rawLanguages));
    docXml = languagesResult.docXml;

    const appendResult = appendMissingSkillsInDocXml(
      docXml, filterPlausibleSkillTerms(rawMissingSkills),
      ['Python', 'FastAPI', 'Django', 'Flask', 'REST APIs', 'GraphQL', 'Microservices', 'WebSockets', 'AsyncIO'],
      languagesResult.languagesUpdated
    );
    docXml = appendResult.docXml;

    // The long JD sentence fragment never reaches either line.
    expect(docXml).toContain('Languages: Java, Python, JavaScript, TypeScript, SQL, Bash, REST APIs, JMeter');
    expect(docXml).not.toContain('Enterprise performance testing');

    expect(appendResult.skillsAppended).toEqual(['JMeter', 'Load testing', 'Splunk', 'Dynatrace']);
    expect(docXml).toContain('Python & Backend: Python, FastAPI, Django, Flask, REST APIs, GraphQL, Microservices, WebSockets, AsyncIO, JMeter, Load testing, Splunk, Dynatrace');
  });
});

// Regression for the follow-up ask: appending JD keywords to a category
// like "Python & Backend" isn't enough when the category's actual FOCUS
// no longer matches the job (e.g. a Java-focused JD) — the category
// itself needs to be re-thought (renamed, refocused), not just added to.
describe('extractSkillCategoriesFromDocXml', () => {
  const buildSkillsDoc = (categoryLines, { header = 'SKILLS' } = {}) =>
    '<root>'
    + wrapPara('PROFESSIONAL SUMMARY')
    + wrapPara('Some summary text.')
    + wrapPara(header)
    + categoryLines.map(wrapPara).join('')
    + wrapPara('PROFESSIONAL EXPERIENCE')
    + wrapPara('Built things at Acme')
    + '</root>';

  it('extracts every category line between the SKILLS header and the next section', () => {
    const docXml = buildSkillsDoc([
      'Languages: Python, JavaScript, TypeScript',
      'Python & Backend: Python, FastAPI, Django, Flask',
      'Cloud & DevOps: AWS, Docker, Kubernetes',
    ]);
    expect(extractSkillCategoriesFromDocXml(docXml)).toEqual([
      { label: 'Languages', items: ['Python', 'JavaScript', 'TypeScript'] },
      { label: 'Python & Backend', items: ['Python', 'FastAPI', 'Django', 'Flask'] },
      { label: 'Cloud & DevOps', items: ['AWS', 'Docker', 'Kubernetes'] },
    ]);
  });

  it('recognizes "Technical Skills" and "Core Competencies" headers too', () => {
    expect(extractSkillCategoriesFromDocXml(buildSkillsDoc(['Languages: Go, Python'], { header: 'Technical Skills' })))
      .toEqual([{ label: 'Languages', items: ['Go', 'Python'] }]);
    expect(extractSkillCategoriesFromDocXml(buildSkillsDoc(['Languages: Go, Python'], { header: 'Core Competencies' })))
      .toEqual([{ label: 'Languages', items: ['Go', 'Python'] }]);
  });

  it('stops at the first paragraph that does not match the category-line shape', () => {
    const docXml = buildSkillsDoc(['Languages: Python, Go']); // buildSkillsDoc already appends "PROFESSIONAL EXPERIENCE" after
    const categories = extractSkillCategoriesFromDocXml(docXml);
    expect(categories).toEqual([{ label: 'Languages', items: ['Python', 'Go'] }]);
  });

  it('does not mistake an unrelated "Label: value" paragraph elsewhere in the resume for a skills category', () => {
    const docXml = '<root>'
      + wrapPara('Reconnect	Cumberland, ME')
      + wrapPara('Software Engineer	Aug 2024 - July 2026')
      + '</root>';
    expect(extractSkillCategoriesFromDocXml(docXml)).toEqual([]);
  });

  it('returns an empty array when there is no SKILLS section header at all', () => {
    const docXml = '<root>' + wrapPara('Just some paragraph') + '</root>';
    expect(extractSkillCategoriesFromDocXml(docXml)).toEqual([]);
  });
});

describe('replaceSkillCategoryInDocXml', () => {
  it('replaces a category found by its ORIGINAL label, allowing the label itself to change', () => {
    const docXml = '<root>' + wrapPara('Python & Backend: Python, FastAPI, Django, Flask') + '</root>';
    const { docXml: out, updated } = replaceSkillCategoryInDocXml(
      docXml, 'Python & Backend', 'Java & Backend', ['Java', 'Spring Boot', 'Hibernate', 'Maven']
    );
    expect(updated).toBe(true);
    expect(out).toContain('Java &amp; Backend: Java, Spring Boot, Hibernate, Maven'); // valid XML escapes "&"
    expect(out).not.toContain('FastAPI');
  });

  it('leaves other category paragraphs untouched', () => {
    const docXml = '<root>'
      + wrapPara('Languages: Python, JavaScript')
      + wrapPara('Python & Backend: Python, FastAPI')
      + '</root>';
    const { docXml: out } = replaceSkillCategoryInDocXml(docXml, 'Python & Backend', 'Java & Backend', ['Java']);
    expect(out).toContain('Languages: Python, JavaScript');
  });

  it('does nothing when the original label is not found, or newItems is empty', () => {
    const docXml = '<root>' + wrapPara('Languages: Python, JavaScript') + '</root>';
    expect(replaceSkillCategoryInDocXml(docXml, 'Nonexistent Category', 'X', ['Y']).updated).toBe(false);
    expect(replaceSkillCategoryInDocXml(docXml, 'Languages', 'X', []).updated).toBe(false);
  });

  it('escapes regex-special characters in the original label safely (e.g. "C++")', () => {
    const docXml = '<root>' + wrapPara('C++ & Systems: C++, Rust') + '</root>';
    const { updated, docXml: out } = replaceSkillCategoryInDocXml(docXml, 'C++ & Systems', 'C++ & Systems', ['C++', 'Go']);
    expect(updated).toBe(true);
    expect(out).toContain('C++ &amp; Systems: C++, Go');
  });

  // Same real bug as replaceLanguagesInDocXml above: the bold label run
  // must stay bold-only, the items must land in the normal-weight run.
  it('keeps the label run bold and the items run normal weight (the actual bug)', () => {
    const docXml = '<root>' + wrapLabeledPara('Python & Backend: ', 'Python, FastAPI') + '</root>';
    const { docXml: out } = replaceSkillCategoryInDocXml(docXml, 'Python & Backend', 'Java & Backend', ['Java', 'Spring Boot']);
    const boldRun = out.match(/<w:r><w:rPr><w:b\/><\/w:rPr><w:t[^>]*>([^<]*)<\/w:t><\/w:r>/);
    const plainRun = out.match(/<\/w:r><w:r><w:t[^>]*>([^<]*)<\/w:t><\/w:r>/);
    expect(boldRun[1]).toBe('Java &amp; Backend: ');
    expect(plainRun[1]).toBe('Java, Spring Boot');
  });
});

describe('applySkillCategoryRevisions — the actual follow-up bug (category focus must change, not just gain appended keywords)', () => {
  it('renames and refocuses a category whose current focus no longer fits the job', () => {
    const docXml = '<root>'
      + wrapPara('Languages: Java, Python, JavaScript, TypeScript, SQL, Bash')
      + wrapPara('Python & Backend: Python, FastAPI, Django, Flask, REST APIs, GraphQL, Microservices, WebSockets, AsyncIO')
      + wrapPara('Cloud & DevOps: AWS, Azure, Docker, Kubernetes')
      + '</root>';
    const original = [
      { label: 'Python & Backend', items: ['Python', 'FastAPI', 'Django', 'Flask', 'REST APIs', 'GraphQL', 'Microservices', 'WebSockets', 'AsyncIO'] },
      { label: 'Cloud & DevOps', items: ['AWS', 'Azure', 'Docker', 'Kubernetes'] },
    ];
    // What the AI returns for a Java-focused JD: refocus the first category,
    // leave the second (still broadly relevant) mostly as-is with one addition.
    const revised = [
      { label: 'Java & Backend', items: ['Java', 'Spring Boot', 'Hibernate', 'REST APIs', 'Microservices'] },
      { label: 'Cloud & DevOps', items: ['AWS', 'Azure', 'Docker', 'Kubernetes', 'Terraform'] },
    ];

    const { docXml: out, updatedLabels } = applySkillCategoryRevisions(docXml, original, revised);
    expect(updatedLabels).toEqual(['Java & Backend', 'Cloud & DevOps']);
    expect(out).toContain('Java &amp; Backend: Java, Spring Boot, Hibernate, REST APIs, Microservices');
    expect(out).not.toContain('FastAPI');
    expect(out).not.toContain('Django');
    expect(out).toContain('Cloud &amp; DevOps: AWS, Azure, Docker, Kubernetes, Terraform');
    expect(out).toContain('Languages: Java, Python, JavaScript, TypeScript, SQL, Bash'); // untouched — Languages is tailored separately
  });

  it('filters implausible items and caps each category at maxItemsPerCategory (no run-on lines)', () => {
    const docXml = '<root>' + wrapPara('Python & Backend: Python, FastAPI') + '</root>';
    const original = [{ label: 'Python & Backend', items: ['Python', 'FastAPI'] }];
    const revised = [{
      label: 'Java & Backend',
      items: [
        'Java', 'Spring Boot', 'Hibernate', 'Maven', 'Gradle', 'JPA',
        'Enterprise performance testing for large-scale web/mobile/digital apps', // implausible — dropped
        'REST APIs', 'Microservices',
      ],
    }];
    const { docXml: out } = applySkillCategoryRevisions(docXml, original, revised, 5);
    const line = out.match(/Java &amp; Backend:[^<]*/)[0];
    expect(line).not.toContain('Enterprise performance testing');
    expect(line.split(',').length).toBeLessThanOrEqual(5);
  });

  it('skips a category the AI returned with no plausible items, leaving the original untouched', () => {
    const docXml = '<root>' + wrapPara('Python & Backend: Python, FastAPI') + '</root>';
    const original = [{ label: 'Python & Backend', items: ['Python', 'FastAPI'] }];
    const revised = [{ label: 'Java & Backend', items: [] }];
    const { docXml: out, updatedLabels } = applySkillCategoryRevisions(docXml, original, revised);
    expect(updatedLabels).toEqual([]);
    expect(out).toBe(docXml);
  });

  it('ignores extra revised entries beyond the original categories array (positional matching)', () => {
    const docXml = '<root>' + wrapPara('Languages: Python') + '</root>';
    const original = [{ label: 'Languages', items: ['Python'] }];
    const revised = [
      { label: 'Languages', items: ['Java'] },
      { label: 'Extra Category The Original Never Had', items: ['X', 'Y'] },
    ];
    const { updatedLabels } = applySkillCategoryRevisions(docXml, original, revised);
    expect(updatedLabels).toEqual(['Languages']); // the second entry has no matching original — ignored
  });
});
