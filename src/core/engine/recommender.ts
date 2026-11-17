import { matchTitle } from '../letterboxd';
import { Llm, LlmError, extractJson, extractJsonLines } from '../llm';
import { Entry, Film, Library, decadeOf, genreNames, labelOf, scoreOf } from '../models';
import { FilmCache, Tmdb } from '../tmdb';
import { TasteBrief, ideationSystem, ideationSystemGeneric, ideationUser, judgeSystem, judgeSystemGeneric, judgeUser, requestBrief, tasteBrief, validateWhy } from './prompts';
import { Request, Services, copyRequest, hardFilterCount, hasPrompt, rejectReason, requestFromJson } from './request';
import { Prediction, TasteModel } from './taste';

export type Stage = 'taste' | 'scouting' | 'checking' | 'judging';
export const STAGES: Stage[] = ['taste', 'scouting', 'checking', 'judging'];

export interface Progress {
  stage: Stage;
  pool: number; // films under consideration
  posters: Film[]; // newly discovered candidates (for the wait screen)
  finalists?: Film[]; // sent once: the films that go to the judge
  verdict?: { id: number; r: number }; // sent as the judge rates each finalist
}

/** A library film that backs up an explanation, shown with the user's real rating. */
export interface Anchor {
  id: number;
  title: string;
  poster?: string;
}

export interface Pick {
  film: Film;
  predicted: number; // blended predicted stars for this user
  judge?: number; // LLM prediction
  local: number; // taste-model prediction
  match: number; // 0–10 fit to the request
  score: number; // ranking score
  why: string;
  anchors: Anchor[];
  facts: string[]; // verifiable one-liners
  personal: boolean;
}

const pickToJson = (p: Pick) => ({ ...p, film: undefined, id: p.film.id });
function pickFromJson(j: any, films: FilmCache): Pick | undefined {
  const film = films.get(j?.id);
  if (!film) return undefined;
  return {
    film,
    predicted: Number(j.predicted),
    judge: typeof j.judge === 'number' ? j.judge : undefined,
    local: Number(j.local),
    match: Number(j.match),
    score: Number(j.score),
    why: String(j.why ?? ''),
    anchors: Array.isArray(j.anchors) ? j.anchors : [],
    facts: Array.isArray(j.facts) ? j.facts : [],
    personal: j.personal !== false,
  };
}

/** One discovery run: the request, what was shown, and judged films held in reserve for "more". */
export class Session {
  picks: Pick[] = [];
  reserve: Pick[] = [];
  seen = new Set<number>(); // judged or rejected in this session
  suggested: string[] = []; // titles the LLM proposed so far
  notice?: string; // non-fatal problem worth telling the user
  rounds = 0;
  exhausted = false;
  constructor(readonly request: Request) {}

  toJson(): Record<string, unknown> {
    return {
      request: this.request,
      picks: this.picks.map(pickToJson),
      reserve: this.reserve.map(pickToJson),
      seen: [...this.seen],
      suggested: this.suggested,
      rounds: this.rounds,
    };
  }

  static fromJson(j: any, films: FilmCache): Session {
    const s = new Session(requestFromJson(j.request));
    const list = (k: string): Pick[] => ((j[k] ?? []) as any[]).map((p) => pickFromJson(p, films)).filter((p): p is Pick => !!p);
    s.picks = list('picks');
    s.reserve = list('reserve');
    s.seen = new Set(j.seen ?? []);
    s.suggested = [...(j.suggested ?? [])];
    s.rounds = j.rounds ?? 1;
    return s;
  }
}

export interface JudgeResult {
  r: number;
  m: number;
  why: string;
}

export interface EngineConfig {
  model: string;
  ideateEffort?: string;
  judgeEffort?: string;
  batch: number;
  judgeMax: number;
  judgeWeight: number; // share of the LLM in the blended prediction
}

export const engineConfig = (model: string, o: Partial<EngineConfig> = {}): EngineConfig => ({
  model,
  ideateEffort: 'low',
  judgeEffort: 'medium',
  batch: 8,
  judgeMax: 36,
  judgeWeight: 0.6,
  ...o,
});

