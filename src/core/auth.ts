import { sha256 } from '@noble/hashes/sha2.js';

import { nowSec } from './models';

/**
 * Where credentials live (Android Keystore / iOS Keychain in the app, an
 * owner-only file for the eval CLI). Values never reach logs or backups.
 */
export interface SecretStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string | null): Promise<void>;
}

/** A one-shot HTTP listener on 127.0.0.1 that receives the OAuth redirect. */
export interface Loopback {
  /**
   * Starts listening on a free port and returns it. The first request to
   * `path` is answered with `okHtml` when its `state` parameter matches and
   * it carries no `error`, otherwise with `failHtml`.
   */
  start(opts: { path: string; state: string; okHtml: string; failHtml: string }): Promise<number>;
  /** Resolves with the query string of the callback request; rejects when stopped first. */
  wait(): Promise<string>;
  stop(): void;
}

export interface AuthPlatform {
  store: SecretStore;
  loopback: Loopback;
  randomBytes(n: number): Uint8Array;
  /**
   * Opens the system browser. Resolve with 'closed' once the user has left
   * the browser again (if the platform can tell), else with 'opened'.
   */
  openBrowser(url: string): Promise<'opened' | 'closed'>;
  fetch?: typeof fetch;
}

/** Development aid: receives the stage and message of low-level failures (never credentials). */
export const authDebug: { log?: (stage: string, message: string) => void } = {};
const debug = (stage: string, e: unknown) => authDebug.log?.(stage, e instanceof Error ? `${e.name}: ${e.message}` : String(e));

export class AuthError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const AUTHORIZE = 'https://auth.openai.com/api/accounts/authorize';
const TOKEN = 'https://auth.openai.com/api/accounts/oauth/token';
const REVOKE_FALLBACK = 'https://auth.openai.com/api/accounts/oauth/revoke';
const DISCOVERY = 'https://auth.openai.com/.well-known/openid-configuration';
const JWKS = 'https://auth.openai.com/.well-known/jwks.json';
const ISSUER = 'https://auth.openai.com';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const RESOURCE = 'https://api.openai.com/v1';
const TERMINAL = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
// Tokens are stored one per key: secure stores limit the size of a value.
const K = { host: 'chatgpt_host_id', client: 'chatgpt_client', meta: 'chatgpt_meta', access: 'chatgpt_access', refresh: 'chatgpt_refresh', id: 'chatgpt_id' };

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    s += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (i + 1 < bytes.length) s += B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (i + 2 < bytes.length) s += B64[c & 63];
  }
  return s;
}

export function b64urlDecode(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error('bad base64');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 255;
    }
  }
  return out.subarray(0, n);
}

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);
const toBig = (b: Uint8Array) => BigInt('0x' + (Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('') || '0'));

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return r;
}

/** RSASSA-PKCS1-v1_5 with SHA-256 (JWT "RS256"). */
export function verifyRs256(signed: Uint8Array, signature: Uint8Array, n: Uint8Array, e: Uint8Array): boolean {
  const mod = toBig(n);
  const k = n[0] === 0 ? n.length - 1 : n.length;
  if (mod === 0n || signature.length !== k) return false;
  const em = modPow(toBig(signature), toBig(e), mod).toString(16).padStart(k * 2, '0');
  const digestInfo = '3031300d060960864801650304020105000420' + Array.from(sha256(signed), (x) => x.toString(16).padStart(2, '0')).join('');
  const pad = k * 2 - digestInfo.length - 6;
  if (pad < 16) return false;
  return em === '0001' + 'f'.repeat(pad) + '00' + digestInfo;
}

function parseJson(s: string | null | undefined): Record<string, any> | undefined {
  if (!s) return undefined;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

function epoch(v: unknown): number | undefined {
  if (typeof v === 'number') return v > 1e11 ? Math.floor(v / 1000) : Math.floor(v);
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return epoch(n);
    const d = Date.parse(v);
    if (!Number.isNaN(d)) return Math.floor(d / 1000);
  }
  return undefined;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function donePage(ok: boolean, returnUrl?: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatToWatch</title></head>' +
    '<body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;' +
    'background:#0b0b0e;color:#f4f1ea;font:17px system-ui,sans-serif;text-align:center">' +
    `<div style="font-size:52px">${ok ? '&#10003;' : '&#10005;'}</div><div>${ok ? 'Signed in' : 'Sign-in was not completed'}</div>` +
    (returnUrl
      ? `<a href="${esc(returnUrl)}" style="padding:14px 26px;border-radius:999px;background:#f4f1ea;color:#0b0b0e;text-decoration:none;font-weight:600">Back to WhatToWatch</a>` +
        `<script>setTimeout(function(){location.href=${JSON.stringify(returnUrl)}},120)</script>`
      : '<div style="opacity:.6">You can close this tab.</div>') +
    '</body></html>'
  );
}

