// Workday tenants that start the apply flow with a "Create Account/Sign In"
// step (confirmed on bcbsla.wd1.myworkdayjobs.com/en-US/external/job/
// Remote-LA/Senior-Software-Engineer--Remote---Louisiana-_R11452/apply/
// autofillWithResume — "current step 1 of 8: Create Account/Sign In"). There
// is no "Next" button on that step, so Auto-Bid stalled on it; and the
// generic fill would have put AI text in the password fields and the
// candidate's website URL in Workday's "for robots only" beecatcher input.
//
// Markup below is trimmed verbatim from the live page.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { isFieldEligible } = require(path.join(ROOT, 'lib', 'fieldFilter.js'));

let SECTION;

beforeAll(() => {
  const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('  // ── Workday "Create Account/Sign In" step');
  const end = src.indexOf('  /**\n   * Workday\'s "Start Your Application" dialog', start);
  if (start === -1 || end === -1) throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  SECTION = src.slice(start, end);
});

const CREATE_ACCOUNT_HTML = `
  <div data-automation-id="signInContent">
    <h3 id="authViewTitle">Create Account</h3>
    <form data-automation-id="signInFormo">
      <div data-automation-id="formField-email"><label for="input-4"><span>Email Address<abbr>*</abbr></span></label>
        <input type="text" data-automation-id="email" id="input-4" value=""></div>
      <div data-automation-id="formField-password"><label for="input-5"><span>Password<abbr>*</abbr></span></label>
        <input type="password" data-automation-id="password" id="input-5" value=""></div>
      <div data-automation-id="formField-verifyPassword"><label for="input-6"><span>Verify New Password<abbr>*</abbr></span></label>
        <input type="password" data-automation-id="verifyPassword" id="input-6" value=""></div>
      <div data-automation-id="noCaptchaWrapper">
        <div aria-label="Create Account" role="button" tabindex="0" data-automation-id="click_filter"></div>
        <button type="submit" data-automation-id="createAccountSubmitButton" tabindex="-2" aria-hidden="true">Create Account</button>
      </div>
    </form>
    <div>Already have an account?<button data-automation-id="signInLink">Sign In</button></div>
  </div>
  <div><label for="58d1fae9-9000-4591-8ecf-787da7d8e8e8">Enter website. This input is for robots only, do not enter if you're human.</label>
    <input data-automation-id="beecatcher" id="58d1fae9-9000-4591-8ecf-787da7d8e8e8" name="website" type="text"></div>
`;

const SIGN_IN_HTML = `
  <div data-automation-id="signInContent">
    <h3 id="authViewTitle">Sign In</h3>
    <form>
      <input type="text" data-automation-id="email" id="input-7" value="">
      <input type="password" data-automation-id="password" id="input-8" value="">
      <div aria-label="Sign In" role="button" tabindex="0" data-automation-id="click_filter"></div>
    </form>
  </div>
`;

const HOST = 'bcbsla.wd1.myworkdayjobs.com';

/**
 * @param {Object} opts
 * @param {Object} [opts.accounts] - initial chrome.storage.local workdayAccounts
 * @param {boolean} [opts.autoBid=true]
 * @param {(el: Element) => void} [opts.onClick] - simulated page reaction to a click
 */