interface Cand {
  id: number;
  film?: Film;
  graph: number;
  llm: boolean;
  seed: boolean;
  rank: number;
  quick: number;
  local: number;
  pred?: Prediction;
}

export type Idea = [title: string, year: number | undefined];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const generic = (f: Film) => clamp(3.3 + 0.55 * (scoreOf(f) - 6.3), 1, 5);

/** Familiar ↔ obscure preference as a soft score adjustment. */
function dial(f: Film, o: number): number {
  const w = Math.abs(o - 0.5) * 2;
  if (w < 0.1) return 0;
  const lv = Math.log10(f.votes + 1);
  const d = o < 0.5 ? Math.max(0, 4.2 - lv) : Math.max(0, lv - 2.4);
  return -0.45 * w * d;
}

/**
 * The recommendation pipeline: retrieve wide → enforce in code → judge with
 * the LLM → blend with the local taste model → diversify.
 */
export class Recommender {
  private cached?: TasteModel;
  private rev = -1;

  constructor(readonly tmdb: Tmdb, readonly llm: Llm, readonly lib: Library, public sv: Services, public cfg: EngineConfig) {}

  get films(): FilmCache {
    return this.tmdb.cache;
  }

  model(): TasteModel {
    if (!this.cached || this.rev !== this.lib.rev) {
      this.cached = TasteModel.fromLibrary(this.lib, this.films);
      this.rev = this.lib.rev;
    }
    return this.cached;
  }

  /** Taste modelling needs full TMDB records for every library film. */
  async ensureLibraryDetails(onProgress?: (done: number, total: number) => void): Promise<void> {
    const missing = [...this.lib.entries.keys()].filter((id) => this.films.get(id)?.full !== true);
    if (!missing.length) return;
    let done = 0;
    await this.tmdb.detailsAll(missing, this.sv.region, { providerMaxAgeDays: 36500, onEach: () => onProgress?.(++done, missing.length) });
    this.rev = -1;
  }

  async start(r: Request, onProgress?: (p: Progress) => void): Promise<Session> {
    const s = new Session(copyRequest(r));
    await this.more(s, onProgress);
    return s;
  }

  /** Appends the next batch to `s.picks`; returns how many were added. */
  async more(s: Session, onProgress?: (p: Progress) => void): Promise<number> {
    const good = s.reserve.filter((p) => p.predicted >= 3.5).length;
    if (good < this.cfg.batch && !s.exhausted && s.rounds < 8) {
      const before = s.seen.size;
      await this.round(s, onProgress ?? (() => {}));
      if (s.seen.size === before) s.exhausted = true;
    }
    const batch = this.take(s, this.cfg.batch);
    s.picks.push(...batch);
    return batch.length;
  }

  // ------------------------------------------------------------ LLM stages

  async ideate(r: Request, m: TasteModel | undefined, opts: { seed?: Film; already?: string[]; n?: number } = {}): Promise<{ picks: Idea[]; seeds: Idea[] }> {
    const count = opts.n ?? (r.streamingOnly || hardFilterCount(r) >= 3 ? 60 : 40);
    let taste: string;
    if (m) {
      taste = tasteBrief(this.lib, this.films, m).text;
    } else {
      const seen = this.lib
        .all()
        .filter((e) => (e.watched || e.notInterested) && this.films.get(e.id))
        .map((e) => labelOf(this.films.get(e.id)!));
      taste = seen.length ? `SEEN OR NOT INTERESTED: ${seen.slice(0, 400).join('; ')}` : '';
    }
    const text = await this.llm.respond({
      model: this.cfg.model,
      developer: m ? ideationSystem : ideationSystemGeneric,
      user: ideationUser(taste, requestBrief(r, this.sv, opts.seed), count, opts.already ?? []),
      effort: this.cfg.ideateEffort,
    });
    const j = extractJson(text);
    if (!j) throw new LlmError('bad_output', 'ideation output was not JSON');
    const list = (k: string): Idea[] =>
      ((Array.isArray(j[k]) ? j[k] : []) as any[])
        .filter((p) => p && typeof p.t === 'string' && p.t.trim())
        .map((p) => {
          const y = typeof p.y === 'number' ? Math.trunc(p.y) : parseInt(String(p.y), 10);
          return [p.t.trim(), Number.isFinite(y) ? y : undefined];
        });
    return { picks: list('picks'), seeds: list('seeds') };
  }

