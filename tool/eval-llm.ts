// LLM-backed evaluation modes. Uses OPENAI_API_KEY when set, otherwise a
// "Sign in with ChatGPT" session stored outside the repository
// (~/.config/what-to-watch/eval-credentials.json, owner-only).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Server, createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { AuthPlatform, ChatGptAuth, Loopback, SecretStore } from '../src/core/auth';
import { requestBrief, tasteBrief, validateWhy } from '../src/core/engine/prompts';
import { Recommender, engineConfig } from '../src/core/engine/recommender';
import { Services, newRequest } from '../src/core/engine/request';
import { matchTitle } from '../src/core/letterboxd';
import { Llm } from '../src/core/llm';
import { scoreOf } from '../src/core/models';

import { EvalData, Fold, cacheDir, kfold, readJson, report, reportHeader, without, writeJson } from './eval-common';

class FileSecretStore implements SecretStore {
  private path = join(homedir(), '.config', 'what-to-watch', 'eval-credentials.json');
  private data: Record<string, string> = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {};
  async read(key: string): Promise<string | null> {
    return this.data[key] ?? null;
  }
  async write(key: string, value: string | null): Promise<void> {
    if (value === null) delete this.data[key];
    else this.data[key] = value;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data), { mode: 0o600 });
    chmodSync(`${this.path}.tmp`, 0o600);
    renameSync(`${this.path}.tmp`, this.path);
  }
}

class NodeLoopback implements Loopback {
  private server?: Server;
  private resolve?: (q: string) => void;
  private reject?: (e: Error) => void;
  private result?: Promise<string>;

  start(opts: { path: string; state: string; okHtml: string; failHtml: string }): Promise<number> {
    this.stop();
    this.result = new Promise((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
    this.result.catch(() => {});
    return new Promise((ready, fail) => {
      const server = (this.server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== opts.path) {
          res.writeHead(404).end();
          return;
        }
        const ok = !url.searchParams.get('error') && url.searchParams.get('state') === opts.state;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(ok ? opts.okHtml : opts.failHtml);
        this.resolve?.(url.search.slice(1));
      }));
      server.on('error', fail);
      server.listen(0, '127.0.0.1', () => ready((server.address() as { port: number }).port));
    });
  }
  wait(): Promise<string> {
    return this.result ?? Promise.reject(new Error('not started'));
  }
  stop(): void {
    this.reject?.(new Error('stopped'));
    this.server?.close();
    this.server = undefined;
  }
}

const adbPath = join(homedir(), 'Library/Android/sdk/platform-tools/adb');

