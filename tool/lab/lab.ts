// The engine lab: data, a cached LLM client that records token use, the test
// protocol and scoring. See tool/lab/README.md.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { AuthError, ChatGptAuth } from '../../src/core/auth';
import { matchTitle } from '../../src/core/letterboxd';
import { Llm, LlmError } from '../../src/core/llm';
import { Film, Library } from '../../src/core/models';
import { FilmCache, Tmdb } from '../../src/core/tmdb';
import { readJson, writeJson } from '../eval-common';
import { platform } from '../eval-llm';
import { LAB, Panel, PanelUser } from './panel';

export const PICKS = 24; // recommendations scored per user
export const LOVED = 4; // hidden film rated >= 4 stars: +1
export const DISLIKED = 3; // hidden film rated < 3 stars: -1
const HIDDEN_SHARE = 0.3; // share of each person's rated films that the panel hides

/**
 * What fame alone is worth. A famous film is more likely to be among anyone's hidden films, so it
 * collects hits without any knowledge of the person. From the MovieLens users of the same kind as the
 * panel we know, for every film, what share of people rated it; `expected` is the score a film of that
 * fame and of average appeal for its fame would bring. "Beyond fame" = score − sum of `expected`.
 */
export class Fame {
  private static readonly BOUNDS = [0.5, 0.3, 0.2, 0.1, 0.05, 0.02, 0.01, 0.004, 0];
  private films: Record<string, [number, number, number]> = {};
  private users = 1;
  private meanRatings = 1;
  private appeal: number[] = []; // per fame bucket: (loved − disliked) per rating

  constructor() {
    const s = readJson(`${LAB}/mlstats.json`);
    if (!s) return;
    this.films = s.films;
    this.users = s.users;
    this.meanRatings = s.meanRatings;
    const n = Fame.BOUNDS.map(() => 0);
    const g = Fame.BOUNDS.map(() => 0);
    for (const st of Object.values(this.films)) {
      const b = this.bucket(st[0] / this.users);
      n[b] += st[0];
      g[b] += st[1] - st[2];
    }
    this.appeal = n.map((x, i) => (x ? g[i] / x : 0));
  }

  private bucket(share: number): number {
    return Fame.BOUNDS.findIndex((x) => share >= x);
  }

  /** Share of comparable MovieLens users who rated the film. */
  share(id: number): number {
    return (this.films[id]?.[0] ?? 0) / this.users;
  }

  /** Expected score of recommending this film to a person with `rated` rated films, from fame alone. */
  expected(id: number, rated: number): number {
    const share = this.share(id);
    if (share <= 0) return 0;
    const p = Math.min(0.95, (share * rated) / this.meanRatings);
    return ((HIDDEN_SHARE * p) / (1 - (1 - HIDDEN_SHARE) * p)) * this.appeal[this.bucket(share)];
  }
}

// ------------------------------------------------------------------ data

export class Data {
  films = new FilmCache();
  fame = new Fame();
  tmdb: Tmdb;
  private match: Record<string, number | null>;
  private gone: Set<number>;
  private lists: Record<string, number[]>;
  private dirty = false;

  private constructor(readonly panel: Panel) {
    this.films.load(readJson(`${LAB}/films.json`));
    this.tmdb = new Tmdb(this.films);
    this.match = readJson(`${LAB}/match.json`) ?? {};
    this.gone = new Set(readJson(`${LAB}/gone.json`) ?? []);
    this.lists = readJson(`${LAB}/lists.json`) ?? {};
  }

  static load(): Data {
    const panel = readJson(`${LAB}/panel.json`) as Panel | undefined;
    if (!panel) throw new Error('No panel. Run: npx tsx tool/lab/panel.ts');
    return new Data(panel);
  }

  /** 'dev' (40), 'test' (80), 'spare' (80), or a number n = the first n dev users. */
  users(set: string): PanelUser[] {
    const by = new Map(this.panel.users.map((u) => [u.id, u]));
    const n = parseInt(set, 10);
    const ids = Number.isFinite(n) ? this.panel.dev.slice(0, n) : ((this.panel as any)[set] as string[] | undefined);
    if (!ids) throw new Error(`unknown user set "${set}"`);
    return ids.map((id) => by.get(id)!);
  }