interface Meta {
  email?: string;
  subject: string;
  client_id: string;
  ext_agent_host_id: string;
  expires_at: number;
  earliest_refresh_at?: number;
  scopes: string[];
  saved_at: number;
}

/**
 * "Sign in with ChatGPT" for open-source apps: OAuth 2 authorization code
 * with PKCE on a loopback redirect, dynamic client registration on first
 * sign-in, rotating refresh tokens.
 * https://developers.openai.com/siwc/token-sharing-open-source
 */
export class ChatGptAuth {
  private meta?: Meta;
  private access?: string;
  private refresh?: string;
  private idToken?: string;
  private client?: { client_id: string; subject?: string; email?: string }; // survives sign-out
  private pending = false;
  private cancelPending?: () => void;
  private refreshing?: Promise<string>;
  private fetchFn: typeof fetch;

  constructor(private p: AuthPlatform, private appName = 'WhatToWatch') {
    this.fetchFn = p.fetch ?? fetch;
  }

  get signedIn(): boolean {
    return !!this.meta && !!this.refresh;
  }
  get email(): string | undefined {
    return this.meta?.email;
  }
  get signingIn(): boolean {
    return this.pending;
  }

  async load(): Promise<void> {
    const s = this.p.store;
    const [meta, access, refresh, id, client] = await Promise.all([s.read(K.meta), s.read(K.access), s.read(K.refresh), s.read(K.id), s.read(K.client)]);
    this.meta = parseJson(meta) as Meta | undefined;
    this.access = access ?? undefined;
    this.refresh = refresh ?? undefined;
    this.idToken = id ?? undefined;
    this.client = parseJson(client) as any;
    if (!this.meta || !this.refresh) this.meta = undefined;
  }

  private random(bytes: number): string {
    return b64urlEncode(this.p.randomBytes(bytes));
  }

