import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseOpenAIModels } from '../../aiService.js';

describe('parseOpenAIModels', () => {
  it('keeps gpt-, o\\d, and chatgpt- prefixed ids', () => {
    const json = {
      data: [
        { id: 'gpt-4.1' },
        { id: 'gpt-4o' },
        { id: 'o3-mini' },
        { id: 'o4-mini' },
        { id: 'chatgpt-4o-latest' },
      ],
    };
    const out = parseOpenAIModels(json);
    expect(out.map(m => m.id)).toEqual([
      'gpt-4.1', 'gpt-4o', 'o3-mini', 'o4-mini', 'chatgpt-4o-latest',
    ]);
    expect(out.every(m => m.name === m.id)).toBe(true);
  });

  it('drops embeddings, image-gen, audio, moderation, fine-tunes', () => {
    const json = {
      data: [
        { id: 'gpt-4o' },
        { id: 'text-embedding-3-large' },
        { id: 'text-embedding-ada-002' },
        { id: 'dall-e-3' },
        { id: 'whisper-1' },
        { id: 'tts-1-hd' },
        { id: 'omni-moderation-latest' },
        { id: 'babbage-002' },
        { id: 'davinci-002' },
        { id: 'ft:gpt-3.5-turbo:org::abc' },
      ],
    };
    expect(parseOpenAIModels(json).map(m => m.id)).toEqual(['gpt-4o']);
  });

  it('drops non-chat-completion gpt-* variants (realtime, audio, transcribe, tts, image, search)', () => {
    const json = {
      data: [
        { id: 'gpt-4o' },                       // keep — vanilla chat
        { id: 'gpt-4o-realtime-preview' },      // drop — WebSocket-only
        { id: 'gpt-realtime' },                 // drop — WebSocket-only
        { id: 'gpt-4o-audio-preview' },         // drop — audio I/O
        { id: 'gpt-4o-transcribe' },            // drop — speech-to-text
        { id: 'gpt-4o-mini-transcribe' },       // drop — speech-to-text
        { id: 'gpt-4o-mini-tts' },              // drop — text-to-speech
        { id: 'gpt-image-1' },                  // drop — image generation
        { id: 'gpt-4o-search-preview' },        // drop — web-search endpoint
      ],
    };
    expect(parseOpenAIModels(json).map(m => m.id)).toEqual(['gpt-4o']);
  });

  it('returns [] for empty data', () => {
    expect(parseOpenAIModels({ data: [] })).toEqual([]);
    expect(parseOpenAIModels({})).toEqual([]);
  });

  it('returns [] for non-array data (defensive)', () => {
    expect(parseOpenAIModels({ data: 'oops' })).toEqual([]);
    expect(parseOpenAIModels({ data: null })).toEqual([]);
    expect(parseOpenAIModels(null)).toEqual([]);
  });

  it('uses id as name (OpenAI has no display_name)', () => {
    const json = { data: [{ id: 'gpt-4.1-mini' }] };
    expect(parseOpenAIModels(json)).toEqual([
      { id: 'gpt-4.1-mini', name: 'gpt-4.1-mini' },
    ]);
  });
});

import { PROVIDERS, listProviderModels } from '../../aiService.js';

describe('curated-list parser sanity', () => {
  // Build a synthetic API response containing exactly OpenAI's curated
  // model IDs, then assert the parser keeps all of them. If the parser
  // drops a curated id, the filter regex/predicate is too tight.

  it('OpenAI parser keeps every curated id', () => {
    const ids = PROVIDERS.openai.models.map(m => m.id);
    const json = { data: ids.map(id => ({ id })) };
    expect(parseOpenAIModels(json).map(m => m.id).sort()).toEqual(ids.slice().sort());
  });
});

describe('listProviderModels', () => {
  // Save the real listModels function so any test that mutates it can be
  // restored by afterEach — survives crashes and test-runner aborts that
  // would skip a try/finally.
  let originalOpenAIListModels;
  beforeEach(() => {
    originalOpenAIListModels = PROVIDERS.openai.listModels;
  });
  afterEach(() => {
    PROVIDERS.openai.listModels = originalOpenAIListModels;
  });

  it('throws for an unknown provider', async () => {
    await expect(listProviderModels('not-a-real-provider', 'k')).rejects.toThrow(/Unknown provider/);
  });

  it('throws when a provider has no listModels function', async () => {
    delete PROVIDERS.openai.listModels;
    await expect(listProviderModels('openai', 'k')).rejects.toThrow(/does not support model listing yet/);
  });

  it('delegates to the provider listModels and returns its result', async () => {
    PROVIDERS.openai.listModels = async () => [{ id: 'fake-model', name: 'Fake Model' }];
    const out = await listProviderModels('openai', 'k');
    expect(out).toEqual([{ id: 'fake-model', name: 'Fake Model' }]);
  });
});