  /** Full TMDB records for these films (fetched once, then served from disk). */
  async ensureFilms(ids: Iterable<number>): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => this.films.get(id)?.full !== true && !this.gone.has(id));
    if (!missing.length) return;
    console.error(`Fetching TMDB details for ${missing.length} films…`);
    for (let i = 0; i < missing.length; i += 400) {
      const part = missing.slice(i, i + 400);
      await this.tmdb.detailsAll(part, 'DE', { providerMaxAgeDays: 9999 });
      for (const id of part) if (this.films.get(id)?.full !== true) this.gone.add(id);
      this.dirty = true;
      this.save();
      console.error(`  ${Math.min(i + 400, missing.length)}/${missing.length}`);
    }
  }

  /** A title the LLM wrote -> a real TMDB film, or undefined. Cached on disk. */
  async resolve(title: string, year?: number): Promise<Film | undefined> {
    const key = `${title.trim().toLowerCase()}|${year ?? ''}`;
    if (key in this.match) {
      const id = this.match[key];
      const f = id === null ? undefined : this.films.get(id);
      if (id === null || f) return f;
    }
    let f: Film | undefined;
    try {
      f = await matchTitle(this.tmdb, title, year);
    } catch {
      return undefined; // network trouble: do not cache
    }
    this.match[key] = f?.id ?? null;
    this.dirty = true;
    return f;
  }

  /** A fixed TMDB discover list (e.g. most voted films), fetched once. */
  async list(name: string, query: Record<string, string>, pages: number): Promise<Film[]> {
    if (!this.lists[name] || this.lists[name].some((id) => !this.films.get(id))) {
      const out: number[] = [];
      for (let p = 1; p <= pages; p++) for (const f of await this.tmdb.discover(query, p)) if (!out.includes(f.id)) out.push(f.id);
      this.lists[name] = out;
      this.dirty = true;
    }
    return this.lists[name].map((id) => this.films.get(id)!).filter(Boolean);
  }

  touch(): void {
    this.dirty = true;
  }

  save(): void {
    if (!this.dirty) return;
    writeJson(`${LAB}/films.json`, this.films.toJson());
    writeJson(`${LAB}/match.json`, this.match);
    writeJson(`${LAB}/gone.json`, [...this.gone]);
    writeJson(`${LAB}/lists.json`, this.lists);
    this.dirty = false;
  }
}

// ------------------------------------------------------------------- LLM

export interface LlmCall {
  model: string;
  developer: string;
  user: string;
  effort?: string;
}

export interface LlmResult {
  text: string;
  input: number; // tokens
  output: number; // tokens, including reasoning
  reasoning: number; // tokens
  seconds: number;
  cached: boolean;
}

export class UsageLimit extends Error {}