function platform(adb = false): AuthPlatform {
  return {
    store: new FileSecretStore(),
    loopback: new NodeLoopback(),
    randomBytes: (n) => new Uint8Array(randomBytes(n)),
    openBrowser: async (url) => {
      if (adb) {
        // The browser step happens on the connected Android device; its
        // loopback port is forwarded to this machine.
        const port = new URL(new URL(url).searchParams.get('redirect_uri')!).port;
        execFileSync(adbPath, ['reverse', `tcp:${port}`, `tcp:${port}`]);
        execFileSync(adbPath, ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'${url}'`]);
        console.error(`Opened the sign-in page on the Android device (port ${port}).`);
      } else {
        console.error('Opening the browser to sign in…');
        execFileSync('open', [url]);
      }
      return 'opened';
    },
  };
}

export async function evalSignIn(adb = false): Promise<void> {
  const auth = new ChatGptAuth(platform(adb));
  await auth.load();
  await auth.signIn();
  console.log(`Signed in as ${auth.email}.`);
}

async function llmFor(model?: string): Promise<[Llm, string]> {
  const key = process.env.OPENAI_API_KEY;
  let llm: Llm;
  if (key) {
    llm = new Llm(async () => key);
  } else {
    const auth = new ChatGptAuth(platform());
    await auth.load();
    if (!auth.signedIn) {
      console.error('No LLM access. Run `npm run eval -- signin` or set OPENAI_API_KEY.');
      process.exit(2);
    }
    llm = new Llm(() => auth.accessToken());
  }
  const models = await llm.models();
  console.log(`Models: ${models.map((m) => m.slug).join(', ')}`);
  const slug = model ?? models[0].slug;
  console.log(`Using: ${slug}`);
  return [llm, slug];
}

/**
 * Held-out rating prediction by the LLM judge, alone and blended with the
 * local taste model. One LLM call per fold; verdicts are cached.
 */
export async function evalJudge(d: EvalData, model: string | undefined, folds: number, effort?: string): Promise<void> {
  const [llm, slug] = await llmFor(model);
  const sv = new Services('DE');
  const names = ['TMDB score (baseline)', 'taste model', 'LLM judge', 'blend 40% judge', 'blend 60% judge', 'blend 80% judge'];
  const reports: Record<string, Fold[]> = Object.fromEntries(names.map((n) => [n, []]));
  let whyOk = 0;
  let whyAll = 0;
  let missing = 0;
  const split = kfold(d.lib).slice(0, folds);
  for (let i = 0; i < split.length; i++) {
    const fold = split[i];
    const lib = without(d.lib, fold);
    const rec = new Recommender(d.tmdb, llm, lib, sv, engineConfig(slug, effort ? { judgeEffort: effort } : {}));
    const m = rec.model();
    const brief = tasteBrief(lib, d.films, m, { tagged: true, listSeen: false });
    const cands = fold.map((id) => d.films.get(id)).filter((f) => !!f);
    const cache = `${cacheDir}/judge_${slug}${effort ? `_${effort}` : ''}_${i}.json`;
    let raw: Record<string, { r: number; m: number; why: string }> | undefined = readJson(cache);
    if (!raw) {
      const t0 = Date.now();
      const v = await rec.judge(cands, requestBrief(newRequest(), sv), brief);
      console.error(`fold ${i + 1}/${split.length}: ${v.size}/${cands.length} verdicts in ${Math.round((Date.now() - t0) / 1000)}s`);
      raw = Object.fromEntries([...v].map(([id, x]) => [String(id), x]));
      writeJson(cache, raw);
    }
    const fs: Record<string, Fold> = Object.fromEntries(names.map((n) => [n, { pred: [], y: [] }]));
    for (const f of cands) {
      const y = d.lib.get(f.id)!.rating!;
      const local = m.predict(f).rating;
      const v = raw[String(f.id)];
      if (!v) missing++;
      const j = v?.r ?? local;
      if (v) {
        whyAll++;
        if (validateWhy(v.why, brief.tags, lib, d.films)) whyOk++;
      }
      const add = (n: string, p: number) => {
        fs[n].pred.push(p);
        fs[n].y.push(y);
      };
      add(names[0], scoreOf(f));
      add(names[1], local);
      add(names[2], j);
      add(names[3], 0.4 * j + 0.6 * local);
      add(names[4], 0.6 * j + 0.4 * local);
      add(names[5], 0.8 * j + 0.2 * local);
    }
    for (const n of names) reports[n].push(fs[n]);
  }
  console.log(`\n${split.length}-fold hold-out, LLM judge (${slug}${effort ? `, reasoning effort ${effort}` : ''})\n${reportHeader}`);
  for (const n of names) console.log(report(n, reports[n]));
  console.log(`\nExplanations passing validation: ${whyOk}/${whyAll} · candidates without verdict: ${missing}`);
  console.log(`LLM calls: ${llm.calls}, output chars: ${llm.chars}`);
}

/**
 * Blind rediscovery: hide a fold of ratings completely, run the full
 * pipeline, and look at the films it brings back that the user had in fact
 * already seen and rated.
 */
export async function evalBlind(d: EvalData, model: string | undefined, folds: number, prompt?: string): Promise<void> {
  const [llm, slug] = await llmFor(model);
  const split = kfold(d.lib).slice(0, folds);
  const idea: number[] = [];
  const judged: number[] = [];
  const top: number[] = [];
  const dropped: number[] = [];
  const base: number[] = [];
  const rating = (id: number) => d.lib.get(id)!.rating!;
  for (let i = 0; i < split.length; i++) {
    const fold = new Set(split[i]);
    base.push(...split[i].map(rating));
    const lib = without(d.lib, fold);
    const rec = new Recommender(d.tmdb, llm, lib, new Services('DE'), engineConfig(slug, { batch: 12 }));
    const t0 = Date.now();
    const s = await rec.start(newRequest({ prompt: prompt ?? '' }));
    console.error(`fold ${i + 1}: ${s.picks.length} picks, ${s.reserve.length} in reserve, ${Math.round((Date.now() - t0) / 1000)}s${s.notice ? ` · ${s.notice}` : ''}`);
    for (const t of s.suggested) {
      const m = /^(.*) \((\d{4})\)$/.exec(t);
      const f = await matchTitle(d.tmdb, m?.[1] ?? t, m ? +m[2] : undefined);
      if (f && fold.has(f.id)) idea.push(rating(f.id));
    }
    const kept = new Set([...s.picks, ...s.reserve].map((p) => p.film.id));
    judged.push(...[...kept].filter((id) => fold.has(id)).map(rating));
    top.push(...s.picks.map((p) => p.film.id).filter((id) => fold.has(id)).map(rating));
    dropped.push(...[...s.seen].filter((id) => fold.has(id) && !kept.has(id)).map(rating));
    console.log(`  first batch: ${s.picks.map((p) => `${p.film.title}${fold.has(p.film.id) ? ` [★${rating(p.film.id)}]` : ''}`).join(' · ')}`);
    for (const p of s.picks.slice(0, 4)) console.log(`    why ${p.film.title}: ${p.why}${p.facts.length ? ` (${p.facts.join('; ')})` : ''}`);
  }
  d.save();
  const line = (name: string, v: number[]) =>
    v.length === 0
      ? `${name.padEnd(44)} n=0`
      : `${name.padEnd(44)} n=${String(v.length).padStart(3)}  ≥3★ ${((v.filter((x) => x >= 3).length / v.length) * 100).toFixed(0).padStart(3)}%  ≥4★ ${((v.filter((x) => x >= 4).length / v.length) * 100).toFixed(0).padStart(3)}%  mean ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)}`;
  console.log(`\nBlind rediscovery (${slug}, ${split.length} folds) — true ratings of hidden films the engine brought back`);
  console.log(line('hidden films overall (base rate)', base));
  console.log(line('proposed by LLM scouting', idea));
  console.log(line('survived judging (picks + reserve)', judged));
  console.log(line('in the first batch of 12', top));
  console.log(line('rejected by the judge or filters', dropped));
  console.log(`LLM calls: ${llm.calls}`);
}