  /** Predicted rating, request fit and explanation for each candidate. */
  async judge(cands: Film[], request: string, brief?: TasteBrief, onVerdict?: (id: number, r: number) => void): Promise<Map<number, JudgeResult>> {
    // The answer arrives line by line; completed lines are reported as they come.
    let read = 0;
    const text = await this.llm.respond({
      model: this.cfg.model,
      developer: brief ? judgeSystem : judgeSystemGeneric,
      user: judgeUser(brief?.text ?? '', request, cands),
      effort: this.cfg.judgeEffort,
      onText: onVerdict
        ? (t) => {
            const end = t.lastIndexOf('\n');
            if (end <= read) return;
            for (const j of extractJsonLines(t.slice(read, end))) {
              const c = typeof j.c === 'number' ? Math.trunc(j.c) : NaN;
              if (c >= 1 && c <= cands.length && typeof j.r === 'number') onVerdict(cands[c - 1].id, clamp(j.r, 0.5, 5));
            }
            read = end;
          }
        : undefined,
    });
    let rows = extractJsonLines(text);
    if (rows.length < Math.floor(cands.length / 2)) {
      rows = [];
      for (const m of text.matchAll(/\{[^{}]*\}/g)) {
        try {
          rows.push(JSON.parse(m[0]));
        } catch {}
      }
    }
    const out = new Map<number, JudgeResult>();
    for (const j of rows) {
      const c = typeof j.c === 'number' ? Math.trunc(j.c) : parseInt(String(j.c).replace(/\D/g, ''), 10);
      if (!Number.isFinite(c) || c < 1 || c > cands.length || typeof j.r !== 'number') continue;
      out.set(cands[c - 1].id, { r: clamp(j.r, 0.5, 5), m: clamp(typeof j.m === 'number' ? j.m : 6, 0, 10), why: String(j.why ?? '') });
    }
    return out;
  }

  // ------------------------------------------------------------ one round