const LOCK = `${LAB}/llm.lock`;
let lockHeld = false;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Only one lab process may talk to the LLM at a time (the sign-in's refresh token must not be raced). */
export async function acquireLlmLock(): Promise<void> {
  if (lockHeld) return;
  mkdirSync(LAB, { recursive: true });
  for (let waited = 0; ; waited++) {
    try {
      mkdirSync(LOCK);
      writeFileSync(`${LOCK}/pid`, String(process.pid));
      lockHeld = true;
      const release = () => {
        if (lockHeld) rmSync(LOCK, { recursive: true, force: true });
        lockHeld = false;
      };
      process.on('exit', release);
      process.on('SIGINT', () => {
        release();
        process.exit(130);
      });
      process.on('SIGTERM', () => {
        release();
        process.exit(143);
      });
      return;
    } catch {
      const pid = parseInt(existsSync(`${LOCK}/pid`) ? readFileSync(`${LOCK}/pid`, 'utf8') : '', 10);
      if (!Number.isFinite(pid) || !pidAlive(pid)) {
        rmSync(LOCK, { recursive: true, force: true });
        continue;
      }
      if (waited % 12 === 0) console.error(`Waiting: another lab run (pid ${pid}) is using the LLM…`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Responses API client for the lab: same request shape as src/core/llm.ts,
 * plus token counts from the API's usage field and a disk cache, so a repeated
 * identical call costs nothing and an interrupted run resumes.
 */
export class LabLlm {
  calls = 0; // calls that really went to the API in this process
  private token?: () => Promise<string>;

  private async auth(): Promise<string> {
    if (!this.token) {
      const key = process.env.OPENAI_API_KEY;
      if (key) this.token = async () => key;
      else {
        const a = new ChatGptAuth(platform());
        await a.load();
        if (!a.signedIn) throw new Error('No LLM access. Run `npm run eval -- signin` first.');
        this.token = () => a.accessToken();
      }
    }
    return this.token();
  }

  async models(): Promise<string[]> {
    await acquireLlmLock();
    await this.auth();
    return (await new Llm(this.token!).models()).map((m) => `${m.slug}  (${m.name})`);
  }

  /** `rep` distinguishes deliberate repeats of the same prompt (noise measurements). */
  async call(c: LlmCall, rep = 0): Promise<LlmResult> {
    const key = createHash('sha256').update(JSON.stringify([c.model, c.effort ?? '', c.developer, c.user, rep])).digest('hex').slice(0, 32);
    const path = `${LAB}/llm/${key}.json`;
    const hit = readJson(path);
    if (hit && typeof hit.text === 'string') return { ...hit, cached: true };
    await acquireLlmLock();
    let effort = c.effort;
    let limitWaits = 0;
    let offline = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        const t0 = Date.now();
        const r = await this.once(c, effort);
        const out: LlmResult = { ...r, seconds: (Date.now() - t0) / 1000, cached: false };
        writeJson(path, { text: out.text, input: out.input, output: out.output, reasoning: out.reasoning, seconds: out.seconds, model: c.model, effort: effort ?? null, at: new Date().toISOString() });
        return out;
      } catch (e) {
        if (e instanceof AuthError && e.code === 'network') {
          // No connection (e.g. the computer was asleep): wait a minute and try again, for up to an hour.
          if (++offline > 60) throw e;
          if (offline === 1) console.error(`  no connection (${new Date().toTimeString().slice(0, 5)}); trying again every minute…`);
          await sleep(60000);
          attempt--;
          continue;
        }
        if (!(e instanceof LlmError)) throw e;
        if (e.code === 'subscription_sharing_usage_limit_exceeded' || e.code === 'insufficient_quota') {
          // The ChatGPT plan's window is used up: wait for it to reset (it gives no reset time), up to 6 hours.
          if (++limitWaits > 36) throw new UsageLimit(e.message);
          console.error(`  usage limit reached (${new Date().toTimeString().slice(0, 5)}); waiting 10 minutes before trying again (${limitWaits}/36)…`);
          await sleep(600000);
          attempt--;
          continue;
        }
        if (e.needsSignIn || e.notEligible) throw e;
        if (e.status === 400 && effort !== undefined && e.message.toLowerCase().includes('reasoning')) {
          effort = undefined;
          continue;
        }
        if (e.status === 400 || e.code === 'model_not_found') throw e;
        if (attempt >= 4) throw e;
        await sleep(e.code === 'rate_limit_exceeded' ? 20000 * (attempt + 1) : 3000 * (attempt + 1));
      }
    }
  }

  private async once(c: LlmCall, effort: string | undefined): Promise<{ text: string; input: number; output: number; reasoning: number }> {
    const token = await this.auth();
    const ctl = new AbortController();
    let timer = setTimeout(() => ctl.abort(), 90000);
    const alive = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ctl.abort(), 240000);
    };
    this.calls++;
    try {
      let res: Response;
      try {
        res = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({
            model: c.model,
            input: [
              { role: 'developer', content: c.developer },
              { role: 'user', content: c.user },
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
        const body = await res.text().catch(() => '');
        let code = `http_${res.status}`;
        let message = `HTTP ${res.status}`;
        try {
          const e = JSON.parse(body).error;
          if (e && typeof e === 'object') {
            code = String(e.code ?? e.type ?? code);
            message = String(e.message ?? message);
          }
        } catch {}
        throw new LlmError(code, message, res.status);
      }
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let text = '';
      let usage: any;
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
        if (ev.type === 'response.output_text.delta') text += ev.delta ?? '';
        else if (ev.type === 'response.completed') {
          completed = true;
          usage = ev.response?.usage;
          if (!text) for (const item of ev.response?.output ?? []) for (const p of item?.content ?? []) if (p?.type === 'output_text') text += p.text ?? '';
        } else if (ev.type === 'response.failed') {
          const err = ev.response?.error;
          throw new LlmError(String(err?.code ?? 'unknown_error'), String(err?.message ?? 'failed'));
        } else if (ev.type === 'response.incomplete') throw new LlmError('incomplete', String(ev.response?.incomplete_details?.reason ?? 'incomplete'));
        else if (ev.type === 'error') throw new LlmError(String(ev.code ?? ev.error?.code ?? 'unknown_error'), String(ev.message ?? ev.error?.message ?? 'error'));
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          alive();
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            handle(buf.slice(0, nl).replace(/\r$/, ''));
            buf = buf.slice(nl + 1);
          }
        }
        if (buf) handle(buf);
      } catch (e) {
        if (e instanceof LlmError) throw e;
        throw new LlmError('interrupted', 'stream interrupted');
      }
      if (!completed) throw new LlmError('interrupted', 'stream ended early');
      return { text, input: Number(usage?.input_tokens ?? 0), output: Number(usage?.output_tokens ?? 0), reasoning: Number(usage?.output_tokens_details?.reasoning_tokens ?? 0) };
    } finally {
      clearTimeout(timer);
    }
  }
}

// --------------------------------------------------------------- engines

/** One film the person rated and the engine may see. */
export interface Known {
  film: Film;
  stars: number;
  at: number; // unix seconds of the rating
}

/** Everything an engine is given about one person. The hidden films are never in here. */
export interface EngineInput {
  userId: string;
  known: Known[]; // sorted: highest rating first, then most recent
  cutoffYear: number; // only films released up to this year may be recommended
}

export interface EngineIo {
  /** One LLM call. Model and effort default to the run's `model` / `effort` parameters. Token use and time are recorded. */
  llm(c: { developer: string; user: string; model?: string; effort?: string }): Promise<string>;
  /** Titles written by an LLM -> real TMDB films, in the same order; unknown titles are dropped (and counted). */
  resolveAll(ideas: { t: string; y?: number }[]): Promise<Film[]>;
  /** Run parameters given on the command line with --set name=value. */
  param(name: string, fallback: string): string;
  num(name: string, fallback: number): number;
  data: Data;
  /** The person's visible ratings as an app Library (for code that needs one, e.g. the taste model). */
  library(): Library;
  note(key: string, value: number): void; // extra per-user numbers to keep in the result file
}

/** Returns TMDB film ids, best first. The harness removes seen / too-new / duplicate films and scores the first 24. */
export type Engine = (input: EngineInput, io: EngineIo) => Promise<number[]>;

export interface UserResult {
  user: string;
  recs: number[];
  score: number; // loved − disliked: the agreed score
  expected: number; // the score these picks would get from their fame alone
  beyond: number; // score − expected: what the engine adds beyond fame
  loved: number;
  disliked: number;
  neutral: number; // hidden films rated 3 or 3.5 among the picks
  proposed: number; // films the engine returned
  dropSeen: number;
  dropLate: number;
  unknownTitles: number;
  llmCalls: number;
  tokensIn: number;
  tokensOut: number;
  tokensReasoning: number;
  llmSeconds: number; // sum of the LLM calls' durations
  medianVotes: number; // median TMDB vote count of the picks (how well known they are)
  notes: Record<string, number>;
  error?: string;
}

export function engineInput(u: PanelUser, d: Data): { input: EngineInput; hidden: Map<number, number>; visible: Set<number> } {
  const hide = new Set(u.hidden);
  const hidden = new Map<number, number>();
  const known: Known[] = [];
  for (const [id, stars, at] of u.ratings) {
    const film = d.films.get(id);
    if (!film || !film.full) continue; // no longer on TMDB
    if (hide.has(id)) hidden.set(id, stars);
    else known.push({ film, stars, at });
  }
  known.sort((a, b) => b.stars - a.stars || b.at - a.at);
  return { input: { userId: u.id, known, cutoffYear: new Date(u.cutoff * 1000).getUTCFullYear() }, hidden, visible: new Set(known.map((k) => k.film.id)) };
}

export async function runUser(u: PanelUser, d: Data, llm: LabLlm, engine: Engine, params: Record<string, string>, rep: number): Promise<UserResult> {
  const { input, hidden, visible } = engineInput(u, d);
  const r: UserResult = { user: u.id, recs: [], score: 0, expected: 0, beyond: 0, loved: 0, disliked: 0, neutral: 0, proposed: 0, dropSeen: 0, dropLate: 0, unknownTitles: 0, llmCalls: 0, tokensIn: 0, tokensOut: 0, tokensReasoning: 0, llmSeconds: 0, medianVotes: 0, notes: {} };
  const io: EngineIo = {
    llm: async (c) => {
      const model = c.model ?? params.model;
      if (!model) throw new Error('no model: pass --set model=<slug>');
      const res = await llm.call({ model, developer: c.developer, user: c.user, effort: c.effort ?? params.effort }, rep);
      r.llmCalls++;
      r.tokensIn += res.input;
      r.tokensOut += res.output;
      r.tokensReasoning += res.reasoning;
      r.llmSeconds += res.seconds;
      return res.text;
    },
    resolveAll: async (ideas) => {
      const fs = await Promise.all(ideas.map((i) => d.resolve(i.t, i.y)));
      r.unknownTitles += fs.filter((f) => !f).length;
      return fs.filter((f): f is Film => !!f);
    },
    param: (n, fb) => params[n] ?? fb,
    num: (n, fb) => (params[n] !== undefined && Number.isFinite(+params[n]) ? +params[n] : fb),
    data: d,
    library: () => {
      const lib = new Library();
      for (const k of input.known) lib.rate(k.film.id, k.stars);
      return lib;
    },
    note: (k, v) => (r.notes[k] = v),
  };
  let ids: number[] = [];
  try {
    ids = await engine(input, io);
  } catch (e) {
    if (e instanceof UsageLimit) throw e;
    if (e instanceof LlmError && (e.needsSignIn || e.notEligible)) throw e;
    r.error = e instanceof Error ? e.message : String(e);
  }
  // The test protocol: no film the person already rated, nothing released after their last rating, no repeats; first 24 count.
  const cutoff = new Date(u.cutoff * 1000).toISOString().slice(0, 10);
  const seen = new Set<number>();
  r.proposed = ids.length;
  for (const id of ids) {
    if (r.recs.length >= PICKS) break;
    if (seen.has(id)) continue;
    seen.add(id);
    const f = d.films.get(id);
    if (!f) continue;
    if (visible.has(id)) {
      r.dropSeen++;
      continue;
    }
    if (!f.release || f.release > cutoff) {
      r.dropLate++;
      continue;
    }
    r.recs.push(id);
    const stars = hidden.get(id);
    if (stars === undefined) continue;
    if (stars >= LOVED) r.loved++;
    else if (stars < DISLIKED) r.disliked++;
    else r.neutral++;
  }
  r.score = r.loved - r.disliked;
  r.expected = r.recs.reduce((a, id) => a + d.fame.expected(id, u.ratings.length), 0);
  r.beyond = r.score - r.expected;
  const votes = r.recs.map((id) => d.films.get(id)!.votes).sort((a, b) => a - b);
  r.medianVotes = votes.length ? votes[Math.floor(votes.length / 2)] : 0;
  return r;
}

export interface RunFile {
  name: string;
  engine: string;
  params: Record<string, string>;
  set: string;
  rep: number;
  at: string;
  users: UserResult[];
}

export const mean = (v: number[]): number => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);

