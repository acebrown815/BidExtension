// lib/fieldErrorFix.js — reads the validation message a form shows under a
// field and rewrites the value to satisfy it. Live case: Paylocity's "Next
// Step" rejected "linkedin.com/in/…" with only a .form-group.form-error
// wrapper and a footnote ("Must be a valid LinkedIn URL. Example:
// https://www.linkedin.com/in/yourname") — no aria-invalid, no role="alert".
import { describe, it, expect, beforeAll } from 'vitest';

let fieldErrorMessage, suggestFixFromErrorMessage, fieldShowsError;
beforeAll(async () => {
  await import('../../lib/fieldErrorFix.js');
  await import('../../lib/fieldFilter.js');
  ({ fieldErrorMessage, suggestFixFromErrorMessage } = globalThis.JMFieldErrorFix);
  ({ fieldShowsError } = globalThis.JMFieldFilter);
});

const PAYLOCITY_LINKEDIN_ERROR = `
  <div class="form-group form-required form-error"><label>LinkedIn Profile URL<span><em> (required)</em></span></label><input data-automation-id="infoLinkedIn" data-for="LinkedIn Profile URL" id="info.linkedIn" placeholder="" type="text" value="linkedin.com/in/randolph-brown-34286528b"><div class="type-footnote show">Must be a valid LinkedIn URL. Example: https://www.linkedin.com/in/yourname</div></div>
`;

describe('fieldErrorMessage', () => {
  it("reads Paylocity's footnote from the field's .form-group.form-error", () => {
    document.body.innerHTML = PAYLOCITY_LINKEDIN_ERROR;
    expect(fieldErrorMessage(document.getElementById('info.linkedIn')))
      .toBe('Must be a valid LinkedIn URL. Example: https://www.linkedin.com/in/yourname');
  });

  it('makes fieldShowsError flag that field', () => {
    document.body.innerHTML = PAYLOCITY_LINKEDIN_ERROR;
    expect(fieldShowsError(document.getElementById('info.linkedIn'))).toBe(true);
  });

  it('ignores the same footnote when the group is not marked as an error', () => {
    document.body.innerHTML = PAYLOCITY_LINKEDIN_ERROR.replace(' form-error', '');
    expect(fieldErrorMessage(document.getElementById('info.linkedIn'))).toBe('');
  });

  it('never takes the label text as the message', () => {
    document.body.innerHTML = '<div class="form-group has-error"><label class="error-label">Email</label><input id="e" value="x"></div>';
    expect(fieldErrorMessage(document.getElementById('e'))).toBe('');
  });

  it("does not read another field's message from a shared error-classed section", () => {
    document.body.innerHTML = `
      <section class="form-error">
        <div><input id="a" value="1"></div>
        <div><input id="b" value="2"><div class="error-message">B is wrong</div></div>
      </section>`;
    expect(fieldErrorMessage(document.getElementById('a'))).toBe('');
    expect(fieldErrorMessage(document.getElementById('b'))).toBe('');
  });

  it('reads an aria-errormessage target', () => {
    document.body.innerHTML = '<input id="w" aria-errormessage="w-err" value="foo"><span id="w-err">Please enter a valid URL</span>';
    expect(fieldErrorMessage(document.getElementById('w'))).toBe('Please enter a valid URL');
  });
});

describe('suggestFixFromErrorMessage', () => {
  it('adds https://www. to a LinkedIn URL, as the message\'s example shows', () => {
    expect(suggestFixFromErrorMessage('linkedin.com/in/randolph-brown-34286528b',
      'Must be a valid LinkedIn URL. Example: https://www.linkedin.com/in/yourname'))
      .toBe('https://www.linkedin.com/in/randolph-brown-34286528b');
  });

  it('adds only the scheme when the message has no example', () => {
    expect(suggestFixFromErrorMessage('github.com/rbrown', 'Please enter a valid URL'))
      .toBe('https://github.com/rbrown');
  });

  it('upgrades http to the example\'s https', () => {
    expect(suggestFixFromErrorMessage('http://linkedin.com/in/x', 'Example: https://www.linkedin.com/in/yourname'))
      .toBe('https://www.linkedin.com/in/x');
  });

  it('keeps digits only, trimmed to the stated count', () => {
    expect(suggestFixFromErrorMessage('+1 (720) 310-5861', 'Phone must contain only digits (10 digits)'))
      .toBe('7203105861');
  });

  it('cuts to a stated maximum length', () => {
    expect(suggestFixFromErrorMessage('abcdefghij', 'Maximum of 5 characters')).toBe('abcde');
  });

  it('strips spaces and mailto: from an email', () => {
    expect(suggestFixFromErrorMessage('mailto:jane @x.com', 'Enter a valid email address')).toBe('jane@x.com');
  });

  it('returns null for a message it has no rule for (the AI handles those)', () => {
    expect(suggestFixFromErrorMessage('Acme', 'Please choose a different answer')).toBeNull();
  });

  it('returns null when the value already satisfies the rule', () => {
    expect(suggestFixFromErrorMessage('https://www.linkedin.com/in/x', 'Must be a valid LinkedIn URL. Example: https://www.linkedin.com/in/yourname')).toBeNull();
  });

  it('returns null for an empty value', () => {
    expect(suggestFixFromErrorMessage('', 'Must be a valid URL')).toBeNull();
  });
});