  private async round(s: Session, emit: (p: Progress) => void): Promise<void> {
    const r = s.request;
    const lib = this.lib;
    const films = this.films;
    s.rounds++;
    s.notice = undefined;
    emit({ stage: 'taste', pool: 0, posters: [] });
    await this.ensureLibraryDetails();
    const m = r.personalize && lib.entries.size > 0 ? this.model() : undefined;
    const seed = r.seedId !== undefined ? await this.tmdb.details(r.seedId, this.sv.region) : undefined;
    const shown = new Set<number>([...s.seen, ...s.picks.map((p) => p.film.id), ...s.reserve.map((p) => p.film.id)]);

    const cands = new Map<number, Cand>();
    const c = (id: number): Cand => {
      let x = cands.get(id);
      if (!x) cands.set(id, (x = { id, graph: 0, llm: false, seed: false, rank: 1 << 20, quick: 0, local: 0 }));
      return x;
    };
    const postered = new Set<number>();
    const show = (stage: Stage, fs: Iterable<Film | undefined>) => {
      const posters: Film[] = [];
      for (const f of fs) {
        // Only films that can still make it: the wait screen shows real candidates.
        if (f && f.poster && !postered.has(f.id) && rejectReason(f, r, lib, this.sv, { shown, listLevel: true }) === undefined) {
          postered.add(f.id);
          posters.push(f);
        }
      }
      emit({ stage, pool: cands.size, posters });
    };

    // 1) LLM scouting runs while TMDB retrieval happens.
    const ideasP = this.ideate(r, m, { seed, already: [...s.suggested, ...s.picks.map((p) => labelOf(p.film))] });
    ideasP.catch(() => {});

    // 2) TMDB's recommendation graph around the films the user loves most.
    if (m) {
      const anchors = m.samples.filter((x) => x.rated && x.y >= Math.max(4.0, m.mean + 0.25)).sort((a, b) => b.y * b.w - a.y * a.w);
      for (const a of anchors.slice(0, 24)) for (const id of a.film.recs) c(id).graph += a.w * (a.y - m.mean);
    }
    if (seed) {
      const rel = await Promise.all([this.tmdb.similar(seed.id).catch(() => [] as Film[]), this.tmdb.recommendations(seed.id, 2).catch(() => [] as Film[])]);
      for (const id of [...seed.recs, ...rel.flat().map((f) => f.id)]) c(id).seed = true;
    }
    show('scouting', [...cands.keys()].map((id) => films.get(id)));

    // 3) TMDB discover with the request's filters.
    const found = await Promise.all(this.discover(r, m).map((p) => p.catch(() => [] as Film[])));
    for (const l of found) {
      for (const f of l) c(f.id);
      show('scouting', l);
    }

    // 4) Resolve the LLM's ideas to real TMDB films; anything unknown is dropped.
    let ideas: { picks: Idea[]; seeds: Idea[] } = { picks: [], seeds: [] };
    try {
      ideas = await ideasP;
    } catch (e) {
      if (!(e instanceof LlmError)) throw e;
      if (e.needsSignIn) throw e;
      s.notice = e.friendly;
    }
    const resolved = await Promise.all(ideas.picks.map((p) => matchTitle(this.tmdb, p[0], p[1]).catch(() => undefined)));
    resolved.forEach((f, i) => {
      if (!f) return;
      const x = c(f.id);
      x.llm = true;
      x.rank = Math.min(x.rank, i);
    });
    s.suggested.push(...ideas.picks.map((p) => (p[1] === undefined ? p[0] : `${p[0]} (${p[1]})`)));
    show('scouting', resolved);
    // Films the request itself names ("like Past Lives"): add their neighbourhood.
    for (const sd of ideas.seeds.slice(0, 3)) {
      try {
        const f = await matchTitle(this.tmdb, sd[0], sd[1]);
        if (!f) continue;
        for (const id of (await this.tmdb.details(f.id, this.sv.region)).recs) c(id).seed = true;
      } catch {}
    }

    // 5) Screen on list-level data, then fetch details for the most promising.
    const screened: Cand[] = [];
    for (const x of cands.values()) {
      const f = films.get(x.id);
      if (f) {
        if (rejectReason(f, r, lib, this.sv, { shown, listLevel: true }) !== undefined) continue;
        x.quick = this.quick(f, x, m, r);
      } else {
        const e = lib.get(x.id);
        if (shown.has(x.id) || e?.notInterested === true || (r.excludeWatched && e?.watched === true)) continue;
        x.quick = 3.0 + (x.seed ? 0.6 : 0);
      }
      screened.push(x);
    }
    const viaLlm = screened.filter((x) => x.llm).sort((a, b) => a.rank - b.rank);
    const rest = screened.filter((x) => !x.llm).sort((a, b) => b.quick - a.quick);
    const toDetail = [...viaLlm.slice(0, 60), ...rest.slice(0, Math.max(30, 90 - viaLlm.length))];
    emit({ stage: 'checking', pool: toDetail.length, posters: [] });
    await this.tmdb.detailsAll(toDetail.map((x) => x.id), this.sv.region, { onEach: (f) => show('checking', [f]) });

    // 6) Hard filters on full records. Nothing gets past this point otherwise.
    const ok: Cand[] = [];
    for (const x of toDetail) {
      const f = films.get(x.id);
      if (!f || !f.full || rejectReason(f, r, lib, this.sv, { shown }) !== undefined) {
        s.seen.add(x.id);
        continue;
      }
      x.film = f;
      x.pred = m?.predict(f);
      x.local = x.pred?.rating ?? generic(f);
      x.quick = x.local + this.bonus(x, f, r);
      ok.push(x);
    }

    // 7) The LLM judges the best ~36: its own ideas plus the strongest others.
    const okLlm = ok.filter((x) => x.llm).sort((a, b) => a.rank - b.rank);
    const okRest = ok.filter((x) => !x.llm).sort((a, b) => b.quick - a.quick);
    const max = this.cfg.judgeMax;
    const nLlm = Math.min(okLlm.length, Math.max(Math.round(max * 0.7), max - okRest.length));
    const toJudge = [...okLlm.slice(0, nLlm), ...okRest.slice(0, max - nLlm)];
    emit({ stage: 'judging', pool: toJudge.length, posters: [], finalists: toJudge.map((x) => x.film!) });
    const brief = m ? tasteBrief(lib, films, m, { tagged: true, listSeen: false }) : undefined;
    let verdicts = new Map<number, JudgeResult>();
    if (toJudge.length) {
      try {
        verdicts = await this.judge(toJudge.map((x) => x.film!), requestBrief(r, this.sv, seed), brief, (id, rating) =>
          emit({ stage: 'judging', pool: toJudge.length, posters: [], verdict: { id, r: rating } }),
        );
      } catch (e) {
        if (!(e instanceof LlmError)) throw e;
        if (e.needsSignIn) throw e;
        s.notice = e.friendly;
      }
    }

    // 8) Blend, explain, keep.
    for (const x of toJudge) {
      s.seen.add(x.id);
      const p = this.pick(x, verdicts.get(x.id), brief, r, seed !== undefined);
      if (p) s.reserve.push(p);
    }
    s.reserve.sort((a, b) => b.score - a.score);
  }