  private uuid(): string {
    const b = this.p.randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  /**
   * Retries on network errors only. Right after the browser hands back to
   * the app, the app may still be in the background, where requests can
   * fail for a moment; the authorization code stays valid meanwhile.
   */
  private async retrying<T>(job: () => Promise<T>, tries = 4): Promise<T> {
    for (let i = 1; ; i++) {
      try {
        return await job();
      } catch (e) {
        if (i >= tries) throw e;
        await new Promise((r) => setTimeout(r, 900 * i));
      }
    }
  }

  private async form(url: string, params: Record<string, string>, timeoutMs = 30000): Promise<{ status: number; json?: Record<string, any> }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(params).toString(),
        signal: ctl.signal,
      });
      return { status: r.status, json: parseJson(await r.text()) };
    } finally {
      clearTimeout(timer);
    }
  }

  private async getJson(url: string, timeoutMs = 15000): Promise<Record<string, any> | undefined> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return parseJson(await (await this.fetchFn(url, { signal: ctl.signal })).text());
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Runs the browser sign-in. `returnUrl` is an app link the "done" page
   * jumps to, which brings the app back to the foreground.
   */
  async signIn(opts: { returnUrl?: string; timeoutMs?: number } = {}): Promise<void> {
    this.cancelSignIn();
    const store = this.p.store;
    let hostId = await store.read(K.host);
    if (!hostId) {
      hostId = `urn:uuid:${this.uuid()}`;
      await store.write(K.host, hostId);
    }
    const savedClient = this.client?.client_id;
    const state = this.random(24);
    const nonce = this.random(24);
    const verifier = this.random(48);
    const challenge = b64urlEncode(sha256(ascii(verifier)));

    this.pending = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const port = await this.p.loopback.start({ path: '/auth/callback', state, okHtml: donePage(true, opts.returnUrl), failHtml: donePage(false, opts.returnUrl) });
      const redirect = `http://127.0.0.1:${port}/auth/callback`;
      const callback = this.p.loopback.wait();
      callback.catch(() => {});
      const params: Record<string, string> = {
        client_id: savedClient ?? 'dynamic_agent_client',
        ext_agent_host_id: hostId,
        response_type: 'code',
        redirect_uri: redirect,
        scope: SCOPE,
        resource: RESOURCE,
        state,
        nonce,
        code_challenge_method: 'S256',
        code_challenge: challenge,
      };
      if (!savedClient) params.agent_name_hint = this.appName;
      const cancelled = new AuthError('access_denied', 'Sign-in was cancelled.');
      const others = new Promise<never>((_, reject) => {
        this.cancelPending = () => reject(cancelled);
        timer = setTimeout(() => reject(new AuthError('timeout', 'Sign-in timed out.')), opts.timeoutMs ?? 600000);
        // Leaving the browser without finishing counts as cancelling; the
        // short grace period lets a callback that is just arriving win.
        this.p.openBrowser(`${AUTHORIZE}?${new URLSearchParams(params).toString()}`).then(
          (r) => r === 'closed' && setTimeout(() => reject(cancelled), 2500),
          () => reject(new AuthError('browser', 'Could not open the browser.')),
        );
      });
      const query = await Promise.race([callback.catch(() => Promise.reject(cancelled)), others]);
      const q = new URLSearchParams(query);
      if (q.get('state') !== state) throw new AuthError('state', 'Sign-in could not be verified. Please try again.');
      const error = q.get('error');
      if (error) {
        if (error === 'access_denied') throw cancelled;
        // A stale registration can cause this; register afresh next time.
        this.client = undefined;
        await store.write(K.client, null);
        throw new AuthError(error, 'ChatGPT sign-in failed. Please try again.');
      }
      const code = q.get('code');
      const issued = q.get('client_id');
      if (!code) throw new AuthError('no_code', 'Sign-in returned no authorization code.');
      if (!savedClient && !issued) throw new AuthError('registration', 'Registration was incomplete. Please try again.');
      if (savedClient && issued && issued !== savedClient) throw new AuthError('client', 'Sign-in returned an unexpected client.');
      const clientId = savedClient ?? issued!;

      let res: { status: number; json?: Record<string, any> };
      try {
        res = await this.retrying(() => this.form(TOKEN, { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect, resource: RESOURCE }));
      } catch (e) {
        debug('token', e);
        throw new AuthError('network', 'Could not reach ChatGPT. Check your connection.');
      }
      const t = res.json;
      if (res.status !== 200 || !t) throw new AuthError(String(t?.error ?? 'token'), `ChatGPT did not complete the sign-in (${res.status}).`);
      const idToken = t.id_token as string | undefined;
      if (!idToken) throw new AuthError('id_token', 'Sign-in returned no identity.');
      const claims = await this.validateIdToken(idToken, clientId, nonce);
      const scopes = String(t.scope ?? q.get('scope') ?? '').split(/[ +]/).filter(Boolean);
      if (!scopes.includes('chatgpt.tokens.use.direct')) throw new AuthError('scope', 'ChatGPT did not grant plan usage to this app.');
      if (savedClient && this.client?.subject && this.client.subject !== claims.sub) {
        this.client = undefined;
        await store.write(K.client, null);
        throw new AuthError('account', 'That is a different ChatGPT account. Please sign in again.');
      }
      this.client = { client_id: clientId, subject: claims.sub, email: claims.email };
      await store.write(K.client, JSON.stringify(this.client));
      await this.saveTokens(t, { email: claims.email, subject: claims.sub, client_id: clientId, ext_agent_host_id: hostId, scopes });
    } finally {
      if (timer) clearTimeout(timer);
      this.pending = false;
      this.cancelPending = undefined;
      // Let the "done" page finish sending before the listener goes away.
      setTimeout(() => !this.pending && this.p.loopback.stop(), 2000);
    }
  }

  cancelSignIn(): void {
    this.cancelPending?.();
  }

  private async saveTokens(t: Record<string, any>, base?: Partial<Meta>): Promise<void> {
    const now = nowSec();
    const refresh = (t.refresh_token as string | undefined) ?? this.refresh;
    const access = t.access_token as string | undefined;
    if (!access || !refresh) throw new AuthError('token', 'ChatGPT returned an incomplete session.');
    const meta = {
      ...(this.meta ?? {}),
      ...(base ?? {}),
      expires_at: now + (typeof t.expires_in === 'number' ? Math.floor(t.expires_in) : 3600),
      earliest_refresh_at: epoch(t.earliest_refresh_at),
      saved_at: now,
    } as Meta;
    if (typeof t.scope === 'string') meta.scopes = t.scope.split(' ').filter(Boolean);
    const s = this.p.store;
    // Refresh tokens rotate: persist the replacement before anything else.
    await s.write(K.refresh, refresh);
    await s.write(K.access, access);
    if (t.id_token) await s.write(K.id, t.id_token);
    await s.write(K.meta, JSON.stringify(meta));
    this.refresh = refresh;
    this.access = access;
    if (t.id_token) this.idToken = t.id_token;
    this.meta = meta;
  }

  /**
   * A valid access token, refreshed when it is about to expire. Refreshes
   * are serialised so the rotating refresh token is never raced.
   */
  accessToken(): Promise<string> {
    const m = this.meta;
    if (!m || !this.access || !this.refresh) return Promise.reject(new AuthError('signed_out', 'Sign in with ChatGPT to continue.'));
    const now = nowSec();
    if (now < m.expires_at - 90) return Promise.resolve(this.access);
    if (m.earliest_refresh_at !== undefined && now < m.earliest_refresh_at && now < m.expires_at - 5) return Promise.resolve(this.access);
    return (this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = undefined)));
  }

  private async doRefresh(): Promise<string> {
    let res: { status: number; json?: Record<string, any> };
    try {
      res = await this.form(TOKEN, { grant_type: 'refresh_token', client_id: this.meta!.client_id, refresh_token: this.refresh!, resource: RESOURCE });
    } catch (e) {
      debug('refresh', e);
      throw new AuthError('network', 'Could not reach ChatGPT. Check your connection.');
    }
    const t = res.json;
    if (res.status === 200 && t) {
      await this.saveTokens(t);
      return this.access!;
    }
    const err = String(t?.error && typeof t.error === 'object' ? t.error.code : t?.error);
    if (TERMINAL.has(err) || res.status === 401) {
      await this.clearTokens();
      throw new AuthError('session_expired', 'Your ChatGPT session ended. Please sign in again.');
    }
    throw new AuthError('refresh', `ChatGPT is not reachable right now (${res.status}).`);
  }

  private async clearTokens(): Promise<void> {
    this.meta = undefined;
    this.access = undefined;
    this.refresh = undefined;
    this.idToken = undefined;
    for (const k of [K.meta, K.access, K.refresh, K.id]) await this.p.store.write(k, null);
  }

  /**
   * Revokes the session and clears local tokens. Returns false when remote
   * revocation could not be confirmed (tokens are cleared regardless).
   */
  async signOut(): Promise<boolean> {
    if (!this.meta || !this.refresh) return true;
    let confirmed = false;
    let endpoint = REVOKE_FALLBACK;
    try {
      const e = (await this.getJson(DISCOVERY, 10000))?.revocation_endpoint;
      if (typeof e === 'string' && e.startsWith('https://auth.openai.com/')) endpoint = e;
    } catch {}
    for (let i = 0; i < 3 && !confirmed; i++) {
      try {
        const r = await this.form(endpoint, { token: this.refresh, token_type_hint: 'refresh_token', client_id: this.meta.client_id }, 15000);
        if (r.status === 200) confirmed = true;
        if (r.status < 500) break;
      } catch {}
      if (!confirmed) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
    await this.clearTokens();
    return confirmed;
  }

  /** Forget everything, including the registration and host id. */
  async wipe(): Promise<void> {
    await this.clearTokens();
    this.client = undefined;
    await this.p.store.write(K.client, null);
    await this.p.store.write(K.host, null);
  }

  // ---- ID token (RS256 against OpenAI's JWKS)

  private async validateIdToken(jwt: string, clientId: string, nonce: string): Promise<Record<string, any>> {
    const bad = new AuthError('id_token', 'ChatGPT identity could not be verified.');
    const parts = jwt.split('.');
    if (parts.length !== 3) throw bad;
    let header: Record<string, any> | undefined;
    let claims: Record<string, any> | undefined;
    let signature: Uint8Array;
    try {
      header = parseJson(utf8(b64urlDecode(parts[0])));
      claims = parseJson(utf8(b64urlDecode(parts[1])));
      signature = b64urlDecode(parts[2]);
    } catch {
      throw bad;
    }
    if (!header || !claims || header.alg !== 'RS256') throw bad;
    let keys: Record<string, any>[] = [];
    try {
      keys = ((await this.retrying(() => this.getJson(JWKS)))?.keys ?? []) as Record<string, any>[];
    } catch (e) {
      debug('jwks', e);
      throw new AuthError('network', 'Could not reach ChatGPT. Check your connection.');
    }
    const key = keys.find((k) => k.kty === 'RSA' && (header!.kid === undefined || k.kid === header!.kid));
    if (!key) throw bad;
    let valid = false;
    try {
      valid = verifyRs256(ascii(`${parts[0]}.${parts[1]}`), signature, b64urlDecode(key.n), b64urlDecode(key.e));
    } catch {}
    const aud = claims.aud;
    if (
      !valid ||
      claims.iss !== ISSUER ||
      !(aud === clientId || (Array.isArray(aud) && aud.includes(clientId))) ||
      Number(claims.exp ?? 0) < nowSec() - 120 ||
      claims.nonce !== nonce ||
      typeof claims.sub !== 'string'
    ) {
      throw bad;
    }
    return claims;
  }
}
