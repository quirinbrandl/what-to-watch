import { Film, GENRES, LANGUAGES, Library, decadeOf, scoreOf } from '../models';
import { FilmCache } from '../tmdb';

/** One piece of taste evidence: a film with a (pseudo-)rating and a weight. */
export interface Sample {
  film: Film;
  y: number;
  w: number;
  rated: boolean;
  vec: Map<string, number>; // idf-weighted, L2-normalised features
  x: number[]; // leave-one-out stack features (rated samples only)
}

export interface Neighbor {
  film: Film;
  sim: number;
  rating: number;
}

export interface Prediction {
  rating: number; // predicted stars, 0.5–5
  neighbors: Neighbor[]; // most similar films the user rated
  x: number[];
}

export interface TasteOptions {
  lambda: number; // ridge strength of the stacker
  useWatchlist: boolean; // watchlist as weak positive evidence
  knn: number;
  drop: Set<string>; // feature names to disable (for ablations)
  nonNegative: boolean;
}

export const defaultTaste: TasteOptions = { lambda: 20, useWatchlist: true, knn: 12, drop: new Set(), nonNegative: true };

const SHRINK: Record<string, number> = { g: 3, k: 2, d: 1.5, c: 2, y: 5, l: 5 };
const TYPE_W: Record<string, number> = { g: 1, k: 1, d: 2, c: 0.8, y: 0.5, l: 0.6 };
const DEFAULTS = [0.8, 0.6, 0.8, 0.4, 0.4, 0.4, 0.8, 0.8, 0.15, 0.45, 0.05];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The local, deterministic taste model.
 *
 * It learns how much the user likes each genre, keyword, director, actor,
 * decade and language (shrunk mean deviation from their own average), finds
 * the most similar films they rated (kNN on idf-weighted features), reads the
 * TMDB recommendation graph around their films, and stacks all of that with
 * a non-negative ridge regression fitted on leave-one-out features of their
 * own ratings.
 */
export class TasteModel {
  static readonly names = ['genre', 'keyword', 'director', 'cast', 'decade', 'lang', 'knn', 'collab', 'collabN', 'vote', 'votes'];

  private stats = new Map<string, { s: number; w: number }>();
  private df = new Map<string, number>();
  private byId = new Map<number, Sample>();
  private recBy = new Map<number, Sample[]>();
  readonly kwNames = new Map<number, string>();
  private mu: number[] = [];
  private sd: number[] = [];
  private beta: number[] = [];
  learned = false;

  private constructor(readonly samples: Sample[], readonly mean: number, readonly rated: number, readonly opt: TasteOptions) {}

  static featuresOf(f: Film): string[] {
    const out: string[] = [];
    for (const g of f.genres) out.push(`g:${g}`);
    for (const k of f.keywords) out.push(`k:${k.id}`);
    for (const d of f.directors) out.push(`d:${d}`);
    for (const c of f.cast.slice(0, 4)) out.push(`c:${c}`);
    const dec = decadeOf(f);
    if (dec !== undefined) out.push(`y:${dec}`);
    if (f.lang) out.push(`l:${f.lang}`);
    return out;
  }

  /** Turns a library into weighted samples. `hide` removes films (evaluation hold-out). */
  static samplesFrom(lib: Library, films: FilmCache, hide: Set<number> = new Set(), opt: TasteOptions = defaultTaste): Sample[] {
    const ratings = lib.rated.filter((e) => !hide.has(e.id)).map((e) => e.rating!);
    const mu = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 3.4;
    const out: Sample[] = [];
    const add = (film: Film, y: number, w: number, rated: boolean) => out.push({ film, y, w, rated, vec: new Map(), x: [] });
    for (const e of lib.entries.values()) {
      if (hide.has(e.id)) continue;
      const f = films.get(e.id);
      if (!f || !f.full) continue;
      const r = e.rating;
      if (r !== undefined) add(f, r, 1 + (e.liked ? 0.25 : 0) + (e.favorite ? 0.5 : 0) + (e.rewatched ? 0.25 : 0), true);
      else if (e.notInterested) add(f, Math.min(2.25, mu - 1), 0.5, false);
      else if (e.watched && e.liked) add(f, Math.max(4.0, mu + 0.5), 0.7, false);
      else if (e.watchlist && opt.useWatchlist) add(f, Math.min(4.25, mu + 0.5), 0.3, false);
    }
    return out;
  }

  static fromLibrary(lib: Library, films: FilmCache, hide: Set<number> = new Set(), opt: TasteOptions = defaultTaste): TasteModel {
    return TasteModel.build(TasteModel.samplesFrom(lib, films, hide, opt), opt);
  }