  private discover(r: Request, m: TasteModel | undefined): Promise<Film[]>[] {
    const today = new Date().toISOString().slice(0, 10);
    const sv = this.sv;
    const base: Record<string, string> = {
      'primary_release_date.lte': r.yearMax !== undefined && `${r.yearMax}-12-31` < today ? `${r.yearMax}-12-31` : today,
      'with_runtime.gte': String(r.runMin ?? 40),
    };
    if (r.genres.length) base.with_genres = r.genres.join(',');
    if (r.notGenres.length) base.without_genres = r.notGenres.join(',');
    if (r.yearMin !== undefined) base['primary_release_date.gte'] = `${r.yearMin}-01-01`;
    if (r.runMax !== undefined) base['with_runtime.lte'] = String(r.runMax);
    if (r.langs.length === 1) base.with_original_language = r.langs[0];
    if (r.streamingOnly && sv.ids.length) {
      base.watch_region = sv.region;
      base.with_watch_providers = sv.ids.join('|');
      base.with_watch_monetization_types = 'flatrate|free|ads';
    }
    const o = r.obscurity;
    const floor = o < 0.33 ? 2000 : o <= 0.66 ? 200 : 40;
    const quality: Record<string, string> = { ...base, sort_by: 'vote_average.desc', 'vote_count.gte': String(floor) };
    if (o > 0.66) quality['vote_count.lte'] = '3000';
    const out = [this.tmdb.discover(quality), this.tmdb.discover(quality, 2)];
    if (o <= 0.66) out.push(this.tmdb.discover({ ...base, sort_by: 'popularity.desc', 'vote_count.gte': String(floor), 'vote_average.gte': '6.5' }));
    if (hardFilterCount(r) > 0) out.push(this.tmdb.discover(quality, 3));
    const kws = m?.topKeywordIds() ?? [];
    if (kws.length) {
      out.push(this.tmdb.discover({ ...base, with_keywords: kws.join('|'), sort_by: 'vote_average.desc', 'vote_count.gte': String(Math.max(60, Math.floor(floor / 3))) }));
    }
    if (r.langs.length > 1) for (const l of r.langs.slice(0, 4)) out.push(this.tmdb.discover({ ...quality, with_original_language: l }));
    return out;
  }

  private bonus(x: Cand, f: Film, r: Request): number {
    return 0.35 * Math.tanh(x.graph / 2) + (x.seed ? 0.6 : 0) + dial(f, r.obscurity) + (this.lib.get(f.id)?.watchlist === true ? 0.15 : 0);
  }