export function summary(run: RunFile): Record<string, number> {
  const u = run.users;
  const m = (f: (r: UserResult) => number) => mean(u.map(f));
  const secs = u.map((r) => r.llmSeconds).sort((a, b) => a - b);
  return {
    users: u.length,
    score: m((r) => r.score),
    expected: m((r) => r.expected),
    beyond: m((r) => r.beyond),
    loved: m((r) => r.loved),
    disliked: m((r) => r.disliked),
    neutral: m((r) => r.neutral),
    picks: m((r) => r.recs.length),
    unknown: m((r) => r.unknownTitles),
    dropSeen: m((r) => r.dropSeen),
    dropLate: m((r) => r.dropLate),
    calls: m((r) => r.llmCalls),
    tokIn: m((r) => r.tokensIn),
    tokOut: m((r) => r.tokensOut),
    tokReason: m((r) => r.tokensReasoning),
    sec: m((r) => r.llmSeconds),
    secP90: secs.length ? secs[Math.floor(0.9 * (secs.length - 1))] : 0,
    medVotes: m((r) => r.medianVotes),
    errors: u.filter((r) => r.error).length,
  };
}

export const runPath = (name: string): string => `${LAB}/runs/${name}.json`;

/** Paired comparison of two runs over the users both contain: B minus A. */
export function compare(a: RunFile, b: RunFile, field: 'score' | 'beyond' | 'loved' | 'disliked' = 'beyond'): { n: number; a: number; b: number; diff: number; lo: number; hi: number; wins: number; losses: number; ties: number } {
  const bm = new Map(b.users.map((r) => [r.user, r]));
  const pairs = a.users.filter((r) => bm.has(r.user)).map((r) => [r[field], bm.get(r.user)![field]] as [number, number]);
  const d = pairs.map(([x, y]) => y - x);
  // Bootstrap over users, fixed seed so the interval is reproducible.
  let s = 12345;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const boots: number[] = [];
  for (let i = 0; i < 5000; i++) {
    let sum = 0;
    for (let k = 0; k < d.length; k++) sum += d[Math.floor(rnd() * d.length)];
    boots.push(sum / d.length);
  }
  boots.sort((x, y) => x - y);
  return {
    n: d.length,
    a: mean(pairs.map((p) => p[0])),
    b: mean(pairs.map((p) => p[1])),
    diff: mean(d),
    lo: boots[Math.floor(0.05 * boots.length)],
    hi: boots[Math.floor(0.95 * boots.length)],
    wins: d.filter((x) => x > 0).length,
    losses: d.filter((x) => x < 0).length,
    ties: d.filter((x) => x === 0).length,
  };
}

