import { matchTitle } from '../letterboxd';
import { LlmClient, LlmError } from '../llm';
import { Entry, Film, Library, genreNames, labelOf, scoreOf } from '../models';
import { FilmCache, Tmdb } from '../tmdb';
import { ENTRY, Idea, PROPOSE_ROLE, RATE_ROLE, STAR_PAIR, WHY_ROLE, ideaOf, parsePicks, parseStars, proposeUser, rateUser, ratingsBlock, reader, validateWhy, whyUser, wishLine } from './prompts';
import { Request, Services, copyRequest, hardFilterCount, rejectReason, requestFromJson } from './request';

export type Stage = 'taste' | 'scouting' | 'checking' | 'judging';
export const STAGES: Stage[] = ['taste', 'scouting', 'checking', 'judging'];

export interface Progress {
  stage: Stage;
  pool: number; // films under consideration
  posters: Film[]; // newly found candidates (for the wait screen)
  finalists?: Film[]; // sent once: the films whose rating is being predicted
  verdict?: { id: number; r: number }; // sent as each predicted rating comes in
}

/** A library film that backs up an explanation, shown with the user's real rating. */
export interface Anchor {
  id: number;
  title: string;
  poster?: string;
}

export interface Pick {
  film: Film;
  predicted?: number; // the stars the LLM expects this user to give; undefined when it gave none
  why?: string; // why it fits; undefined until it has been written (see Recommender.explain)
  anchors: Anchor[]; // the user's own films the reason points to
  facts: string[]; // verifiable one-liners
  personal: boolean; // chosen from the user's ratings
  fresh?: boolean; // a new release: the LLM was told its facts
}

const pickToJson = (p: Pick) => ({ ...p, film: undefined, id: p.film.id });
function pickFromJson(j: any, films: FilmCache): Pick | undefined {
  const film = films.get(j?.id);
  if (!film) return undefined;
  return {
    film,
    predicted: typeof j.predicted === 'number' ? j.predicted : undefined,
    why: typeof j.why === 'string' ? j.why : undefined,
    anchors: Array.isArray(j.anchors) ? j.anchors : [],
    facts: Array.isArray(j.facts) ? j.facts : [],
    personal: j.personal !== false,
    fresh: j.fresh === true ? true : undefined,
  };
}

/** One discovery run: the request and every film found for it, best first. */
export class Session {
  picks: Pick[] = []; // the feed scrolls through all of them
  seen = new Set<number>(); // films this session has already looked at, kept or not
  suggested: string[] = []; // titles the LLM proposed so far
  notice?: string; // non-fatal problem worth telling the user
  rounds = 0;
  exhausted = false; // the last round brought nothing new
  constructor(readonly request: Request) {}

  toJson(): Record<string, unknown> {
    return {
      request: this.request,
      picks: this.picks.map(pickToJson),
      seen: [...this.seen],
      suggested: this.suggested,
      rounds: this.rounds,
    };
  }

  static fromJson(j: any, films: FilmCache): Session {
    const s = new Session(requestFromJson(j.request));
    const list = (k: string): Pick[] => ((j[k] ?? []) as any[]).map((p) => pickFromJson(p, films)).filter((p): p is Pick => !!p);
    // Older versions showed eight films at a time and held the rest in a reserve.
    s.picks = [...list('picks'), ...list('reserve')];
    s.seen = new Set(j.seen ?? []);
    s.suggested = [...(j.suggested ?? [])];
    s.rounds = j.rounds ?? 1;
    return s;
  }
}

export interface EngineConfig {
  model: string;
  effort?: string; // reasoning effort of every call
  propose: number; // how many films question 1 asks for
  batch: number; // films per reasons call
}

export const engineConfig = (model: string, o: Partial<EngineConfig> = {}): EngineConfig => ({ model, effort: 'low', propose: 60, batch: 8, ...o });

/** With filters on and fewer films than this left, TMDB fills the list up. */
const ENOUGH = 30;
/** A film predicted below this is not a recommendation. */
export const MISS = 3;
/** The LLM knows no film released after this day (asked in November 2026: the same for every model tried). */
export const KNOWN_UNTIL = '2024-06-30';
/** How many new releases are put to the LLM, from which predicted rating they are worth showing, and how often one comes up at least. */
const FRESH = 30;
const FRESH_MIN = 3.5;
const FRESH_EVERY = 4;
const MAX_ROUNDS = 8;

interface Rated {
  film: Film;
  stars?: number;
  fresh?: boolean;
}

