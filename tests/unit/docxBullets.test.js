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
} from '../../lib/docxBullets.mjs';

const wrapPara = (text) =>
  `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

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
});
