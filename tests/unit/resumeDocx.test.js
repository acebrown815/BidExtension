// A resume with no original file saved (imported from a PDF, added, or
// migrated) left Greenhouse's required "Resume/CV" empty on thenewyorktimes
// while the AI cover letter attached — AutoFill now uploads a .docx built
// from the resume's parsed profile instead.
import { describe, it, expect } from 'vitest';
import { buildResumeDocxParts, descriptionLines } from '../../lib/resumeDocx.mjs';

const profile = {
  name: 'Randolph Smith',
  email: 'r@example.com',
  phone: '+1 555 123 4567',
  location: 'Austin, TX',
  linkedin: 'linkedin.com/in/randolph',
  summary: 'Backend engineer <Python & C#>.',
  skills: ['Python', 'Django', 'C#.NET'],
  experience: [
    { title: 'Senior Engineer', company: 'Acme', dates: '2020 - Present', location: 'Remote',
      description: '• Built CQRS services\n• Led DDD rollout' },
  ],
  education: [{ degree: 'BS Computer Science', school: 'UT Austin', dates: '2012 - 2016', details: '' }],
  certifications: ['AWS SAA'],
  projects: [],
};

const docText = (xml) => [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]).join(' ');

describe('buildResumeDocxParts', () => {
  it('returns well-formed OOXML parts', () => {
    const parts = buildResumeDocxParts(profile);
    expect(Object.keys(parts).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/document.xml'].sort());
    for (const [p, xml] of Object.entries(parts)) {
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      expect(doc.getElementsByTagName('parsererror').length, p).toBe(0);
    }
  });

  it('carries the resume content, escaped', () => {
    const text = docText(buildResumeDocxParts(profile)['word/document.xml']);
    for (const s of ['Randolph Smith', 'r@example.com', 'SUMMARY', 'Python, Django, C#.NET', 'Senior Engineer — Acme',
      '2020 - Present', 'Built CQRS services', 'Led DDD rollout', 'BS Computer Science — UT Austin', 'AWS SAA']) {
      expect(text).toContain(s);
    }
    expect(text).toContain('&lt;Python &amp; C#&gt;');
    expect(text).not.toContain('PROJECTS'); // empty sections left out
  });

  it('splits descriptions into bullet lines', () => {
    expect(descriptionLines('• One\n• Two')).toEqual(['One', 'Two']);
    expect(descriptionLines('- One\n- Two')).toEqual(['One', 'Two']);
    expect(descriptionLines('Just a paragraph.')).toEqual(['Just a paragraph.']);
    expect(descriptionLines('')).toEqual([]);
  });
});