function load({ accounts = {}, autoBid = true, onClick = () => {}, hostname = HOST } = {}) {
  const store = { workdayAccounts: JSON.parse(JSON.stringify(accounts)) };
  const events = [];
  const chrome = {
    storage: {
      local: {
        get: async (key) => ({ [key]: store[key] }),
        set: async (obj) => {
          Object.assign(store, JSON.parse(JSON.stringify(obj)));
          events.push({ type: 'save', accounts: JSON.parse(JSON.stringify(obj.workdayAccounts)) });
        },
      },
    },
  };
  const factory = new Function('chrome', 'location', 'events', 'onClick', 'autoBid', `  // eslint-disable-line no-new-func
    const _activeResumeId = 'resume-1';
    const _autoBidAutofillRun = autoBid;
    const sleep = (ms) => new Promise(r => setTimeout(r, Math.min(ms, 20)));
    async function waitForDomSettled() {}
    async function sendMessage(msg) { return msg.type === 'GET_PROFILE' ? { email: 'brownrandolph07@gmail.com' } : null; }
    function setStatus(text, type) { events.push({ type: 'status', text, level: type }); }
    function fillInput(el, value) { el.value = value; return true; }
    function clickElement(el) { events.push({ type: 'click', id: el.getAttribute('data-automation-id') }); onClick(el); }
    async function autoBidClick(el) { events.push({ type: 'autoBidClick', id: el.getAttribute('data-automation-id') }); onClick(el); }
    ${SECTION}
    return { handleWorkdayAccountStep, generateWorkdayPassword };
  `);
  return { ...factory(chrome, { hostname }, events, onClick, autoBid), store, events };
}

const PASSWORD_RULES = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/];

beforeEach(() => {
  document.body.innerHTML = CREATE_ACCOUNT_HTML;
});

describe('generateWorkdayPassword', () => {
  it('meets every listed Workday password rule and differs between calls', () => {
    const { generateWorkdayPassword } = load();
    const a = generateWorkdayPassword();
    const b = generateWorkdayPassword();
    expect(a).toHaveLength(16);
    PASSWORD_RULES.forEach(re => expect(a).toMatch(re));
    expect(a).not.toBe(b);
  });
});