  private quick(f: Film, x: Cand, m: TasteModel | undefined, r: Request): number {
    return (m?.predict(f).rating ?? generic(f)) + this.bonus(x, f, r);
  }

  private pick(x: Cand, j: JudgeResult | undefined, brief: TasteBrief | undefined, r: Request, seeded: boolean): Pick | undefined {
    const f = x.film!;
    const lib = this.lib;
    const films = this.films;
    const needMatch = hasPrompt(r) || seeded;
    const match = j?.m ?? (x.llm || x.seed ? 7 : 6);
    if (j && j.r < 3.0) return undefined; // the judge expects a miss
    if (needMatch && j && match < 5) return undefined; // does not honour the request
    const predicted = j ? this.cfg.judgeWeight * j.r + (1 - this.cfg.judgeWeight) * x.local : x.local;
    const score = predicted + (needMatch ? 0.22 : 0.08) * (match - 7) + dial(f, r.obscurity) + (lib.get(f.id)?.watchlist === true ? 0.15 : 0);

    const why = j ? validateWhy(j.why, brief?.tags ?? {}, lib, films) : undefined;
    const anchor = (id: number): Anchor => ({ id, title: films.get(id)!.title, poster: films.get(id)!.poster });
    let anchors = (why?.refs ?? []).map(anchor);
    if (!anchors.length && x.pred) {
      anchors = x.pred.neighbors
        .filter((n) => n.rating >= 4 && n.sim >= 0.18)
        .slice(0, 2)
        .map((n) => anchor(n.film.id));
    }
    let text = why?.text;
    if (!text) {
      text = anchors.length
        ? `Has a lot in common with ${anchors.map((a) => a.title).join(' and ')}, which you rated highly.`
        : `A well-regarded ${genreNames(f).slice(0, 2).join(' / ').toLowerCase()} film: TMDB users give it ${f.vote.toFixed(1)}.`;
    }
    return { film: f, predicted: clamp(predicted, 0.5, 5), judge: j?.r, local: x.local, match, score, why: text, anchors, facts: this.facts(f), personal: brief !== undefined };
  }

  /** Short, verifiable facts linking a film to the user's library. */
  private facts(f: Film): string[] {
    const out: string[] = [];
    const lib = this.lib;
    const films = this.films;
    if (lib.get(f.id)?.watchlist === true) out.push('On your watchlist');
    const best = (test: (lf: Film) => boolean): Entry | undefined => {
      let b: Entry | undefined;
      for (const en of lib.rated) {
        const lf = films.get(en.id);
        if (!lf || lf.id === f.id || en.rating! < 4 || !test(lf)) continue;
        if (!b || en.rating! > b.rating!) b = en;
      }
      return b;
    };
    for (const d of f.directors.slice(0, 1)) {
      const b = best((lf) => lf.directors.includes(d));
      if (b) out.push(`From ${d}, director of ${films.get(b.id)!.title}`);
    }
    if (out.length < 2) {
      for (const a of f.cast.slice(0, 2)) {
        const b = best((lf) => lf.cast.slice(0, 4).includes(a));
        if (b) {
          out.push(`With ${a} from ${films.get(b.id)!.title}`);
          break;
        }
      }
    }
    return out;
  }

  /**
   * Picks the next batch from the reserve, best first, but spread out:
   * a second film by the same director or a near-twin is pushed back.
   */
  private take(s: Session, n: number): Pick[] {
    const out: Pick[] = [];
    while (out.length < n && s.reserve.length) {
      let best = 0;
      let bestScore = -Infinity;
      s.reserve.forEach((p, i) => {
        let sc = p.score;
        for (const q of out) {
          if (p.film.directors.some((d) => q.film.directors.includes(d))) sc -= 0.5;
          if (p.film.genres.filter((g) => q.film.genres.includes(g)).length >= 2 && decadeOf(p.film) === decadeOf(q.film)) sc -= 0.12;
        }
        if (sc > bestScore) {
          bestScore = sc;
          best = i;
        }
      });
      out.push(s.reserve.splice(best, 1)[0]);
    }
    return out;
  }
}