/**
 * The recommendation engine: the LLM proposes films from the user's ratings, code looks them up
 * on TMDB and applies the filters, the LLM predicts the user's rating for each film that is
 * left, and the list is sorted by that rating. Reasons are written later, a few films at a time.
 */
export class Recommender {
  private explaining = new Set<Session>();
  private wanted = new WeakMap<Session, number>();

  constructor(readonly tmdb: Tmdb, readonly llm: LlmClient, readonly lib: Library, public sv: Services, public cfg: EngineConfig) {}

  get films(): FilmCache {
    return this.tmdb.cache;
  }

  /** Every library film needs its TMDB record: the title and year for the questions, director and cast for the facts. */
  async ensureLibraryDetails(onProgress?: (done: number, total: number) => void): Promise<void> {
    const missing = [...this.lib.entries.keys()].filter((id) => this.films.get(id)?.full !== true);
    if (!missing.length) return;
    let done = 0;
    await this.tmdb.detailsAll(missing, this.sv.region, { providerMaxAgeDays: 36500, onEach: () => onProgress?.(++done, missing.length) });
  }

  async start(r: Request, onProgress?: (p: Progress) => void): Promise<Session> {
    const s = new Session(copyRequest(r));
    await this.more(s, onProgress);
    return s;
  }

  /** One more round of new films, added after the ones already there; returns how many it brought. */
  async more(s: Session, onProgress?: (p: Progress) => void): Promise<number> {
    if (s.exhausted || s.rounds >= MAX_ROUNDS) return 0;
    const before = s.picks.length;
    await this.round(s, onProgress ?? (() => {}));
    const added = s.picks.length - before;
    if (!added) s.exhausted = true;
    return added;
  }

  // ------------------------------------------------------------ one round

