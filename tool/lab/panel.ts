// Builds the evaluation panel from MovieLens 32M (see tool/lab/README.md).
//
//   npx tsx tool/lab/panel.ts
//
// Output: .eval_cache/lab/panel.json (git-ignored; MovieLens data is for
// non-commercial research use and must not be committed).
import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

import { writeJson } from '../eval-common';

export const LAB = '.eval_cache/lab';
const ML = '.eval_cache/movielens/ml-32m';

export interface PanelUser {
  id: string;
  cutoff: number; // unix seconds of the user's last rating
  ratings: [tmdbId: number, stars: number, at: number][];
  hidden: number[]; // tmdb ids of the 30% hidden from the engine
}

export interface Panel {
  seed: number;
  users: PanelUser[];
  dev: string[]; // 40 users for experiments
  test: string[]; // 80 users held back for confirmation
  spare: string[]; // further users, unused unless the panel is enlarged
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(a: T[], rnd: () => number): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main(): Promise<void> {
  const SEED = 20261118;
  const MIN = 150;
  const MAX = 400;
  const ACTIVE_SINCE = Date.UTC(2023, 0, 1) / 1000;
  const HIDE = 0.3;

  const links = new Map<string, number>();
  for (const line of readFileSync(`${ML}/links.csv`, 'utf8').split('\n').slice(1)) {
    const p = line.trim().split(',');
    if (p.length >= 3 && p[2]) links.set(p[0], +p[2]);
  }

  // ratings.csv is sorted by user, so one pass with a per-user buffer is enough.
  const eligible: { id: string; ratings: [number, number, number][] }[] = [];
  const popularity = new Map<number, number>(); // tmdb id -> number of ratings in MovieLens
  // Among the eligible users only: how many rated each film, how many loved it (>= 4), how many disliked it (< 3).
  const stats = new Map<number, [number, number, number]>();
  let cur = '';
  let buf = new Map<number, [number, number, number]>();
  const flush = () => {
    if (!cur) return;
    const rs = [...buf.values()];
    const last = rs.reduce((m, r) => Math.max(m, r[2]), 0);
    if (rs.length >= MIN && rs.length <= MAX && last >= ACTIVE_SINCE) {
      eligible.push({ id: cur, ratings: rs });
      for (const [tm, stars] of rs) {
        let st = stats.get(tm);
        if (!st) stats.set(tm, (st = [0, 0, 0]));
        st[0]++;
        if (stars >= 4) st[1]++;
        else if (stars < 3) st[2]++;
      }
    }
  };
  const rl = createInterface({ input: createReadStream(`${ML}/ratings.csv`), crlfDelay: Infinity });
  let first = true;
  for await (const line of rl) {
    if (first) {
      first = false;
      continue;
    }
    const p = line.split(',');
    const tm = links.get(p[1]);
    if (tm === undefined) continue;
    if (p[0] !== cur) {
      flush();
      cur = p[0];
      buf = new Map();
    }
    const at = +p[3];
    const old = buf.get(tm);
    if (!old || at > old[2]) buf.set(tm, [tm, +p[2], at]); // two MovieLens ids for one TMDB film: keep the later rating
    popularity.set(tm, (popularity.get(tm) ?? 0) + 1);
  }
  flush();

  const rnd = mulberry32(SEED);
  eligible.sort((a, b) => +a.id - +b.id);
  shuffle(eligible, rnd);
  const chosen = eligible.slice(0, 200);
  const users: PanelUser[] = chosen.map((u) => {
    const r = mulberry32(SEED ^ +u.id);
    const ids = shuffle(u.ratings.map((x) => x[0]).sort((a, b) => a - b), r);
    return {
      id: u.id,
      cutoff: u.ratings.reduce((m, x) => Math.max(m, x[2]), 0),
      ratings: u.ratings.sort((a, b) => a[0] - b[0]),
      hidden: ids.slice(0, Math.round(ids.length * HIDE)).sort((a, b) => a - b),
    };
  });
  const panel: Panel = { seed: SEED, users, dev: users.slice(0, 40).map((u) => u.id), test: users.slice(40, 120).map((u) => u.id), spare: users.slice(120).map((u) => u.id) };
  writeJson(`${LAB}/panel.json`, panel);
  writeJson(`${LAB}/mlpop.json`, Object.fromEntries(popularity));
  writeJson(`${LAB}/mlstats.json`, { users: eligible.length, meanRatings: eligible.reduce((a, u) => a + u.ratings.length, 0) / eligible.length, films: Object.fromEntries(stats) });
  const n = users.slice(0, 120).reduce((a, u) => a + u.ratings.length, 0);
  console.log(`eligible users: ${eligible.length} · panel: ${users.length} (dev 40, test 80, spare ${users.length - 120}) · ratings in dev+test: ${n}`);
}

if (process.argv[1]?.endsWith('panel.ts')) main().then(() => process.exit(0));
