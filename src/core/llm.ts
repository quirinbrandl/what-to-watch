export class LlmError extends Error {
  /** `who` names the service in messages for the user ("ChatGPT", "Claude"). */
  constructor(public code: string, message: string, public status?: number, public who = 'ChatGPT') {
    super(message);
  }

  get usageLimit(): boolean {
    return this.code === 'subscription_sharing_usage_limit_exceeded' || this.code === 'insufficient_quota' || this.code === 'rate_limit_exceeded' || this.code === 'billing_error';
  }
  get needsSignIn(): boolean {
    return this.status === 401 || this.code === 'signed_out' || this.code === 'session_expired' || this.code === 'subscription_sharing_invalid_user';
  }
  get notEligible(): boolean {
    return this.code === 'subscription_sharing_user_not_eligible';
  }
  get transient(): boolean {
    return this.status === 529 || this.status === 503 || this.status === 502 || this.status === 500 || this.code === 'interrupted' || this.code === 'network' || this.code.endsWith('_unavailable');
  }

  /** Short, credential-free text for the UI. */
  get friendly(): string {
    if (this.code === 'billing_error') return `Your ${this.who} credit balance is too low.`;
    if (this.usageLimit) return `${this.who} usage limit reached.`;
    if (this.needsSignIn) return this.who === 'ChatGPT' ? 'Please sign in again.' : `Your ${this.who} API key was not accepted.`;
    if (this.notEligible) return 'Your ChatGPT plan cannot be used in apps.';
    if (this.code === 'network') return 'No connection.';
    if (this.code === 'model_not_found') return 'That model is not available. Pick another in Settings.';
    if (this.code === 'refusal') return `${this.who} declined this request.`;
    return `${this.who} is not available right now.`;
  }
}

export interface LlmModel {
  slug: string;
  name: string;
}

/** One piece of a user message: text, or an image given by its URL (sent at low detail). */
export type UserPart = { text: string } | { image: string };

export interface RespondOpts {
  model: string;
  /** The instructions (developer / system message). */
  developer: string;
  user: string | UserPart[];
  /** Reasoning effort: "low" | "medium" | "high". */
  effort?: string;
  onProgress?: (chars: number) => void;
  /** Called with all the text so far, as it streams in. */
  onText?: (text: string) => void;
  retries?: number;
}

/** What the engine needs from a model provider: OpenAI ({@link Llm}) or Anthropic (ClaudeLlm in claude.ts). */
export interface LlmClient {
  models(): Promise<LlmModel[]>;
  /** One streamed answer; resolves with its complete text. Failures are {@link LlmError}s. */
  respond(opts: RespondOpts): Promise<string>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Minimal client for the OpenAI Responses API. Works with a ChatGPT-plan
 * access token (Sign in with ChatGPT) or a regular API key; both need
 * `store: false` + `stream: true` here.
 *
 * `fetchFn` must expose a streaming response body (expo/fetch in the app,
 * Node's fetch in the CLI).
 */
export class Llm implements LlmClient {
  private static readonly base = 'https://api.openai.com/v1';
  calls = 0;
  chars = 0;

  constructor(private token: () => Promise<string>, private fetchFn: typeof fetch = fetch) {}

  async models(): Promise<LlmModel[]> {
    let r: Response;
    try {
      r = await this.fetchFn(`${Llm.base}/models`, { headers: { Authorization: `Bearer ${await this.token()}` } });
    } catch (e) {
      if (e instanceof LlmError) throw e;
      throw new LlmError('network', 'connection failed');
    }
    const body = await r.text();
    if (r.status !== 200) throw httpError(r.status, body);
    const j = JSON.parse(body);
    if (Array.isArray(j.models)) {
      // ChatGPT plan: keep the server's order, show only listed models.
      return j.models.filter((m: any) => m && m.visibility === 'list' && typeof m.slug === 'string').map((m: any) => ({ slug: m.slug, name: m.display_name ?? m.slug }));
    }
    // API key: plain model ids; keep general text models, newest first.
    const skip = /audio|realtime|image|tts|transcribe|embedding|moderation|whisper|dall|search|codex|instruct|babbage|davinci|sora|computer/;
    return ((j.data ?? []) as any[])
      .filter((m) => m && typeof m.id === 'string' && !skip.test(m.id))
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
      .map((m) => ({ slug: m.id, name: m.id }));
  }

  /**
   * One streamed response; returns the complete output text. `effort` is the
   * reasoning effort ("low" | "medium" | "high"); models that do not accept
   * it are retried without.
   */
  async respond(opts: RespondOpts): Promise<string> {
    let effort = opts.effort;
    const retries = opts.retries ?? 1;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(opts.model, opts.developer, opts.user, effort, opts.onProgress, opts.onText);
      } catch (e) {
        if (!(e instanceof LlmError)) throw e;
        if (e.status === 400 && effort !== undefined && e.message.toLowerCase().includes('reasoning')) {
          effort = undefined;
          continue;
        }
        if (!e.transient || attempt >= retries) throw e;
        await sleep(2000 + attempt * 3000);
      }
    }
  }