  private async round(s: Session, emit: (p: Progress) => void): Promise<void> {
    const r = s.request;
    const { lib, films, sv, cfg } = this;
    s.rounds++;
    s.notice = undefined;
    let stage: Stage = 'taste';
    emit({ stage, pool: 0, posters: [] });
    await this.ensureLibraryDetails();
    const seed = r.seedId !== undefined ? await this.tmdb.details(r.seedId, sv.region) : undefined;
    const ratings = r.personalize ? ratingsBlock(lib, films).text : '';
    const personal = ratings.length > 0;
    const wish = wishLine(r, seed);
    const shown = new Set<number>([...s.seen, ...s.picks.map((p) => p.film.id)]);
    const looked = new Set<number>();

    // New releases are fetched and rated on the side while the two questions run: when asked for,
    // and when the year filter starts after everything the LLM knows.
    const wantFresh = r.recent || (r.yearMin !== undefined && `${r.yearMin}-01-01` > KNOWN_UNTIL);
    const freshP = wantFresh ? this.fresh(r, ratings, wish, shown) : Promise.resolve<Rated[]>([]);
    freshP.catch(() => {});

    // 1) Which films would this person love? Each title is looked up on TMDB the moment the
    //    LLM has written it, so most lookups are done when the answer ends.
    stage = 'scouting';
    emit({ stage, pool: 0, posters: [] });
    const lookups = new Map<string, Promise<Film | undefined>>();
    const lookup = (idea: Idea): Promise<Film | undefined> => {
      const key = `${idea.t.toLowerCase()}|${idea.y ?? ''}`;
      let p = lookups.get(key);
      if (!p) {
        p = this.find(idea, r, shown, looked, (f) => emit({ stage, pool: lookups.size, posters: [f] }));
        lookups.set(key, p);
      }
      return p;
    };
    const propose = async (): Promise<Idea[]> => {
      const text = await this.llm.respond({
        model: cfg.model,
        developer: PROPOSE_ROLE,
        user: proposeUser(ratings, r, sv, cfg.propose, { seed, avoid: this.avoid(s, r) }),
        effort: cfg.effort,
        onText: reader(ENTRY, (m) => {
          try {
            const idea = ideaOf(JSON.parse(m[0]));
            if (idea) void lookup(idea);
          } catch {}
        }),
      });
      return parsePicks(text);
    };
    let ideas = await propose();
    // Rarely the answer comes back far too short or as broken JSON: ask once more.
    // (With a request or a filter, a short list can be all there is.)
    const narrow = wish !== '' || hardFilterCount(r) > 0;
    if (ideas.length < (narrow ? 1 : cfg.propose / 2)) {
      const again = await propose();
      if (again.length > ideas.length) ideas = again;
    }
    if (!ideas.length) throw new LlmError('bad_output', 'the answer named no films');
    s.suggested.push(...ideas.map((i) => (i.y === undefined ? i.t : `${i.t} (${i.y})`)));

    // 2) The filters, on full TMDB records. Nothing gets past this point otherwise.
    stage = 'checking';
    emit({ stage, pool: ideas.length, posters: [] });
    const found = await Promise.all(ideas.map(lookup));
    const cands: Film[] = [];
    const taken = new Set<number>();
    for (const f of found) {
      if (!f || taken.has(f.id)) continue;
      taken.add(f.id);
      if (rejectReason(f, r, lib, sv, { shown }) === undefined) cands.push(f);
    }
    if (cands.length < ENOUGH && hardFilterCount(r) > 0) {
      // The filters left too few of the LLM's own ideas: TMDB adds well-rated films that pass them.
      const extra = await this.fill(r, s.rounds, new Set([...shown, ...looked]), cfg.propose - cands.length);
      for (const f of extra) looked.add(f.id);
      cands.push(...extra);
      emit({ stage, pool: cands.length, posters: extra });
    }

    // 3) How would this person rate each one?
    stage = 'judging';
    emit({ stage, pool: cands.length, posters: [], finalists: cands });
    const stars = new Map<number, number>();
    if (personal) {
      // A film the user has rated (possible when rewatches are allowed) keeps their own rating.
      for (const f of cands) {
        const own = lib.get(f.id)?.rating;
        if (own !== undefined) stars.set(f.id, own);
      }
      const ask = cands.filter((f) => !stars.has(f.id));
      const rate = async (): Promise<Map<number, number>> => {
        const text = await this.llm.respond({
          model: cfg.model,
          developer: RATE_ROLE,
          user: rateUser(ratings, ask, { wish }),
          effort: cfg.effort,
          onText: reader(STAR_PAIR, (m) => {
            const f = ask[Number(m[1]) - 1];
            if (f) emit({ stage, pool: cands.length, posters: [], verdict: { id: f.id, r: Number(m[2]) } });
          }),
        });
        return parseStars(text, ask.length);
      };
      if (ask.length) {
        try {
          let got = await rate();
          if (got.size < ask.length / 2) {
            const again = await rate();
            if (again.size > got.size) got = again;
          }
          for (const [i, v] of got) stars.set(ask[i].id, v);
        } catch (e) {
          if (!(e instanceof LlmError) || e.needsSignIn) throw e;
          s.notice = e.friendly; // the films stay in the order the LLM proposed them
        }
      }
    }

    // 4) Sort by predicted rating; equal ratings keep the order the LLM proposed them in.
    const byStars = (l: Rated[]): Rated[] =>
      l
        .map((x, i) => ({ x, i }))
        .sort((a, b) => (b.x.stars ?? -1) - (a.x.stars ?? -1) || a.i - b.i)
        .map((e) => e.x);
    let list: Rated[] = cands.map((film) => ({ film, stars: stars.get(film.id) }));
    if (stars.size) list = byStars(list.filter((x) => x.stars === undefined || x.stars >= MISS));
    const fresh = (await freshP).filter((x) => !looked.has(x.film.id));
    for (const x of fresh) looked.add(x.film.id);
    if (personal) {
      // New releases are what the switch is for, so at least every fourth film is one, best predicted first.
      // One whose predicted rating puts it earlier goes there, ahead of older films rated the same.
      const news = byStars(fresh.filter((x) => (x.stars ?? 0) >= FRESH_MIN));
      const old = list;
      list = [];
      for (let i = 0, since = 0; i < old.length || news.length; ) {
        const next = old[i];
        const earns = next?.stars !== undefined && (news[0]?.stars ?? 0) >= next.stars;
        if (news.length && (!next || earns || since >= FRESH_EVERY - 1)) {
          list.push(news.shift()!);
          since = 0;
        } else {
          list.push(next);
          i++;
          since++;
        }
      }
    } else {
      // Nothing to predict from: the best-rated new releases are spread through the list.
      const add = fresh.slice(0, 10);
      list = list.flatMap((x, i) => (i % 3 === 1 && add.length ? [x, add.shift()!] : [x]));
      list.push(...add);
    }
    for (const x of list) s.picks.push({ film: x.film, predicted: x.stars, anchors: [], facts: this.facts(x.film), personal, fresh: x.fresh });
    for (const id of looked) s.seen.add(id);
  }

