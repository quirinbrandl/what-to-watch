import type Anthropic from '@anthropic-ai/sdk';

import { LlmClient, LlmError, LlmModel, RespondOpts, UserPart } from './llm';

// Loaded with require(), not import, so that Metro takes the SDK's CommonJS
// build. Its ES-module build has import cycles that crash the app in
// development: React Refresh reads every export of a module as soon as it
// has run, before the other half of the cycle exists.
const SDK = require('@anthropic-ai/sdk') as typeof import('@anthropic-ai/sdk');
const Client = SDK.Anthropic;

const WHO = 'Claude';
/** What "Automatic" uses when the account has it. */
export const CLAUDE_DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_OUT = 64000;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

type ModelInfo = Anthropic.Beta.BetaModelInfo;

/**
 * Claude through the Anthropic API with the user's own API key. Same
 * contract as the OpenAI client: one streamed answer per call.
 *
 * What each model accepts (effort levels, output size, refusal fallbacks)
 * comes from the Models API, so any model the account lists can be picked.
 */
export class ClaudeLlm implements LlmClient {
  private client?: Anthropic;
  private clientKey?: string;
  private info = new Map<string, ModelInfo>();

  constructor(private key: () => string | undefined, private fetchFn?: typeof fetch) {}

  private api(): Anthropic {
    const key = this.key();
    if (!key) throw new LlmError('signed_out', 'no key', undefined, WHO);
    if (!this.client || this.clientKey !== key) {
      this.client = new Client({
        apiKey: key,
        // The key is the user's own and stays on their device; the SDK's
        // browser guard is about shipping a developer's key to the public.
        dangerouslyAllowBrowser: true,
        ...(this.fetchFn ? { fetch: this.fetchFn } : {}),
      });
      this.clientKey = key;
      this.info.clear();
    }
    return this.client;
  }

  async models(): Promise<LlmModel[]> {
    const api = this.api();
    const list: ModelInfo[] = [];
    try {
      for await (const m of api.beta.models.list({ limit: 100 })) if (m.lifecycle !== 'retired') list.push(m);
    } catch (e) {
      throw claudeError(e);
    }
    this.info = new Map(list.map((m) => [m.id, m]));
    // "Automatic" takes the first: the default model, then the API's order (newest first).
    list.sort((a, b) => Number(b.id === CLAUDE_DEFAULT_MODEL) - Number(a.id === CLAUDE_DEFAULT_MODEL));
    return list.map((m) => ({ slug: m.id, name: m.display_name || m.id }));
  }

  async respond(opts: RespondOpts): Promise<string> {
    const api = this.api();
    if (!this.info.size) await this.models().catch(() => []);
    const info = this.info.get(opts.model);
    const levels = info?.capabilities?.effort as unknown as Record<string, { supported?: boolean } | undefined> | undefined;
    // Unknown model details: send the effort and let the API decide.
    const effort = opts.effort && (!levels || levels[opts.effort]?.supported) ? (opts.effort as Anthropic.Beta.BetaOutputConfig['effort']) : undefined;
    // Server-side fallback re-runs a declined request on another model, for models that offer it.
    const fallback = (info?.allowed_fallback_models?.length ?? 0) > 0;

    // One watchdog for both phases: connecting, then silence between events.
    const ctl = new AbortController();
    let timer = setTimeout(() => ctl.abort(), 60000);
    const alive = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ctl.abort(), 180000);
    };
    let out = '';
    try {
      const stream = api.beta.messages.stream(
        {
          model: opts.model,
          max_tokens: Math.min(MAX_OUT, info?.max_tokens ?? MAX_OUT),
          system: opts.developer,
          messages: [{ role: 'user', content: userContent(opts.user) }],
          ...(effort ? { output_config: { effort } } : {}),
          ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
        },
        // The SDK retries connection errors, 429 and 5xx before the stream opens.
        { signal: ctl.signal, maxRetries: opts.retries ?? 1 },
      );
      stream.on('streamEvent', alive);
      stream.on('text', (delta) => {
        out += delta;
        opts.onProgress?.(out.length);
        opts.onText?.(out);
      });
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'refusal') throw new LlmError('refusal', 'the request was declined', undefined, WHO);
      if (msg.stop_reason === 'max_tokens') throw new LlmError('incomplete', 'max_tokens', undefined, WHO);
      let text = '';
      for (const b of msg.content) if (b.type === 'text') text += b.text;
      return text || out;
    } catch (e) {
      throw claudeError(e);
    } finally {
      clearTimeout(timer);
    }
  }
}

function userContent(user: string | UserPart[]): string | Anthropic.Beta.BetaContentBlockParam[] {
  if (typeof user === 'string') return user;
  return user.map((p): Anthropic.Beta.BetaContentBlockParam => ('image' in p ? { type: 'image', source: { type: 'url', url: p.image } } : { type: 'text', text: p.text }));
}

/** Maps SDK errors onto the codes the app already handles. Messages never contain the key. */
function claudeError(e: unknown): LlmError {
  if (e instanceof LlmError) return e;
  // Abort and connection errors are subclasses of APIError: check them first.
  if (e instanceof Client.APIUserAbortError) return new LlmError('interrupted', 'stream stalled', undefined, WHO);
  if (e instanceof Client.APIConnectionError) return new LlmError('network', 'connection failed', undefined, WHO);
  if (e instanceof Client.AuthenticationError) return new LlmError('invalid_api_key', e.message, 401, WHO);
  if (e instanceof Client.NotFoundError) return new LlmError('model_not_found', e.message, 404, WHO);
  if (e instanceof Client.RateLimitError) return new LlmError('rate_limit_exceeded', e.message, 429, WHO);
  if (e instanceof Client.InternalServerError) return new LlmError('claude_unavailable', e.message, e.status, WHO);
  if (e instanceof Client.APIError) {
    // Errors inside an open stream carry no HTTP status, only the error type.
    const type = e.type ?? (e.error as { error?: { type?: string } } | undefined)?.error?.type;
    // An empty credit balance comes back as a plain 400 invalid_request_error; only its message tells it apart.
    const broke = type === 'billing_error' || (type === 'invalid_request_error' && /credit balance/i.test(e.message));
    const code = type === 'overloaded_error' || type === 'api_error' ? 'claude_unavailable' : broke ? 'billing_error' : String(type ?? `http_${e.status}`);
    return new LlmError(code, e.message, e.status ?? undefined, WHO);
  }
  return new LlmError('interrupted', 'stream interrupted', undefined, WHO);
}
