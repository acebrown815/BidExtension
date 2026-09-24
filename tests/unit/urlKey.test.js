/**
 * Tests for normalizeUrlForCache (I2 from the audit).
 * The function must collapse "same job, different source" URLs to one key
 * without merging genuinely different jobs.
 */
import { describe, it, expect, beforeAll } from 'vitest';

let normalizeUrlForCache;
beforeAll(async () => {
  await import('../../lib/urlKey.js');
  normalizeUrlForCache = globalThis.JMUrlKey.normalizeUrlForCache;
});

describe('normalizeUrlForCache — collapses noise', () => {
  it('drops UTM and tracking params', () => {
    const a = 'https://acme.com/jobs/123?utm_source=linkedin&utm_medium=email&utm_campaign=spring';
    const b = 'https://acme.com/jobs/123?fbclid=abc&gclid=xyz';
    const c = 'https://acme.com/jobs/123';
    expect(normalizeUrlForCache(a)).toBe(normalizeUrlForCache(c));
    expect(normalizeUrlForCache(b)).toBe(normalizeUrlForCache(c));
  });

  it('drops fragments', () => {
    expect(normalizeUrlForCache('https://acme.com/jobs/123#applied'))
      .toBe(normalizeUrlForCache('https://acme.com/jobs/123'));
  });

  it('lowercases host', () => {
    expect(normalizeUrlForCache('https://ACME.com/jobs/123'))
      .toBe(normalizeUrlForCache('https://acme.com/jobs/123'));
  });

  it('strips trailing slash from non-root paths', () => {
    expect(normalizeUrlForCache('https://acme.com/jobs/123/'))
      .toBe(normalizeUrlForCache('https://acme.com/jobs/123'));
  });

  it('keeps trailing slash on root path', () => {
    expect(normalizeUrlForCache('https://acme.com/'))
      .toBe('https://acme.com/');
  });
});

describe('normalizeUrlForCache — collapses noise (additional tracking/referral params)', () => {
  it('drops ref/referrer/referer/source/src/from and a bare "utm"', () => {
    const base = normalizeUrlForCache('https://acme.com/jobs/123');
    expect(normalizeUrlForCache('https://acme.com/jobs/123?ref=homepage')).toBe(base);
    expect(normalizeUrlForCache('https://acme.com/jobs/123?referrer=google')).toBe(base);
    expect(normalizeUrlForCache('https://acme.com/jobs/123?referer=google')).toBe(base);
    expect(normalizeUrlForCache('https://acme.com/jobs/123?source=newsletter')).toBe(base);
    expect(normalizeUrlForCache('https://acme.com/jobs/123?src=email')).toBe(base);
    expect(normalizeUrlForCache('https://acme.com/jobs/123?from=serp')).toBe(base);
    expect(normalizeUrlForCache('https://acme.com/jobs/123?utm=x')).toBe(base);
  });

  it('drops jr_id — confirmed a per-visit referral id on catsone.com, not a job identifier', () => {
    const withParam = normalizeUrlForCache('https://timberlinegrp.catsone.com/careers/7276/jobs/15742823-CNET-Developer?jr_id=6a4c4722971cd25b06f9a307');
    const withoutParam = normalizeUrlForCache('https://timberlinegrp.catsone.com/careers/7276/jobs/15742823-CNET-Developer');
    expect(withParam).toBe(withoutParam);
  });
});