  /** A title the LLM wrote -> the real film with full details, or undefined when there is none or it cannot be shown anyway. */
  private async find(idea: Idea, r: Request, shown: Set<number>, looked: Set<number>, onFound: (f: Film) => void): Promise<Film | undefined> {
    try {
      const f = await matchTitle(this.tmdb, idea.t, idea.y);
      if (!f) return undefined;
      looked.add(f.id);
      if (rejectReason(f, r, this.lib, this.sv, { shown, listLevel: true }) !== undefined) return undefined;
      if (f.poster) onFound(f);
      return await this.tmdb.details(f.id, this.sv.region);
    } catch {
      return undefined;
    }
  }

  /** Films that must not come back, for the LLM: proposed before, seen without a rating, dismissed, and the watchlist when it is hidden. */
  private avoid(s: Session, r: Request): string[] {
    const recent = (at: (e: Entry) => number | undefined) => (a: Entry, b: Entry) => (at(b) ?? 0) - (at(a) ?? 0);
    const all = this.lib.all();
    const own = [
      ...(r.excludeWatched ? all.filter((e) => e.watched && e.rating === undefined).sort(recent((e) => e.watchedAt)) : []),
      ...all.filter((e) => e.notInterested).sort(recent((e) => e.niAt)),
      ...(r.excludeWatchlist ? all.filter((e) => e.watchlist).sort(recent((e) => e.watchlistAt)) : []),
    ];
    const names = own.map((e) => this.films.get(e.id)).filter((f): f is Film => !!f).map(labelOf);
    return [...new Set([...s.suggested, ...names])].slice(0, 400);
  }

  // ------------------------------------------------------ films from TMDB

  /** The request's filters as a TMDB discover query. */
  private query(r: Request): Record<string, string> {
    const today = new Date().toISOString().slice(0, 10);
    const sv = this.sv;
    const q: Record<string, string> = {
      'primary_release_date.lte': r.yearMax !== undefined && `${r.yearMax}-12-31` < today ? `${r.yearMax}-12-31` : today,
      'with_runtime.gte': String(r.runMin ?? 40),
    };
    if (r.genres.length) q.with_genres = r.genres.join(',');
    if (r.notGenres.length) q.without_genres = r.notGenres.join(',');
    if (r.yearMin !== undefined) q['primary_release_date.gte'] = `${r.yearMin}-01-01`;
    if (r.runMax !== undefined) q['with_runtime.lte'] = String(r.runMax);
    if (r.langs.length === 1) q.with_original_language = r.langs[0];
    if (r.streamingOnly && sv.ids.length) {
      q.watch_region = sv.region;
      q.with_watch_providers = sv.ids.join('|');
      q.with_watch_monetization_types = 'flatrate|free|ads';
    }
    return q;
  }

  /** TMDB lists -> at most `n` films that pass every filter, best TMDB score first. */
  private async vet(lists: Promise<Film[]>[], r: Request, skip: Set<number>, n: number): Promise<Film[]> {
    const all = (await Promise.all(lists.map((p) => p.catch(() => [] as Film[])))).flat();
    const ok = [...new Map(all.map((f) => [f.id, f])).values()]
      .filter((f) => !skip.has(f.id) && rejectReason(f, r, this.lib, this.sv, { listLevel: true }) === undefined)
      .sort((a, b) => scoreOf(b) - scoreOf(a));
    const full = await this.tmdb.detailsAll(ok.slice(0, n + 12).map((f) => f.id), this.sv.region);
    return full.filter((f) => rejectReason(f, r, this.lib, this.sv) === undefined).slice(0, n);
  }

  /**
   * Well-rated films that pass the filters, for when the filters leave too few of the LLM's ideas.
   * Only films the LLM can know: it rates them by their title alone.
   */
  private async fill(r: Request, round: number, skip: Set<number>, n: number): Promise<Film[]> {
    const q = this.query(r);
    if (q['primary_release_date.lte'] > KNOWN_UNTIL) q['primary_release_date.lte'] = KNOWN_UNTIL;
    if ((q['primary_release_date.gte'] ?? '') > KNOWN_UNTIL) return [];
    const o = r.obscurity;
    const floor = o < 0.33 ? 2000 : o <= 0.66 ? 200 : 40;
    const best: Record<string, string> = { ...q, sort_by: 'vote_average.desc', 'vote_count.gte': String(floor) };
    if (o > 0.66) best['vote_count.lte'] = '3000';
    const lists = [this.tmdb.discover(best, 2 * round - 1), this.tmdb.discover(best, 2 * round)];
    if (o <= 0.66) lists.push(this.tmdb.discover({ ...q, sort_by: 'popularity.desc', 'vote_count.gte': String(floor), 'vote_average.gte': '6.5' }, round));
    if (r.langs.length > 1) for (const l of r.langs.slice(0, 4)) lists.push(this.tmdb.discover({ ...best, with_original_language: l }, round));
    return this.vet(lists, r, skip, n);
  }