// ------------------------------------------------------------ equal fame
//
// Well-known films are in everybody's history, so an engine that leans towards them collects more hits without
// understanding the person any better. To compare engines fairly, the hits are counted inside fame bands and
// re-weighted to one fixed mix of bands: "the score if every engine recommended equally well-known films".

/** Fame bands: the share of the comparable MovieLens users who rated a film, most famous first. */
export const FAME_BANDS = [0.5, 0.3, 0.2, 0.1, 0.05, 0.02, 0.01, 0.004, 0];
/** The fixed mix: how the picks of the plain one-call engine (Sol, seven runs on the dev users) spread over the bands. */
export const FAME_MIX = [0.123, 0.126, 0.139, 0.174, 0.161, 0.132, 0.052, 0.055, 0.038];

/** One person's picks per fame band: [number of picks, loved − disliked]. */
export type Bands = [picks: number, net: number][];

export function bandsOf(run: RunFile, d: Data): Map<string, Bands> {
  const panel = new Map(d.panel.users.map((u) => [u.id, u]));
  const out = new Map<string, Bands>();
  for (const r of run.users) {
    const u = panel.get(r.user);
    if (!u) continue;
    const hide = new Set(u.hidden);
    const net = new Map<number, number>();
    for (const [id, stars] of u.ratings) if (hide.has(id)) net.set(id, stars >= LOVED ? 1 : stars < DISLIKED ? -1 : 0);
    const b: Bands = FAME_BANDS.map(() => [0, 0]);
    for (const id of r.recs) {
      const k = FAME_BANDS.findIndex((e) => d.fame.share(id) >= e);
      b[k][0]++;
      b[k][1] += net.get(id) ?? 0;
    }
    out.set(r.user, b);
  }
  return out;
}