describe('normalizeUrlForCache — preserves job identifiers', () => {
  it('keeps Greenhouse gh_jid', () => {
    const k1 = normalizeUrlForCache('https://acme.greenhouse.io/?gh_jid=4567&utm_source=li');
    const k2 = normalizeUrlForCache('https://acme.greenhouse.io/?gh_jid=4567');
    expect(k1).toBe(k2);
    expect(k1).toContain('gh_jid=4567');
  });

  it('keeps Indeed vjk', () => {
    const k = normalizeUrlForCache('https://www.indeed.com/viewjob?vjk=abc123&from=serp');
    expect(k).toContain('vjk=abc123');
    expect(k).not.toContain('from=');
  });

  it('keeps LinkedIn currentJobId', () => {
    const k = normalizeUrlForCache('https://www.linkedin.com/jobs/search/?currentJobId=999&utm=x');
    expect(k).toContain('currentJobId=999');
    expect(k).not.toContain('utm=');
  });

  it('two different gh_jid values produce different keys', () => {
    const a = normalizeUrlForCache('https://acme.greenhouse.io/?gh_jid=1');
    const b = normalizeUrlForCache('https://acme.greenhouse.io/?gh_jid=2');
    expect(a).not.toBe(b);
  });

  it('sorts surviving params for stability', () => {
    const a = normalizeUrlForCache('https://x.com/?vjk=1&jobid=2');
    const b = normalizeUrlForCache('https://x.com/?jobid=2&vjk=1');
    expect(a).toBe(b);
  });

  it('collapses Ashby overview and application-form pages to one key', () => {
    const overview = normalizeUrlForCache('https://jobs.ashbyhq.com/timely/98a7a1f6-13e7-499c-be53-728d0e86e510');
    const application = normalizeUrlForCache('https://jobs.ashbyhq.com/timely/98a7a1f6-13e7-499c-be53-728d0e86e510/application');
    expect(application).toBe(overview);
  });

  it('collapses a CATS (catsone.com) job page and its separate /apply page to one key', () => {
    const overview = normalizeUrlForCache('https://timberlinegrp.catsone.com/careers/7276/jobs/15742823-CNET-Developer?jr_id=6a4c4722971cd25b06f9a307');
    const apply = normalizeUrlForCache('https://timberlinegrp.catsone.com/careers/7276/jobs/15742823-CNET-Developer/apply');
    expect(apply).toBe(overview);
  });

  it('strips /application and /apply suffixes regardless of hostname (not Ashby/CATS-specific)', () => {
    const withSuffix = normalizeUrlForCache('https://acme.com/jobs/123/application');
    const withoutSuffix = normalizeUrlForCache('https://acme.com/jobs/123');
    expect(withSuffix).toBe(withoutSuffix);

    const withApply = normalizeUrlForCache('https://acme.com/jobs/123/apply');
    expect(withApply).toBe(withoutSuffix);
  });

  it('keeps two different Ashby job ids distinct', () => {
    const a = normalizeUrlForCache('https://jobs.ashbyhq.com/timely/aaa/application');
    const b = normalizeUrlForCache('https://jobs.ashbyhq.com/timely/bbb/application');
    expect(a).not.toBe(b);
  });

  it('keeps two different CATS job ids distinct', () => {
    const a = normalizeUrlForCache('https://timberlinegrp.catsone.com/careers/7276/jobs/111-aaa/apply');
    const b = normalizeUrlForCache('https://timberlinegrp.catsone.com/careers/7276/jobs/222-bbb/apply');
    expect(a).not.toBe(b);
  });

  // The actual bug: an earlier version of this function used an ALLOWLIST
  // of known job-id query params and dropped every other one. A platform
  // not on that list, whose job id lives ONLY in an unlisted query param
  // with an otherwise generic/shared path, made two DIFFERENT job
  // postings collapse to the identical key — so the second job silently
  // showed as "Applied" the moment its page loaded, even though the user
  // never applied to it.
  it('keeps two different jobs distinct on a platform with an unrecognized job-id query param (the actual bug)', () => {
    const a = normalizeUrlForCache('https://www.ziprecruiter.com/apply?jid=abc111');
    const b = normalizeUrlForCache('https://www.ziprecruiter.com/apply?jid=xyz999');
    expect(a).not.toBe(b);
    expect(a).toContain('jid=abc111');
    expect(b).toContain('jid=xyz999');
  });

  it('keeps an arbitrary, previously-unlisted job-id param name (not just a hardcoded few)', () => {
    const a = normalizeUrlForCache('https://careers.example.com/job?postingId=111');
    const b = normalizeUrlForCache('https://careers.example.com/job?postingId=222');
    expect(a).not.toBe(b);
  });
});

describe('normalizeUrlForCache — robustness', () => {
  it('returns input unchanged when not a parseable URL', () => {
    expect(normalizeUrlForCache('not a url')).toBe('not a url');
  });

  it('handles empty / null / non-string input without throwing', () => {
    expect(normalizeUrlForCache('')).toBe('');
    expect(normalizeUrlForCache(null)).toBe(null);
    expect(normalizeUrlForCache(undefined)).toBe(undefined);
    expect(normalizeUrlForCache(42)).toBe(42);
  });
});