  /**
   * New releases: films from after the LLM's training that pass the filters. The LLM cannot know
   * them, so it gets their facts and predicts the user's rating from those.
   */
  private async fresh(r: Request, ratings: string, wish: string, skip: Set<number>): Promise<Rated[]> {
    const q = this.query(r);
    const from = new Date(Date.parse(KNOWN_UNTIL) + 86400000).toISOString().slice(0, 10);
    if (q['primary_release_date.lte'] < from) return []; // the year filter ends before any new release
    if (!q['primary_release_date.gte'] || q['primary_release_date.gte'] < from) q['primary_release_date.gte'] = from;
    const lists = [
      this.tmdb.discover({ ...q, sort_by: 'vote_average.desc', 'vote_count.gte': '150' }),
      this.tmdb.discover({ ...q, sort_by: 'popularity.desc', 'vote_count.gte': '100', 'vote_average.gte': '6.5' }),
    ];
    const films = await this.vet(lists, r, skip, FRESH);
    if (!films.length || !ratings) return films.map((film) => ({ film, fresh: true }));
    try {
      const text = await this.llm.respond({ model: this.cfg.model, developer: RATE_ROLE, user: rateUser(ratings, films, { wish, facts: true }), effort: this.cfg.effort });
      const stars = parseStars(text, films.length);
      return films.map((film, i) => ({ film, stars: stars.get(i), fresh: true }));
    } catch (e) {
      if (!(e instanceof LlmError) || e.needsSignIn) throw e;
      return []; // the search goes on without new releases
    }
  }

  // -------------------------------------------------------------- reasons

  /**
   * Writes the missing reasons among the first `upTo` films, one small call per batch. The feed
   * asks for the films on screen and the batch after them, so a reason is there before its film is.
   */
  async explain(s: Session, upTo: number, onSome?: () => void): Promise<void> {
    this.wanted.set(s, Math.max(this.wanted.get(s) ?? 0, upTo));
    if (this.explaining.has(s)) return;
    this.explaining.add(s);
    try {
      for (;;) {
        const todo = s.picks.slice(0, this.wanted.get(s)).filter((p) => p.why === undefined).slice(0, this.cfg.batch);
        if (!todo.length) break;
        await this.reasons(s, todo, onSome);
      }
    } finally {
      this.explaining.delete(s);
    }
  }

  private async reasons(s: Session, todo: Pick[], onSome?: () => void): Promise<void> {
    const r = s.request;
    const { lib, films } = this;
    const block = r.personalize ? ratingsBlock(lib, films, { tagged: true }) : { text: '', tags: {} };
    const seed = r.seedId !== undefined ? films.get(r.seedId) : undefined;
    const anchor = (id: number): Anchor => ({ id, title: films.get(id)!.title, poster: films.get(id)!.poster });
    // Each reason is checked and shown as soon as its line is complete.
    const read = reader(ENTRY, (m) => {
      try {
        const j = JSON.parse(m[0]);
        const p = todo[Number(j.n) - 1];
        const why = p && p.why === undefined && typeof j.why === 'string' ? validateWhy(j.why, block.tags, lib, films) : undefined;
        if (!p || !why) return;
        p.why = why.text;
        p.anchors = why.refs.map(anchor);
        onSome?.();
      } catch {}
    });
    try {
      const user = whyUser(block.text, todo.map((p) => ({ film: p.film, facts: p.fresh })), wishLine(r, seed));
      read(await this.llm.respond({ model: this.cfg.model, developer: WHY_ROLE, user, effort: this.cfg.effort, onText: read }));
    } catch (e) {
      if (!(e instanceof LlmError)) throw e;
    }
    // No usable reason for a film (or no answer at all): say what can be said for certain.
    for (const p of todo) p.why ??= `A well-regarded ${genreNames(p.film).slice(0, 2).join(' / ').toLowerCase()} film: TMDB users give it ${p.film.vote.toFixed(1)}.`.replace('  ', ' ');
    onSome?.();
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
}
