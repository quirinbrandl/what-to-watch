// Shared plumbing for the offline evaluation (see tool/eval.ts).
// Personal data and caches live in .eval_cache/, which is git-ignored.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LbExport, applyExport, exportRelPath, matchTitle, parseLetterboxdFiles, parseLetterboxdZip } from '../src/core/letterboxd';
import { Library } from '../src/core/models';
import { FilmCache, Tmdb } from '../src/core/tmdb';

export const cacheDir = '.eval_cache';

export function readJson(path: string): any | undefined {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
  } catch {
    return undefined;
  }
}

export function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(data));
  renameSync(`${path}.tmp`, path);
}

export interface EvalData {
  lib: Library;
  films: FilmCache;
  tmdb: Tmdb;
  save(): void;
}

/**
 * Loads a Letterboxd export (folder or ZIP), matches it to TMDB and fetches
 * details. Matches and film details are cached, so later runs are offline.
 */
export async function loadExport(path: string, region = 'DE'): Promise<EvalData> {
  let ex: LbExport;
  if (statSync(path).isDirectory()) {
    const files: Record<string, string> = {};
    for (const f of readdirSync(path, { recursive: true }) as string[]) {
      const rel = exportRelPath(f);
      if (rel) files[rel] = readFileSync(join(path, f), 'utf8');
    }
    ex = parseLetterboxdFiles(files);
  } else {
    ex = parseLetterboxdZip(new Uint8Array(readFileSync(path)));
  }
  const films = new FilmCache();
  films.load(readJson(`${cacheDir}/films.json`));
  const tmdb = new Tmdb(films);
  const match: Record<string, number | null> = readJson(`${cacheDir}/match.json`) ?? {};
  const todo = [...ex.films.values()].filter((f) => !(f.key in match));
  if (todo.length) {
    console.error(`Matching ${todo.length} films to TMDB…`);
    await Promise.all(todo.map(async (f) => (match[f.key] = (await matchTitle(tmdb, f.name, f.year))?.id ?? null)));
    writeJson(`${cacheDir}/match.json`, match);
  }
  for (const f of ex.films.values()) f.tmdbId = match[f.key] ?? undefined;
  const lib = new Library();
  applyExport(lib, ex);
  const missing = [...lib.entries.keys()].filter((id) => films.get(id)?.full !== true);
  const save = () => writeJson(`${cacheDir}/films.json`, films.toJson());
  if (missing.length) {
    console.error(`Fetching details for ${missing.length} films…`);
    await tmdb.detailsAll(missing, region, { providerMaxAgeDays: 9999 });
    save();
  }
  return { lib, films, tmdb, save };
}

// ---------------------------------------------------------------- metrics

/** Probability that a random hit (y ≥ cut) is scored above a random miss. */
export function auc(pred: number[], y: number[], cut = 3): number {
  let pairs = 0;
  let wins = 0;
  for (let i = 0; i < y.length; i++) {
    if (y[i] < cut) continue;
    for (let j = 0; j < y.length; j++) {
      if (y[j] >= cut) continue;
      pairs++;
      wins += pred[i] > pred[j] ? 1 : pred[i] === pred[j] ? 0.5 : 0;
    }
  }
  return pairs === 0 ? NaN : wins / pairs;
}

function ranks(v: number[]): number[] {
  const idx = v.map((_, i) => i).sort((a, b) => v[a] - v[b]);
  const r = new Array<number>(v.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && v[idx[j + 1]] === v[idx[i]]) j++;
    for (let k = i; k <= j; k++) r[idx[k]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

export function spearman(a: number[], b: number[]): number {
  const ra = ranks(a);
  const rb = ranks(b);
  const ma = ra.reduce((x, y) => x + y, 0) / ra.length;
  const mb = rb.reduce((x, y) => x + y, 0) / rb.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

/** One evaluation fold: predictions for held-out films and their true ratings. */
export interface Fold {
  pred: number[];
  y: number[];
}

export const reportHeader = `${'model'.padEnd(26)} AUC≥3  AUC≥4  rho    hit@10  loved@10  mean@10  misses`;

/**
 * "The engine recommends the top k of each fold" — what share of those did
 * the user rate ≥ 3★ (hit), ≥ 4★ (loved), and what was the mean?
 */
export function report(name: string, folds: Fold[], k = 10): string {
  const p = folds.flatMap((f) => f.pred);
  const y = folds.flatMap((f) => f.y);
  const top: number[] = [];
  for (const f of folds) {
    const idx = f.y.map((_, i) => i).sort((a, b) => f.pred[b] - f.pred[a]);
    top.push(...idx.slice(0, k).map((i) => f.y[i]));
  }
  const share = (t: (v: number) => boolean) => top.filter(t).length / top.length;
  const mean = top.reduce((a, b) => a + b, 0) / top.length;
  return [
    name.padEnd(26),
    auc(p, y).toFixed(3),
    ' ' + auc(p, y, 4).toFixed(3),
    ' ' + spearman(p, y).toFixed(3).padStart(5),
    ' ' + (share((v) => v >= 3) * 100).toFixed(1).padStart(5) + '%',
    ' ' + (share((v) => v >= 4) * 100).toFixed(1).padStart(6) + '%',
    ' ' + mean.toFixed(2).padStart(6),
    ' ' + String(top.filter((v) => v < 3).length).padStart(5),
  ].join(' ');
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stratified k-fold split of rated film ids (stable for a given seed). */
export function kfold(lib: Library, k = 5, seed = 7): number[][] {
  const rnd = mulberry32(seed);
  const rated = lib.rated.sort((a, b) => a.id - b.id);
  for (let i = rated.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [rated[i], rated[j]] = [rated[j], rated[i]];
  }
  rated.sort((a, b) => a.rating! - b.rating!); // stable: keeps the shuffle within a rating
  const folds: number[][] = Array.from({ length: k }, () => []);
  rated.forEach((e, i) => folds[i % k].push(e.id));
  return folds;
}

export function without(lib: Library, ids: Iterable<number>): Library {
  const copy = Library.fromJson(JSON.parse(JSON.stringify(lib.toJson())));
  for (const id of ids) copy.entries.delete(id);
  return copy;
}
