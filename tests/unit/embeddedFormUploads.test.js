// Live on octane.co (Greenhouse application embedded in a cross-origin
// iframe): "Cover Letter is required" stayed empty and the original resume
// went in instead of the tailored one — the iframe's copy of content.js has
// no analysis and no tailored resume. The frame now gets both from the top
// frame (GET_TOP_FRAME_UPLOAD → PROVIDE_UPLOAD_FILE).
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'content.js'), 'utf8').replace(/\r\n/g, '\n');
const slice = (a, b) => {
  const start = SRC.indexOf(a);
  const end = SRC.indexOf(b, start);
  if (start === -1 || end === -1) throw new Error('content.js source anchors moved — update this test\'s extraction markers');
  return SRC.slice(start, end);
};

function harness({ topFrame }) {
  const code = slice('  let _frameCoverLetterCache = null;', '  // ─── Utility ───');
  return new Function('env', ` // eslint-disable-line no-new-func
    let _activeResumeId = env.resumeId;
    const isTop = env.topFrame;
    const isRealTopFrame = () => isTop;
    const normalizeUrl = (u) => u;
    const buildCoverLetterFile = async () => { env.coverLetterBuilds++; return env.coverLetter; };
    const buildActiveResumeFile = async () => env.resume;
    const sendMessage = async (msg) => env.relay(msg);
    function base64ToBlob(b64, mime) { return new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type: mime }); }
    ${code}
    return { provideUploadFileForFrame, fileFromTopFrame };
  `)(Object.assign(env, { topFrame }));
}

let env;
beforeEach(() => {
  env = {
    resumeId: 'r_tailored',
    coverLetterBuilds: 0,
    coverLetter: { file: new File(['%PDF letter'], 'cover_letter.pdf', { type: 'application/pdf' }), fileName: 'cover_letter.pdf', mime: 'application/pdf' },
    resume: { file: new File(['PK tailored docx'], 'Resume_Tailored.docx', { type: 'application/x-docx' }), fileName: 'Resume_Tailored.docx', mime: 'application/x-docx', ext: 'docx' },
  };
});

describe('embedded application form uploads', () => {
  it('the frame receives the top frame\'s cover letter and tailored resume, byte for byte', async () => {
    const top = harness({ topFrame: true });
    env.relay = async (msg) => top.provideUploadFileForFrame(msg.kind);
    const frame = harness({ topFrame: false });

    const cl = await frame.fileFromTopFrame('coverLetter');
    expect(cl.fileName).toBe('cover_letter.pdf');
    expect(await cl.file.text()).toBe('%PDF letter');

    const resume = await frame.fileFromTopFrame('resume');
    expect(resume.fileName).toBe('Resume_Tailored.docx');
    expect(resume.ext).toBe('docx');
    expect(await resume.file.text()).toBe('PK tailored docx');
  });

  it('writes the cover letter once per job, however often the frame asks', async () => {
    const top = harness({ topFrame: true });
    await top.provideUploadFileForFrame('coverLetter');
    await top.provideUploadFileForFrame('coverLetter');
    expect(env.coverLetterBuilds).toBe(1);
  });

  it('tells the frame which resume the panel selected', async () => {
    const top = harness({ topFrame: true });
    expect(await top.provideUploadFileForFrame('context')).toEqual({ resumeId: 'r_tailored' });
  });

  it('falls back (null) when the top frame has nothing, and never asks from the top frame itself', async () => {
    env.relay = async () => null;
    expect(await harness({ topFrame: false }).fileFromTopFrame('coverLetter')).toBe(null);
    env.relay = async () => { throw new Error('should not be called'); };
    expect(await harness({ topFrame: true }).fileFromTopFrame('resume')).toBe(null);
  });
});