  private async once(model: string, developer: string, user: string | UserPart[], effort: string | undefined, onProgress?: (chars: number) => void, onText?: (text: string) => void): Promise<string> {
    const token = await this.token();
    const ctl = new AbortController();
    // One watchdog for both phases: connecting, then silence between chunks.
    let timer = setTimeout(() => ctl.abort(), 60000);
    const alive = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ctl.abort(), 180000);
    };
    this.calls++;
    try {
      let res: Response;
      try {
        res = await this.fetchFn(`${Llm.base}/responses`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({
            model,
            input: [
              { role: 'developer', content: developer },
              { role: 'user', content: typeof user === 'string' ? user : user.map((p) => ('image' in p ? { type: 'input_image', image_url: p.image, detail: 'low' } : { type: 'input_text', text: p.text })) },
            ],
            store: false,
            stream: true,
            ...(effort ? { reasoning: { effort } } : {}),
          }),
          signal: ctl.signal,
        });
      } catch {
        throw new LlmError('network', 'connection failed');
      }
      if (res.status !== 200) {
        let body = '';
        try {
          body = await res.text();
        } catch {}
        throw httpError(res.status, body);
      }
      const reader = res.body?.getReader();
      if (!reader) throw new LlmError('interrupted', 'no response stream');
      const decoder = new TextDecoder();
      let buf = '';
      let out = '';
      let completed = false;
      const handle = (line: string) => {
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') return;
        let ev: any;
        try {
          ev = JSON.parse(data);
        } catch {
          return;
        }
        switch (ev.type) {
          case 'response.output_text.delta':
            out += ev.delta ?? '';
            onProgress?.(out.length);
            onText?.(out);
            break;
          case 'response.completed':
            completed = true;
            if (!out) out = outputText(ev.response);
            break;
          case 'response.failed': {
            const err = ev.response?.error;
            throw new LlmError(String(err?.code ?? 'unknown_error'), String(err?.message ?? 'failed'));
          }
          case 'response.incomplete':
            throw new LlmError('incomplete', String(ev.response?.incomplete_details?.reason ?? 'incomplete'));
          case 'error':
            throw new LlmError(String(ev.code ?? ev.error?.code ?? 'unknown_error'), String(ev.message ?? ev.error?.message ?? 'error'));
        }
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          alive();
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, '');
            buf = buf.slice(nl + 1);
            handle(line);
          }
        }
        if (buf) handle(buf);
      } catch (e) {
        if (e instanceof LlmError) throw e;
        throw new LlmError('interrupted', 'stream interrupted');
      }
      if (!completed) throw new LlmError('interrupted', 'stream ended early');
      this.chars += out.length;
      return out;
    } finally {
      clearTimeout(timer);
    }
  }
}

function outputText(response: any): string {
  let s = '';
  for (const item of response?.output ?? []) {
    for (const c of item?.content ?? []) if (c?.type === 'output_text') s += c.text ?? '';
  }
  return s;
}

function httpError(status: number, body: string): LlmError {
  let code = `http_${status}`;
  let message = `HTTP ${status}`;
  try {
    const e = JSON.parse(body).error;
    if (e && typeof e === 'object') {
      code = String(e.code ?? e.type ?? code);
      message = String(e.message ?? message);
    } else if (typeof e === 'string') {
      code = e;
    }
  } catch {}
  return new LlmError(code, message, status);
}

/** Pulls the first JSON object out of model output (tolerates code fences and stray prose). */
export function extractJson(text: string): Record<string, any> | undefined {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return undefined;
  try {
    const v = JSON.parse(text.slice(a, b + 1));
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Parses JSON Lines output, skipping anything that is not a JSON object. */
export function extractJsonLines(text: string): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (line.endsWith(',')) line = line.slice(0, -1);
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}