  static build(samples: Sample[], opt: TasteOptions = defaultTaste): TasteModel {
    const rs = samples.filter((s) => s.rated);
    const mean = rs.length ? rs.reduce((a, s) => a + s.y, 0) / rs.length : 3.4;
    const m = new TasteModel(samples, mean, rs.length, opt);
    for (const s of samples) {
      m.byId.set(s.film.id, s);
      for (const k of s.film.keywords) m.kwNames.set(k.id, k.name);
      for (const f of TasteModel.featuresOf(s.film)) {
        let st = m.stats.get(f);
        if (!st) m.stats.set(f, (st = { s: 0, w: 0 }));
        st.s += s.w * (s.y - mean);
        st.w += s.w;
        m.df.set(f, (m.df.get(f) ?? 0) + 1);
      }
      for (const r of s.film.recs) {
        const l = m.recBy.get(r);
        if (l) l.push(s);
        else m.recBy.set(r, [s]);
      }
    }
    for (const s of samples) s.vec = m.vector(s.film);
    // Stack: fit on leave-one-out features so the weights are honest.
    for (const s of rs) s.x = m.features(s.film, s);
    const d = TasteModel.names.length;
    m.mu = new Array(d).fill(0);
    m.sd = new Array(d).fill(1);
    m.learned = rs.length >= 25;
    if (!m.learned) {
      m.beta = [...DEFAULTS];
      return m;
    }
    for (let j = 0; j < d; j++) {
      const col = rs.map((s) => s.x[j]);
      const mu = col.reduce((a, b) => a + b, 0) / col.length;
      const v = col.reduce((a, c) => a + (c - mu) * (c - mu), 0) / col.length;
      m.mu[j] = mu;
      m.sd[j] = v < 1e-9 ? 0 : Math.sqrt(v);
    }
    const a = Array.from({ length: d }, () => new Array<number>(d).fill(0));
    const b = new Array<number>(d).fill(0);
    for (const s of rs) {
      const z = m.z(s.x);
      for (let i = 0; i < d; i++) {
        b[i] += z[i] * (s.y - mean);
        for (let j = 0; j < d; j++) a[i][j] += z[i] * z[j];
      }
    }
    for (let i = 0; i < d; i++) a[i][i] += opt.lambda;
    // Non-negative ridge: an affinity can only ever help. Features whose
    // weight comes out negative are noise on small libraries; drop and refit.
    const active = Array.from({ length: d }, (_, i) => i);
    for (;;) {
      const sub = solve(
        active.map((i) => active.map((j) => a[i][j])),
        active.map((i) => b[i]),
      );
      let worst = -1;
      for (let k = 0; k < active.length; k++) {
        if (TasteModel.names[active[k]] !== 'votes' && sub[k] < 0 && (worst < 0 || sub[k] < sub[worst])) worst = k;
      }
      if (worst < 0 || !opt.nonNegative) {
        m.beta = new Array(d).fill(0);
        active.forEach((idx, k) => (m.beta[idx] = sub[k]));
        break;
      }
      active.splice(worst, 1);
    }
    return m;
  }

  private z(x: number[]): number[] {
    return x.map((v, j) => (this.sd[j] === 0 || this.opt.drop.has(TasteModel.names[j]) ? 0 : (v - this.mu[j]) / this.sd[j]));
  }

  private idf(f: string): number {
    return Math.log((this.samples.length + 1) / ((this.df.get(f) ?? 0) + 0.5)) * TYPE_W[f[0]];
  }

  private vector(film: Film): Map<string, number> {
    const v = new Map<string, number>();
    let norm = 0;
    for (const f of TasteModel.featuresOf(film)) {
      const w = this.idf(f);
      v.set(f, w);
      norm += w * w;
    }
    if (norm > 0) {
      const n = Math.sqrt(norm);
      for (const [k, w] of v) v.set(k, w / n);
    }
    return v;
  }

  private static dot(a: Map<string, number>, b: Map<string, number>): number {
    if (a.size > b.size) return TasteModel.dot(b, a);
    let s = 0;
    for (const [k, v] of a) {
      const o = b.get(k);
      if (o !== undefined) s += v * o;
    }
    return s;
  }

  private nearest(film: Film, vec: Map<string, number>, self?: Sample): [Sample, number][] {
    const sims: [Sample, number][] = [];
    for (const s of this.samples) {
      if (s === self || s.film.id === film.id) continue;
      const sim = TasteModel.dot(vec, s.vec);
      if (sim > 0.02) sims.push([s, sim]);
    }
    sims.sort((a, b) => b[1] - a[1]);
    return sims.slice(0, this.opt.knn);
  }

