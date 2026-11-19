import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ClaudeLlm } from '../claude';
import { LlmError } from '../llm';

const yes = { supported: true };
const no = { supported: false };

function model(id: string, o: { effort?: boolean; fallback?: boolean; maxTokens?: number; lifecycle?: string } = {}) {
  const effort = o.effort ?? true;
  return {
    id,
    type: 'model',
    display_name: id.replace('claude-', 'Claude '),
    created_at: '2026-01-01T00:00:00Z',
    lifecycle: o.lifecycle ?? 'active',
    max_tokens: o.maxTokens ?? 128000,
    max_input_tokens: 1000000,
    allowed_fallback_models: o.fallback ? ['claude-opus-5'] : [],
    capabilities: { effort: { supported: effort, low: effort ? yes : no, medium: effort ? yes : no, high: effort ? yes : no, max: no } },
  };
}

const MODELS = [
  model('claude-fable-5-2', { fallback: true }),
  model('claude-opus-5-5', { fallback: true }),
  model('claude-haiku-4-5', { effort: false, maxTokens: 32000 }),
  model('claude-3-old', { lifecycle: 'retired' }),
];

function sse(events: Record<string, unknown>[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

function answer(chunks: string[], stop = 'end_turn'): string {
  return sse([
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...chunks.map((text) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]);
}

interface Sent {
  url: string;
  headers: Headers;
  body?: any;
}

/** A stand-in for api.anthropic.com: the models list, then `reply` for every message request. */
function server(reply: () => Response) {
  const sent: Sent[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    sent.push({ url, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('/v1/models')) return Response.json({ data: MODELS, has_more: false, first_id: null, last_id: null });
    return reply();
  }) as typeof fetch;
  return { fetchFn, sent, messages: () => sent.filter((s) => s.url.includes('/v1/messages')) };
}

const streamOf = (body: string) => () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
const errorOf = (status: number, type: string) => () => Response.json({ type: 'error', error: { type, message: `${type} happened` } }, { status });

describe('ClaudeLlm', () => {
  test('lists usable models with Claude Opus 5.5 first', async () => {
    const s = server(streamOf(answer(['x'])));
    const list = await new ClaudeLlm(() => 'sk-ant-test', s.fetchFn).models();
    assert.deepEqual(
      list.map((m) => m.slug),
      ['claude-opus-5-5', 'claude-fable-5-2', 'claude-haiku-4-5'],
    );
    // The SDK sends the key as a bearer token.
    assert.equal(s.sent[0].headers.get('authorization'), 'Bearer sk-ant-test');
  });

  test('streams the answer, sends instructions as the system prompt and images by URL', async () => {
    const s = server(streamOf(answer(['{"a":', '1}'])));
    const seen: string[] = [];
    const text = await new ClaudeLlm(() => 'k', s.fetchFn).respond({
      model: 'claude-opus-5-5',
      developer: 'You pick films.',
      user: [{ text: 'Film 1' }, { image: 'https://image.tmdb.org/t/p/w300/a.jpg' }],
      effort: 'low',
      onText: (t) => seen.push(t),
    });
    assert.equal(text, '{"a":1}');
    assert.deepEqual(seen, ['{"a":', '{"a":1}']);
    const body = s.messages()[0].body;
    assert.equal(body.system, 'You pick films.');
    assert.equal(body.stream, true);
    assert.deepEqual(body.messages, [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Film 1' },
          { type: 'image', source: { type: 'url', url: 'https://image.tmdb.org/t/p/w300/a.jpg' } },
        ],
      },
    ]);
    assert.deepEqual(body.output_config, { effort: 'low' });
    assert.equal(body.max_tokens, 64000);
    // Opus 5.5 offers refusal fallbacks: opted in with the beta header.
    assert.equal(body.fallbacks, 'default');
    assert.match(s.messages()[0].headers.get('anthropic-beta') ?? '', /server-side-fallback-2026-07-01/);
  });

  test('leaves out what a model does not accept', async () => {
    const s = server(streamOf(answer(['ok'])));
    await new ClaudeLlm(() => 'k', s.fetchFn).respond({ model: 'claude-haiku-4-5', developer: 'd', user: 'u', effort: 'low' });
    const body = s.messages()[0].body;
    assert.equal(body.output_config, undefined);
    assert.equal(body.fallbacks, undefined);
    assert.equal(body.max_tokens, 32000);
    assert.equal(body.messages[0].content, 'u');
  });

  test('a cut-off or declined answer is an error, not a result', async () => {
    const cut = server(streamOf(answer(['half'], 'max_tokens')));
    await assert.rejects(new ClaudeLlm(() => 'k', cut.fetchFn).respond({ model: 'claude-opus-5-5', developer: 'd', user: 'u' }), (e: LlmError) => e.code === 'incomplete');
    const no = server(streamOf(answer([], 'refusal')));
    await assert.rejects(new ClaudeLlm(() => 'k', no.fetchFn).respond({ model: 'claude-opus-5-5', developer: 'd', user: 'u' }), (e: LlmError) => e.code === 'refusal' && e.friendly === 'Claude declined this request.');
  });

  test('maps API errors onto what the app handles', async () => {
    const ask = async (reply: () => Response) => {
      try {
        await new ClaudeLlm(() => 'k', server(reply).fetchFn).respond({ model: 'claude-opus-5-5', developer: 'd', user: 'u', retries: 0 });
      } catch (e) {
        return e as LlmError;
      }
      throw new Error('no error');
    };
    const bad = await ask(errorOf(401, 'authentication_error'));
    assert.ok(bad instanceof LlmError && bad.needsSignIn);
    assert.equal(bad.friendly, 'Your Claude API key was not accepted.');
    const broke = await ask(errorOf(402, 'billing_error'));
    assert.ok(broke.usageLimit);
    assert.equal(broke.friendly, 'Your Claude credit balance is too low.');
    assert.ok((await ask(errorOf(429, 'rate_limit_error'))).usageLimit);
    const busy = await ask(errorOf(529, 'overloaded_error'));
    assert.ok(busy.transient);
    assert.equal(busy.friendly, 'Claude is not available right now.');
    assert.equal((await ask(errorOf(404, 'not_found_error'))).code, 'model_not_found');
    const midStream = await ask(streamOf(sse([{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])));
    assert.ok(midStream.transient);
  });

  test('no key means signed out, without a request', async () => {
    const s = server(streamOf(answer(['x'])));
    await assert.rejects(new ClaudeLlm(() => undefined, s.fetchFn).respond({ model: 'claude-opus-5-5', developer: 'd', user: 'u' }), (e: LlmError) => e.needsSignIn);
    assert.equal(s.sent.length, 0);
  });
});
