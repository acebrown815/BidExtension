import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  PROVIDERS,
  callAI,
  parseAnthropicModels,
  toAnthropicMessages,
  buildAnthropicBody,
  defaultAnthropicQuirks,
  extractAnthropicText,
} from '../../aiService.js';

describe('Anthropic provider registry', () => {
  it('is registered with the anthropic apiStyle and a default model in its list', () => {
    const p = PROVIDERS.anthropic;
    expect(p.apiStyle).toBe('anthropic');
    expect(p.models.map(m => m.id)).toContain(p.defaultModel);
  });

  it('parser keeps every curated id', () => {
    const ids = PROVIDERS.anthropic.models.map(m => m.id);
    const json = { data: ids.map(id => ({ id, display_name: id })) };
    expect(parseAnthropicModels(json).map(m => m.id).sort()).toEqual(ids.slice().sort());
  });
});

describe('parseAnthropicModels', () => {
  it('uses display_name and drops non-claude ids', () => {
    const json = { data: [
      { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', type: 'model' },
      { id: 'something-else' },
      { id: 'claude-haiku-5-5' },
    ] };
    expect(parseAnthropicModels(json)).toEqual([
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
      { id: 'claude-haiku-5-5', name: 'claude-haiku-5-5' },
    ]);
  });

  it('is defensive about bad input', () => {
    expect(parseAnthropicModels(null)).toEqual([]);
    expect(parseAnthropicModels({ data: 'x' })).toEqual([]);
  });
});

describe('toAnthropicMessages', () => {
  it('moves system messages to the top-level system field', () => {
    const out = toAnthropicMessages([
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'Hi' },
    ]);
    expect(out).toEqual({ system: 'Be terse.', messages: [{ role: 'user', content: 'Hi' }] });
  });

  it('merges consecutive same-role turns and flattens text parts', () => {
    const out = toAnthropicMessages([
      { role: 'user', content: 'a' },
      { role: 'user', content: [{ type: 'text', text: 'b' }] },
      { role: 'assistant', content: 'c' },
    ]);
    expect(out.messages).toEqual([
      { role: 'user', content: 'a\n\nb' },
      { role: 'assistant', content: 'c' },
    ]);
  });

  it('ensures the conversation starts with a user turn', () => {
    const out = toAnthropicMessages([{ role: 'assistant', content: 'x' }]);
    expect(out.messages[0].role).toBe('user');
  });
});

describe('request shape', () => {
  const msgs = [{ role: 'user', content: 'ping' }];

  it('current models: no temperature, raised max_tokens, fallbacks on', () => {
    const q = defaultAnthropicQuirks('claude-opus-5-5');
    const body = buildAnthropicBody(msgs, { model: 'claude-opus-5-5', temperature: 0, maxTokens: 100 }, q);
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBe(16000);
    expect(body.fallbacks).toBe('default');
    expect(body.system).toBeUndefined();
  });

  it('Haiku 5.5: no temperature, no fallbacks', () => {
    const body = buildAnthropicBody(msgs, { model: 'claude-haiku-5-5', temperature: 0.3, maxTokens: 6000 },
      defaultAnthropicQuirks('claude-haiku-5-5'));
    expect(body.temperature).toBeUndefined();
    expect(body.fallbacks).toBeUndefined();
  });

  it('older models still get temperature', () => {
    for (const id of ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-3-5-sonnet-latest', 'claude-sonnet-4-20250514']) {
      expect(defaultAnthropicQuirks(id).temperature).toBe(true);
    }
    for (const id of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5-5', 'claude-sonnet-5-5']) {
      expect(defaultAnthropicQuirks(id).temperature).toBe(false);
    }
  });
});

describe('extractAnthropicText', () => {
  it('joins text blocks and ignores thinking/fallback blocks', () => {
    const data = { stop_reason: 'end_turn', content: [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: '{"status":' },
      { type: 'text', text: '"ok"}' },
    ] };
    expect(extractAnthropicText(data)).toBe('{"status":"ok"}');
  });

  it('throws on refusal', () => {
    expect(() => extractAnthropicText({ stop_reason: 'refusal', content: [] })).toThrow(/declined/);
  });

  it('throws when max_tokens is hit with no text', () => {
    expect(() => extractAnthropicText({ stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '' }] }))
      .toThrow(/output tokens/);
  });
});

describe('callAI via the anthropic adapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends Anthropic headers and returns the text', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await callAI('anthropic', 'sk-ant-test', [{ role: 'user', content: 'hi' }], { model: 'claude-opus-5-5' });
    expect(out).toBe('hello');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('sk-ant-test');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    expect(init.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(init.headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('drops temperature and retries when a custom model rejects it', async () => {
    const bodies = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if ('temperature' in body) {
        return new Response('{"error":{"message":"temperature is not supported for this model"}}', { status: 400 });
      }
      return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }), { status: 200 });
    }));

    // claude-sonnet-4-6 starts with temperature on; pretend it rejects it.
    const out = await callAI('anthropic', 'k', [{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-6', temperature: 0.2 });
    expect(out).toBe('ok');
    expect(bodies).toHaveLength(2);
    expect(bodies[1].temperature).toBeUndefined();
  });
});
