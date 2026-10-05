// Workday "My Experience" step (confirmed on bcbsla.wd1.myworkdayjobs.com):
// Work Experience and Education are empty sections with an "Add" button; a
// panel's fields (Job Title, Company, Location, I currently work here,
// From/To month-year spinbuttons, Role Description — or School, Degree, Field
// of Study, GPA) only appear a moment after clicking it, and the button then
// reads "Add Another". Generic AutoFill never clicked "Add", and when a panel
// was present it put the Q&A answer "No" into a job's Location.
//
// Panel markup below is trimmed verbatim from the live page.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { isFieldEligible } = require(path.join(ROOT, 'lib', 'fieldFilter.js'));

let HELPERS;

beforeAll(() => {
  const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('  // ── Workday apply-flow single-selects');
  const end = src.indexOf('  /**\n   * Polls findVisibleOptions() until', start);
  if (start === -1 || end === -1) throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  HELPERS = src.slice(start, end);
});

const dateField = (prefix, key, label, monthToo = true) => `
  <div data-automation-id="formField-${key}" data-fkit-id="${prefix}--${key}"><fieldset><legend><label><span>${label}</span></label></legend>
    <div id="${prefix}--${key}" role="group" data-automation-id="dateInputWrapper">
      ${monthToo ? `<div><div data-automation-id="dateSectionMonth-display">MM</div><input role="spinbutton" aria-label="Month" id="${prefix}--${key}-dateSectionMonth-input" data-automation-id="dateSectionMonth-input" value=""></div><div>/</div>` : ''}
      <div><div data-automation-id="dateSectionYear-display">YYYY</div><input role="spinbutton" aria-label="Year" id="${prefix}--${key}-dateSectionYear-input" data-automation-id="dateSectionYear-input" value=""></div>
    </div></fieldset></div>`;

const textField = (prefix, key, label, tag = 'input') => `
  <div data-automation-id="formField-${key}" data-fkit-id="${prefix}--${key}"><label for="${prefix}--${key}">${label}</label>
    ${tag === 'textarea' ? `<textarea id="${prefix}--${key}"></textarea>` : `<input type="text" id="${prefix}--${key}" name="${key}" value="">`}</div>`;

function experiencePanel(n) {
  const p = `workExperience-${13 + n}`;
  return `<div role="group" aria-labelledby="Work-Experience-${n}-panel"><div><h5 id="Work-Experience-${n}-panel">Work Experience ${n}</h5><button>Delete</button></div>
    <div data-fkit-id="${p}--null">
      ${textField(p, 'jobTitle', 'Job Title')}
      ${textField(p, 'companyName', 'Company')}
      ${textField(p, 'location', 'Location')}
      <div data-automation-id="formField-currentlyWorkHere" data-fkit-id="${p}--currentlyWorkHere"><label for="${p}--currentlyWorkHere">I currently work here</label>
        <input id="${p}--currentlyWorkHere" type="checkbox" name="currentlyWorkHere"></div>
      ${dateField(p, 'startDate', 'From')}
      ${dateField(p, 'endDate', 'To')}
      ${textField(p, 'roleDescription', 'Role Description', 'textarea')}
    </div></div>`;
}

function educationPanel(n) {
  const p = `education-${48 + n}`;
  return `<div role="group" aria-labelledby="Education-${n}-panel"><div><h5 id="Education-${n}-panel">Education ${n}</h5><button>Delete</button></div>
    <div data-fkit-id="${p}--null">
      ${textField(p, 'schoolName', 'School or University')}
      ${textField(p, 'gradeAverage', 'Overall Result (GPA)')}
      ${dateField(p, 'firstYearAttended', 'From', false)}
      ${dateField(p, 'lastYearAttended', 'To', false)}
    </div></div>`;
}

const PAGE_HTML = `
  <div data-automation-id="applyFlowMyExpPage">
    <div role="group" aria-labelledby="Work-Experience-section"><h4 id="Work-Experience-section">Work Experience</h4>
      <div><button data-automation-id="add-button">Add</button></div></div>
    <div role="group" aria-labelledby="Education-section"><h4 id="Education-section">Education</h4>
      <div><button data-automation-id="add-button">Add</button></div></div>
    <div role="group" aria-labelledby="Websites-section"><h4 id="Websites-section">Websites</h4>
      <div><button data-automation-id="add-button">Add</button></div></div>
  </div>
`;

/** "Add" / "Add Another" inserts a new panel ~400ms later, like the live page. */
function wireAddButtons() {
  const wire = (sectionId, makePanel) => {
    const section = document.querySelector(`[aria-labelledby="${sectionId}"]`);
    const button = section.querySelector('[data-automation-id="add-button"]');
    let count = 0;
    button.addEventListener('click', () => setTimeout(() => {
      count++;
      button.parentElement.insertAdjacentHTML('beforebegin', makePanel(count));
      button.textContent = 'Add Another';
    }, 400));
  };
  wire('Work-Experience-section', experiencePanel);
  wire('Education-section', educationPanel);
}

function load(profile) {
  const factory = new Function('profile', ` // eslint-disable-line no-new-func
    const sleep = (ms) => new Promise(r => setTimeout(r, Math.min(ms, 50)));
    const clickElement = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    function fillInput(el, value) { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); return true; }
    async function waitForDomSettled() {}
    function setStatus() {}
    const isWorkdayHost = () => true;
    const _activeResumeId = 'resume-1';
    async function sendMessage(msg) { return msg.type === 'GET_PROFILE' ? profile : null; }
    ${HELPERS}
    return { fillWorkdayMyExperienceStep, parseResumeDateRange, findExactOptionByText, withAnswerHint };
  `);
  return factory(profile);
}