/** Score at equal fame over these people. Bands with fewer than 5 picks say nothing and are left out. */
export function equalFame(people: Bands[]): number {
  let sum = 0;
  let weight = 0;
  for (let k = 0; k < FAME_BANDS.length; k++) {
    let n = 0;
    let net = 0;
    for (const b of people) {
      n += b[k][0];
      net += b[k][1];
    }
    if (n < 5) continue;
    sum += FAME_MIX[k] * (net / n);
    weight += FAME_MIX[k];
  }
  return weight ? (sum / weight) * PICKS : NaN;
}

/** Paired comparison at equal fame over the people both runs contain: B minus A, with a bootstrap interval over people. */
export function compareEqualFame(a: RunFile, b: RunFile, d: Data): { n: number; a: number; b: number; diff: number; lo: number; hi: number } {
  const ba = bandsOf(a, d);
  const bb = bandsOf(b, d);
  const ids = [...ba.keys()].filter((id) => bb.has(id));
  const A = ids.map((id) => ba.get(id)!);
  const B = ids.map((id) => bb.get(id)!);
  let s = 12345;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const boots: number[] = [];
  for (let i = 0; i < 3000; i++) {
    const pick = ids.map(() => Math.floor(rnd() * ids.length));
    const v = equalFame(pick.map((k) => B[k])) - equalFame(pick.map((k) => A[k]));
    if (Number.isFinite(v)) boots.push(v);
  }
  boots.sort((x, y) => x - y);
  const ea = equalFame(A);
  const eb = equalFame(B);
  return { n: ids.length, a: ea, b: eb, diff: eb - ea, lo: boots[Math.floor(0.05 * boots.length)] ?? NaN, hi: boots[Math.floor(0.95 * boots.length)] ?? NaN };
}