  /** Raw stack features. With `self`, the sample's own contribution is removed everywhere (leave-one-out). */
  private features(film: Film, self?: Sample): number[] {
    const exS = self ? self.w * (self.y - this.mean) : 0;
    const exW = self?.w ?? 0;
    const sums: Record<string, number> = {};
    const counts: Record<string, number> = {};
    let dirBest = 0;
    for (const f of TasteModel.featuresOf(film)) {
      const st = this.stats.get(f);
      if (!st) continue;
      const w = st.w - exW;
      if (w <= 1e-9) continue;
      const t = f[0];
      const a = (st.s - exS) / (w + SHRINK[t]);
      sums[t] = (sums[t] ?? 0) + a;
      counts[t] = (counts[t] ?? 0) + 1;
      if (t === 'd' && Math.abs(a) > Math.abs(dirBest)) dirBest = a;
    }
    const mean = (t: string) => (counts[t] === undefined ? 0 : sums[t] / counts[t]);
    const root = (t: string) => (counts[t] === undefined ? 0 : sums[t] / Math.sqrt(counts[t] + 1));

    const near = this.nearest(film, self?.vec ?? this.vector(film), self);
    let ks = 0;
    let kw = 0;
    for (const [s, sim] of near) {
      ks += sim * s.w * (s.y - this.mean);
      kw += sim * s.w;
    }
    const knn = ks / (kw + 0.3);

    // TMDB recommendation graph: library films that recommend this one, or
    // that this one recommends.
    const nb = new Set<Sample>(this.recBy.get(film.id) ?? []);
    for (const r of film.recs) {
      const s = this.byId.get(r);
      if (s) nb.add(s);
    }
    if (self) nb.delete(self);
    let cs = 0;
    let cw = 0;
    for (const s of nb) {
      cs += s.w * (s.y - this.mean);
      cw += s.w;
    }
    return [mean('g'), root('k'), dirBest, root('c'), mean('y'), mean('l'), knn, cs / (cw + 1.5), Math.log(1 + nb.size), scoreOf(film) - 6.3, Math.log10(film.votes + 1) - 3.5];
  }

  predict(film: Film): Prediction {
    const self = this.byId.get(film.id);
    const x = this.features(film, self);
    let r = this.mean;
    if (this.learned) {
      const z = this.z(x);
      for (let j = 0; j < z.length; j++) r += this.beta[j] * z[j];
    } else {
      for (let j = 0; j < x.length; j++) if (!this.opt.drop.has(TasteModel.names[j])) r += this.beta[j] * x[j];
    }
    const near = this.nearest(film, self?.vec ?? this.vector(film), self);
    return { rating: clamp(r, 0.5, 5), neighbors: near.filter(([s]) => s.rated).map(([s, sim]) => ({ film: s.film, sim, rating: s.y })), x };
  }

  get weights(): Record<string, number> {
    return Object.fromEntries(TasteModel.names.map((n, j) => [n, this.beta[j]]));
  }

  /** Strongest likes/dislikes of one feature type (g, k, d, c, y, l), for prompts and stats. */
  top(type: string, n = 6, positive = true, minWeight = 2.5): string[] {
    const l: [string, number][] = [];
    for (const [f, st] of this.stats) {
      if (!f.startsWith(`${type}:`) || st.w < minWeight) continue;
      const a = st.s / (st.w + SHRINK[type]);
      if (positive ? a > 0.08 : a < -0.08) l.push([f.slice(2), a]);
    }
    l.sort((a, b) => (positive ? b[1] - a[1] : a[1] - b[1]));
    return l.slice(0, n).map(([f]) => {
      switch (type) {
        case 'g':
          return GENRES[+f] ?? f;
        case 'k':
          return this.kwNames.get(+f) ?? f;
        case 'y':
          return `${f}s`;
        case 'l':
          return LANGUAGES[f] ?? f;
        default:
          return f;
      }
    });
  }

  /** Keyword ids the user responds to most (for TMDB discover). */
  topKeywordIds(n = 8): number[] {
    const l: [number, number][] = [];
    for (const [f, st] of this.stats) {
      if (!f.startsWith('k:') || st.w < 2.5) continue;
      const a = st.s / (st.w + 2);
      if (a > 0.1) l.push([+f.slice(2), a * Math.log(1 + st.w)]);
    }
    l.sort((a, b) => b[1] - a[1]);
    return l.slice(0, n).map(([id]) => id);
  }
}

/** Solves a·x = b by Gaussian elimination with partial pivoting. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(a[r][i]) > Math.abs(a[p][i])) p = r;
    [a[i], a[p]] = [a[p], a[i]];
    [b[i], b[p]] = [b[p], b[i]];
    const d = a[i][i];
    if (Math.abs(d) < 1e-12) continue;
    for (let r = i + 1; r < n; r++) {
      const f = a[r][i] / d;
      if (f === 0) continue;
      for (let c = i; c < n; c++) a[r][c] -= f * a[i][c];
      b[r] -= f * b[i];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let c = i + 1; c < n; c++) s -= a[i][c] * x[c];
    x[i] = Math.abs(a[i][i]) < 1e-12 ? 0 : s / a[i][i];
  }
  return x;
}