const PROFILE = {
  experience: [
    { title: 'Senior Software Engineer', company: 'Reconnect', dates: 'Mar 2024 - Present', description: 'Led the platform team.' },
    { title: 'Software Engineer', company: 'Acme Corp', location: 'Denver, CO', dates: '06/2019 – 02/2024', description: 'Built APIs.' },
  ],
  education: [
    { school: 'University of Colorado', degree: 'B.S. in Computer Science', dates: '2015 - 2019', details: 'GPA: 3.7, Dean\'s List' },
  ],
};

const val = (sel) => document.querySelector(sel).value;

describe('parseResumeDateRange', () => {
  it.each([
    ['Jan 2020 - Present', { start: { month: 1, year: 2020 }, end: null, current: true }],
    ['March 2018 – December 2021', { start: { month: 3, year: 2018 }, end: { month: 12, year: 2021 }, current: false }],
    ['06/2019 – 02/2024', { start: { month: 6, year: 2019 }, end: { month: 2, year: 2024 }, current: false }],
    ['2015 - 2019', { start: { month: null, year: 2015 }, end: { month: null, year: 2019 }, current: false }],
    ['2018-2020', { start: { month: null, year: 2018 }, end: { month: null, year: 2020 }, current: false }],
    ['2021-04 to 2023-01', { start: { month: 4, year: 2021 }, end: { month: 1, year: 2023 }, current: false }],
    ['Sept. 2022 - Current', { start: { month: 9, year: 2022 }, end: null, current: true }],
  ])('%s', (text, expected) => {
    expect(load({}).parseResumeDateRange(text)).toEqual(expected);
  });
});

describe('fillWorkdayMyExperienceStep', { timeout: 20000 }, () => {
  beforeEach(() => {
    document.body.innerHTML = PAGE_HTML;
    wireAddButtons();
  });

  it('clicks Add / Add Another and fills one Work Experience panel per resume entry', async () => {
    const result = await load(PROFILE).fillWorkdayMyExperienceStep();
    expect(result).toEqual({ experience: 2, education: 1 });

    const exp = document.querySelectorAll('[aria-labelledby="Work-Experience-section"] [aria-labelledby$="-panel"]');
    expect(exp).toHaveLength(2);
    // Entry 1: current job, no location on record → Remote.
    expect(val('#workExperience-14--jobTitle')).toBe('Senior Software Engineer');
    expect(val('#workExperience-14--companyName')).toBe('Reconnect');
    expect(val('#workExperience-14--location')).toBe('Remote');
    expect(document.getElementById('workExperience-14--currentlyWorkHere').checked).toBe(true);
    expect(val('#workExperience-14--startDate-dateSectionMonth-input')).toBe('03');
    expect(val('#workExperience-14--startDate-dateSectionYear-input')).toBe('2024');
    expect(val('#workExperience-14--endDate-dateSectionYear-input')).toBe('');
    expect(val('#workExperience-14--roleDescription')).toBe('Led the platform team.');
    // Entry 2: its own location, a finished job.
    expect(val('#workExperience-15--location')).toBe('Denver, CO');
    expect(document.getElementById('workExperience-15--currentlyWorkHere').checked).toBe(false);
    expect(val('#workExperience-15--startDate-dateSectionMonth-input')).toBe('06');
    expect(val('#workExperience-15--endDate-dateSectionMonth-input')).toBe('02');
    expect(val('#workExperience-15--endDate-dateSectionYear-input')).toBe('2024');
    expect(document.querySelector('[aria-labelledby="Work-Experience-section"] [data-automation-id="add-button"]').textContent).toBe('Add Another');
  });

  it('fills Education panels (school, GPA from details, year-only dates)', async () => {
    await load(PROFILE).fillWorkdayMyExperienceStep();
    expect(val('#education-49--schoolName')).toBe('University of Colorado');
    expect(val('#education-49--gradeAverage')).toBe('3.7');
    expect(val('#education-49--firstYearAttended-dateSectionYear-input')).toBe('2015');
    expect(val('#education-49--lastYearAttended-dateSectionYear-input')).toBe('2019');
  });

  it('marks filled panels so the generic Q&A/AI passes skip them', async () => {
    await load(PROFILE).fillWorkdayMyExperienceStep();
    expect(isFieldEligible(document.getElementById('workExperience-14--location'))).toBe(false);
    expect(isFieldEligible(document.getElementById('education-49--schoolName'))).toBe(false);
  });

  it('never touches the Websites section or adds panels with no resume entries', async () => {
    const result = await load({ experience: [], education: [] }).fillWorkdayMyExperienceStep();
    expect(result).toEqual({ experience: 0, education: 0 });
    expect(document.querySelectorAll('[aria-labelledby$="-panel"]')).toHaveLength(0);
  });

  it('is a no-op off the My Experience step', async () => {
    document.body.innerHTML = '<div data-automation-id="applyFlowMyInfoPage"></div>';
    expect(await load(PROFILE).fillWorkdayMyExperienceStep()).toBeNull();
  });
});

describe('answer hints for Workday selects/prompts', () => {
  it('matches a known answer only exactly (never by containment)', () => {
    const { findExactOptionByText, withAnswerHint } = load({});
    const options = [{ text: 'Science' }, { text: "Bachelor's Degree" }, { text: 'B.S. in Computer Science' }];
    expect(findExactOptionByText(options, 'B.S. in Computer Science').text).toBe('B.S. in Computer Science');
    expect(findExactOptionByText(options.slice(0, 2), 'B.S. in Computer Science')).toBeNull();
    expect(withAnswerHint('Degree', 'B.S. in Computer Science')).toBe('Degree (the candidate\'s answer: "B.S. in Computer Science")');
  });
});
