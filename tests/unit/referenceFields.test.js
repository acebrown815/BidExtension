// Paylocity (recruiting.paylocity.com) "References" step: each "Reference N"
// block's fields are labelled just "Name" / "Email Address" / "Phone
// Number", so the applicant's own name, email and phone went into all three
// references. Those answers come from the saved Q&A instead.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let R;

beforeAll(async () => {
  await import('../../lib/qaMatch.js');
  await import('../../lib/radioGroupLabel.js');
  await import('../../lib/fieldFilter.js');
  await import('../../lib/referenceFields.js');
  R = globalThis.JMReferenceFields;
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(ROOT, 'directFill.js'), 'utf8'));
});

// Trimmed from the live page (two of the three blocks).
const block = (n) => `
  <span class="reference-group"><div class="col-xs-12 no-horizontal-padding"><div class="col-xs-12"><div class="section-heading">Reference ${n + 1}</div></div><div class="col-xs-12 no-horizontal-padding">
    <div class="col-sm-6 col-xs-12"><div class="form-group form-required"><label>Name<span><em> (required)</em></span></label><input data-automation-id="referencesName${n}" data-for="Name" id="references.name.${n}" placeholder="" type="text" value=""><div class="type-footnote hidden"></div></div></div>
    <div class="col-sm-6 col-xs-12"><div class="form-group form-required"><label>Email Address<span><em> (required)</em></span></label><input data-automation-id="referencesEmail${n}" data-for="Email Address" id="references.email.${n}" placeholder="" type="text" value=""><div class="type-footnote hidden"></div></div></div>
    <div class="col-sm-6 col-xs-12"><div class="form-group form-required"><label>Phone Number<span><em> (required)</em></span></label><input data-automation-id="referencesPhone${n}" data-for="Phone Number" id="references.phone.${n}" placeholder="" type="text" value=""><div class="type-footnote hidden"></div></div></div>
    <div class="col-sm-6 col-xs-12"><div class="form-group form-required"><label>Personal or Work Reference?<span><em> (required)</em></span></label><div data-for="Personal or Work Reference?" id="references.referenceType.${n}" role="combobox" class="rw-dropdownlist rw-widget"><div class="rw-input">--</div></div></div></div>
  </div></div></span>`;
const PAGE = `
  <div class="col-xs-12 section-wrapper" id="pcty-wr-apply-references"><div class="section-heading">References</div>
    <p>Please provide the names and contact information …</p>
    ${block(0)}${block(1)}
  </div>
  <div class="form-group"><label for="me">Phone Number</label><input id="me" type="text" value=""></div>`;

const PROFILE = { name: 'Randolph Lee Brown', email: 'brownrandolph07@gmail.com', phone: '+1 720 310 5861' };
const QA = [
  { question: 'Reference 1 Name', answer: 'Jane Smith' },
  { question: 'Reference 1 Email', answer: 'jane.smith@acme.com' },
  { question: 'Reference 1 Phone', answer: '303-555-0101' },
  { question: 'Reference 1 Type (Personal or Work)', answer: 'Work' },
  { question: 'Second reference – full name', answer: 'Tom Lee' },
  { question: 'Second reference – email address', answer: 'tom.lee@globex.com' },
  { question: 'Second reference – mobile', answer: '303-555-0202' },
  { question: 'Phone number', answer: '720-310-5861' },
];

describe('which reference a field belongs to', () => {
  it('reads "Reference N" from the block heading — not the section title "References"', () => {
    document.body.innerHTML = PAGE;
    expect(R.referenceContext(document.getElementById('references.name.0'))).toEqual({ index: 1, label: 'Reference 1' });
    expect(R.referenceContext(document.getElementById('references.phone.1'))).toEqual({ index: 2, label: 'Reference 2' });
    expect(R.referenceContext(document.getElementById('me'))).toBeNull();
  });

  it('falls back to the id ("references.email.2" → Reference 3)', () => {
    document.body.innerHTML = '<div><label for="references.email.2">Email</label><input id="references.email.2"></div>';
    expect(R.referenceContext(document.getElementById('references.email.2')).index).toBe(3);
  });

  it('never takes "Referred By" / referral fields for a reference', () => {
    document.body.innerHTML = '<div><label for="info.referredBy">Referred By</label><input id="info.referredBy"></div>';
    expect(R.referenceContext(document.getElementById('info.referredBy'))).toBeNull();
  });
});

describe('the saved answer for a reference field', () => {
  it.each([
    [1, 'Name', 'Jane Smith'],
    [1, 'Email Address', 'jane.smith@acme.com'],
    [1, 'Phone Number', '303-555-0101'],
    [1, 'Personal or Work Reference?', 'Work'],
    [2, 'Name', 'Tom Lee'],
    [2, 'Phone Number', '303-555-0202'],
    [3, 'Name', null],
  ])('Reference %i %s → %s', (n, label, expected) => {
    expect(R.referenceAnswer(QA, n, label)).toBe(expected);
  });

  it('uses an entry without a number for any reference, and splits a full name', () => {
    const qa = [{ question: 'Reference name', answer: 'Ann Wu' }];
    expect(R.referenceAnswer(qa, 3, 'Name')).toBe('Ann Wu');
    expect(R.referenceAnswer(qa, 1, 'First Name')).toBe('Ann');
    expect(R.referenceAnswer(qa, 1, 'Last Name')).toBe('Wu');
  });
});

describe('filling the References step', () => {
  it('fills each reference from the saved Q&A — never the applicant\'s own details', async () => {
    document.body.innerHTML = PAGE;
    await window.__jobMatchDirectFill(QA, PROFILE);
    const v = (id) => document.getElementById(id).value;
    expect([v('references.name.0'), v('references.email.0'), v('references.phone.0')])
      .toEqual(['Jane Smith', 'jane.smith@acme.com', '303-555-0101']);
    expect([v('references.name.1'), v('references.email.1'), v('references.phone.1')])
      .toEqual(['Tom Lee', 'tom.lee@globex.com', '303-555-0202']);
    // the applicant's own phone field still gets the applicant's phone
    expect(v('me')).toBe('+1 720 310 5861');
  });

  it('leaves a reference empty rather than putting the applicant in it', async () => {
    document.body.innerHTML = PAGE;
    await window.__jobMatchDirectFill([], PROFILE);
    expect(document.getElementById('references.name.0').value).toBe('');
    expect(document.getElementById('references.email.1').value).toBe('');
  });
});
