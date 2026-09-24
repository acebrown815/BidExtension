// Regression test for a real bug found live on a Hireology-hosted careers
// form (careers.hireology.com): its labels are written with the
// required/optional annotation as part of the label's own visible text —
// "First name (required)", "Email address (required)", "Phone number
// (required)", "City (optional)" — rather than a separate element. Direct
// Fill's matchQA() does an EXACT (non-fuzzy, deliberately — see its own
// comment) match against a short profileMap key like "first name" for
// these common personal-info fields, so "first name (required)" never
// matched "first name" at all and the field was silently left for Pass 2
// (the AI) instead of being filled immediately and reliably here.
//
// Loads the whole directFill.js file via eval (same convention as
// directFillRealClick.test.js) and exercises the real
// window.__jobMatchDirectFill entry point end-to-end.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIRECT_FILL_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'directFill.js');

beforeAll(async () => {
  await import('../../lib/qaMatch.js');
  await import('../../lib/radioGroupLabel.js');
});

function loadDirectFill() {
  const src = fs.readFileSync(DIRECT_FILL_PATH, 'utf8');
  // eslint-disable-next-line no-eval
  (0, eval)(src);
}

// Same field shapes as the real Hireology form: a plain <input> + a
// separate <label for="..."> whose text includes the requirement
// annotation as part of the label itself.
const HIREOLOGY_FORM_HTML = `
<input id="first_name-0" type="text" value="">
<label for="first_name-0">First name (required)</label>
<input id="last_name-0" type="text" value="">
<label for="last_name-0">Last name (required)</label>
<input id="email_address-0" type="email" value="">
<label for="email_address-0">Email address (required)</label>
<input id="home_phone-0" type="tel" value="">
<label for="home_phone-0">Phone number (required)</label>
<input id="city-0" type="text" value="">
<label for="city-0">City (optional)</label>
`;

const PROFILE = { name: 'Randolph Lee Brown', email: 'brownrandolph07@gmail.com', phone: '+1(720)310-5861', location: 'Summerfield, FL, USA' };

describe('Direct-fill matches "Label (required)"/"(optional)" personal-info fields (the actual bug)', () => {
  beforeEach(() => {
    document.body.innerHTML = HIREOLOGY_FORM_HTML;
    delete window.__jobMatchDirectFill;
    delete globalThis.JMFieldFilter;
    loadDirectFill();
  });

  it('fills first name, last name, email, and phone despite the "(required)" suffix', async () => {
    const result = await window.__jobMatchDirectFill([], PROFILE);
    expect(document.getElementById('first_name-0').value).toBe('Randolph');
    expect(document.getElementById('last_name-0').value).toBe('Lee Brown');
    expect(document.getElementById('email_address-0').value).toBe('brownrandolph07@gmail.com');
    expect(document.getElementById('home_phone-0').value).toBe('+1(720)310-5861');
    expect(result.filled).toBe(5); // includes the city-0 field from the same form (see the next test)
  });

  it('fills city despite the "(optional)" suffix', async () => {
    await window.__jobMatchDirectFill([], PROFILE);
    expect(document.getElementById('city-0').value).toBe('Summerfield');
  });

  it('still matches the plain label with no annotation at all (no regression)', async () => {
    document.body.innerHTML = '<input id="fn" type="text" value=""><label for="fn">First name</label>';
    loadDirectFill();
    await window.__jobMatchDirectFill([], PROFILE);
    expect(document.getElementById('fn').value).toBe('Randolph');
  });

  it('does not strip "(required)"/"(optional)" from the middle of a label, only a trailing annotation', async () => {
    // A saved Q&A entry whose own question text happens to contain
    // "(required)" mid-sentence must still match on the FULL original
    // wording, not a mangled version with an unrelated middle chunk cut out.
    document.body.innerHTML = '<input id="q1" type="text" value=""><label for="q1">Is a cover letter (required) for this role?</label>';
    loadDirectFill();
    const qaList = [{ question: 'Is a cover letter (required) for this role?', answer: 'No, optional' }];
    const result = await window.__jobMatchDirectFill(qaList, {});
    expect(document.getElementById('q1').value).toBe('No, optional');
    expect(result.filled).toBe(1);
  });
});