describe('handleWorkdayAccountStep', () => {
  it('creates an account with a generated password, saved before submitting, then reports it advanced', async () => {
    const { handleWorkdayAccountStep, store, events } = load({
      onClick: (el) => {
        if (el.getAttribute('data-automation-id') === 'click_filter') document.body.innerHTML = '<div data-automation-id="applyFlowAutoFillPage"></div>';
      },
    });
    const password = document.querySelector('[data-automation-id="password"]');
    const verify = document.querySelector('[data-automation-id="verifyPassword"]');

    expect(await handleWorkdayAccountStep()).toBe('advanced');

    const saved = store.workdayAccounts[HOST];
    expect(saved.email).toBe('brownrandolph07@gmail.com');
    PASSWORD_RULES.forEach(re => expect(saved.password).toMatch(re));
    expect(saved.created).toBe(true);
    // Filled with the same saved password in both fields.
    expect(password.value).toBe(saved.password);
    expect(verify.value).toBe(saved.password);
    // Saved (unconfirmed) BEFORE the submit click, confirmed after.
    const firstSave = events.findIndex(e => e.type === 'save');
    const submitClick = events.findIndex(e => e.type === 'autoBidClick' && e.id === 'click_filter');
    expect(firstSave).toBeGreaterThan(-1);
    expect(firstSave).toBeLessThan(submitClick);
    expect(events[firstSave].accounts[HOST].created).toBe(false);
  });

  it('signs in with the saved password when this tenant already has an account', async () => {
    const accounts = { [HOST]: { email: 'brownrandolph07@gmail.com', password: 'Saved#Pass2345xy', created: true } };
    const { handleWorkdayAccountStep, events } = load({
      accounts,
      onClick: (el) => {
        const id = el.getAttribute('data-automation-id');
        if (id === 'signInLink') document.body.innerHTML = SIGN_IN_HTML;
        else if (id === 'click_filter') document.body.innerHTML = '<div data-automation-id="applyFlowAutoFillPage"></div>';
      },
    });
    let filledPassword = null;
    const origOnClick = events.push.bind(events);
    events.push = (e) => {
      if (e.type === 'autoBidClick') filledPassword = document.querySelector('[data-automation-id="password"]').value;
      return origOnClick(e);
    };

    expect(await handleWorkdayAccountStep()).toBe('advanced');
    expect(filledPassword).toBe('Saved#Pass2345xy');
    expect(events.some(e => e.type === 'click' && e.id === 'signInLink')).toBe(true);
  });

  it('switches to Sign In when Create Account says the account already exists', async () => {
    let createAttempts = 0;
    const { handleWorkdayAccountStep, store } = load({
      onClick: (el) => {
        const id = el.getAttribute('data-automation-id');
        if (id === 'click_filter' && document.querySelector('[data-automation-id="verifyPassword"]')) {
          createAttempts++;
          const alert = document.createElement('div');
          alert.setAttribute('data-automation-id', 'errorMessage');
          alert.textContent = 'An account with this email already exists.';
          document.querySelector('[data-automation-id="signInContent"]').appendChild(alert);
        } else if (id === 'signInLink') {
          document.body.innerHTML = SIGN_IN_HTML;
        } else if (id === 'click_filter') {
          document.body.innerHTML = '<div data-automation-id="applyFlowAutoFillPage"></div>';
        }
      },
    });

    expect(await handleWorkdayAccountStep()).toBe('advanced');
    expect(createAttempts).toBe(1);
    expect(store.workdayAccounts[HOST].created).toBe(true);
  });

  it('on a manual AutoFill click, fills the fields but leaves the submit click to the user', async () => {
    const { handleWorkdayAccountStep, events } = load({ autoBid: false });

    expect(await handleWorkdayAccountStep()).toBe('stop');
    expect(document.querySelector('[data-automation-id="password"]').value).not.toBe('');
    expect(events.some(e => e.type === 'autoBidClick')).toBe(false);
  });

  it('stops (never guesses) on a Sign In form with no saved password for the tenant', async () => {
    document.body.innerHTML = SIGN_IN_HTML;
    const { handleWorkdayAccountStep, events } = load();

    expect(await handleWorkdayAccountStep()).toBe('stop');
    expect(events.some(e => e.type === 'autoBidClick')).toBe(false);
    expect(events.find(e => e.type === 'status').level).toBe('error');
  });

  it('uses ONE password across Workday sites: a new site reuses the password already in use elsewhere', async () => {
    const accounts = { 'becu.wd1.myworkdayjobs.com': { email: 'brownrandolph07@gmail.com', password: 'Shared#Pass2345xy', created: true, updatedAt: 1 } };
    const { handleWorkdayAccountStep, store } = load({
      accounts,
      onClick: (el) => { if (el.getAttribute('data-automation-id') === 'click_filter') document.body.innerHTML = '<div></div>'; },
    });
    let typed = null;
    document.querySelector('[data-automation-id=\"password\"]').addEventListener('input', (e) => { typed = e.target.value; });

    expect(await handleWorkdayAccountStep()).toBe('advanced');
    expect(store.workdayAccounts[HOST].password).toBe('Shared#Pass2345xy');
    expect(store.workdaySharedPassword).toBe('Shared#Pass2345xy');
  });

  it('fills EVERY password box on the form with the same password', async () => {
    document.querySelector('[data-automation-id=\"verifyPassword\"]').insertAdjacentHTML('afterend', '<input type=\"password\" id=\"confirm-again\" value=\"\">');
    const { handleWorkdayAccountStep, store } = load({ autoBid: false });
    await handleWorkdayAccountStep();
    const values = Array.from(document.querySelectorAll('input[type=\"password\"]')).map(i => i.value);
    expect(values).toHaveLength(3);
    expect(new Set(values).size).toBe(1);
    expect(values[0]).toBe(store.workdayAccounts[HOST].password);
  });

  it('clicks "Sign in with email", then "Create Account", when the step first shows sign-in options (becu.wd1)', async () => {
    // Live: no Create Account form on arrival — only sign-in options; the
    // email form (with its "Create Account" link) appears after "Sign in
    // with email".
    document.body.innerHTML = `
      <div data-automation-id="applyFlowPage"><div class="sign-in-options">
        <button data-automation-id="SignInWithGoogleButton">Sign in with Google</button>
        <button data-automation-id="SignInWithEmailButton">Sign in with email</button>
      </div></div>`;
    const clicks = [];
    const { handleWorkdayAccountStep, store } = load({
      onClick: (el) => {
        const id = el.getAttribute('data-automation-id');
        clicks.push(id);
        if (id === 'SignInWithEmailButton') {
          document.body.innerHTML = SIGN_IN_HTML.replace('</form>', '</form><div>Don\'t have an account yet?<button data-automation-id="createAccountLink">Create Account</button></div>');
        } else if (id === 'createAccountLink') {
          document.body.innerHTML = CREATE_ACCOUNT_HTML;
        } else if (id === 'click_filter' && document.querySelector('[data-automation-id="verifyPassword"]')) {
          document.body.innerHTML = '<div data-automation-id="applyFlowAutoFillPage"></div>';
        }
      },
    });

    expect(await handleWorkdayAccountStep()).toBe('advanced');

    expect(clicks).toEqual(['SignInWithEmailButton', 'createAccountLink', 'click_filter']);
    expect(store.workdayAccounts[HOST].created).toBe(true);
  });

  it('after "Sign in with email", signs in directly when an account for this tenant is saved', async () => {
    document.body.innerHTML = '<div data-automation-id="applyFlowPage"><button>Sign in with email</button></div>';
    const accounts = { [HOST]: { email: 'brownrandolph07@gmail.com', password: 'Saved#Pass2345xy', created: true } };
    let passwordAtSubmit = null;
    const { handleWorkdayAccountStep } = load({
      accounts,
      onClick: (el) => {
        if ((el.textContent || '').trim() === 'Sign in with email') document.body.innerHTML = SIGN_IN_HTML;
        else if (el.getAttribute('data-automation-id') === 'click_filter') {
          passwordAtSubmit = document.querySelector('[data-automation-id="password"]').value;
          document.body.innerHTML = '<div data-automation-id="applyFlowAutoFillPage"></div>';
        }
      },
    });

    expect(await handleWorkdayAccountStep()).toBe('advanced');
    expect(passwordAtSubmit).toBe('Saved#Pass2345xy');
  });

  it('finds an email/password form shown in a dialog instead of signInContent', async () => {
    document.body.innerHTML = `<div role="dialog"><form>
      <input type="text" data-automation-id="email" value="">
      <input type="password" data-automation-id="password" value="">
      <input type="password" data-automation-id="verifyPassword" value="">
      <div role="button" data-automation-id="click_filter"></div></form></div>`;
    const { handleWorkdayAccountStep } = load({
      onClick: (el) => { if (el.getAttribute('data-automation-id') === 'click_filter') document.body.innerHTML = '<div></div>'; },
    });
    expect(await handleWorkdayAccountStep()).toBe('advanced');
  });

  it('does nothing off Workday or on a step without the account form', async () => {
    expect(await load({ hostname: 'jobs.lever.co' }).handleWorkdayAccountStep()).toBeNull();
    document.body.innerHTML = '<div data-automation-id="applyFlowAutoFillPage"></div>';
    expect(await load().handleWorkdayAccountStep()).toBeNull();
  });
});

describe('isFieldEligible — account step fields the generic fill must never touch', () => {
  it('excludes password inputs and the "for robots only" beecatcher honeypot', () => {
    expect(isFieldEligible(document.querySelector('[data-automation-id="password"]'))).toBe(false);
    expect(isFieldEligible(document.querySelector('[data-automation-id="verifyPassword"]'))).toBe(false);
    expect(isFieldEligible(document.querySelector('[data-automation-id="beecatcher"]'))).toBe(false);
    expect(isFieldEligible(document.querySelector('[data-automation-id="email"]'))).toBe(true);
  });

  it('excludes a honeypot identified only by its label', () => {
    document.body.innerHTML = '<label for="hp1">Leave this field blank</label><input id="hp1" name="url" type="text">';
    expect(isFieldEligible(document.getElementById('hp1'))).toBe(false);
  });
});
