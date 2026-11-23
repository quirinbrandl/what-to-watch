// Core data model. Everything under src/core is plain TypeScript with no
// React Native or Expo imports, so the same code runs in the app and in the
// offline evaluation CLI (Node).

export const nowSec = (): number => Math.floor(Date.now() / 1000);

export const GENRES: Record<number, string> = {
  28: 'Action',
  12: 'Adventure',
  16: 'Animation',
  35: 'Comedy',
  80: 'Crime',
  99: 'Documentary',
  18: 'Drama',
  10751: 'Family',
  14: 'Fantasy',
  36: 'History',
  27: 'Horror',
  10402: 'Music',
  9648: 'Mystery',
  10749: 'Romance',
  878: 'Sci-Fi',
  53: 'Thriller',
  10752: 'War',
  37: 'Western',
};
/** Genre ids in display order. */
export const GENRE_IDS = [28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 10402, 9648, 10749, 878, 53, 10752, 37];

export const LANGUAGES: Record<string, string> = {
  en: 'English',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  it: 'Italian',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Mandarin',
  cn: 'Cantonese',
  hi: 'Hindi',
  pt: 'Portuguese',
  sv: 'Swedish',
  da: 'Danish',
  no: 'Norwegian',
  nl: 'Dutch',
  pl: 'Polish',
  ru: 'Russian',
  tr: 'Turkish',
  fa: 'Persian',
  ar: 'Arabic',
  th: 'Thai',
  id: 'Indonesian',
  fi: 'Finnish',
  el: 'Greek',
  he: 'Hebrew',
  ta: 'Tamil',
  te: 'Telugu',
};

export interface Kw {
  id: number;
  name: string;
}

export interface Prov {
  id: number;
  name: string;
  logo: string | null;
}

/** Watch providers of one film in one region (TMDB / JustWatch data). */
export interface Providers {
  region: string;
  flat: Prov[];
  free: Prov[];
  ads: Prov[];
  rent: Prov[];
  buy: Prov[];
  link?: string;
  at: number;
}

/** Providers where the film is included at no extra cost per title. */
export function streamable(p: Providers): Prov[] {
  const seen = new Set<number>();
  return [...p.flat, ...p.free, ...p.ads].filter((x) => !seen.has(x.id) && seen.add(x.id));
}

/**
 * A TMDB film. `full` means it carries details (runtime, keywords, credits,
 * providers, recommendations); otherwise only list-level fields are known.
 */
export interface Film {
  id: number;
  title: string;
  original?: string;
  release?: string; // yyyy-mm-dd
  runtime?: number;
  genres: number[];
  lang?: string;
  poster?: string;
  backdrop?: string;
  /** A backdrop chosen because it shows a real scene, not poster artwork. '' = looked, none available. */
  scene?: string;
  overview: string;
  vote: number;
  votes: number;
  pop: number;
  directors: string[];
  cast: string[];
  keywords: Kw[];
  recs: number[];
  prov?: Providers;
  full: boolean;
  adult: boolean;
  at: number;
}

export function makeFilm(f: Partial<Film> & { id: number; title: string }): Film {
  return {
    genres: [],
    overview: '',
    vote: 0,
    votes: 0,
    pop: 0,
    directors: [],
    cast: [],
    keywords: [],
    recs: [],
    full: false,
    adult: false,
    at: nowSec(),
    ...f,
  };
}

export const yearOf = (f: Film): number | undefined => {
  if (!f.release || f.release.length < 4) return undefined;
  const y = parseInt(f.release.slice(0, 4), 10);
  return Number.isFinite(y) ? y : undefined;
};
export const decadeOf = (f: Film): number | undefined => {
  const y = yearOf(f);
  return y === undefined ? undefined : Math.floor(y / 10) * 10;
};
export const isReleased = (f: Film): boolean => !!f.release && f.release <= new Date().toISOString().slice(0, 10);
export const labelOf = (f: Film): string => (yearOf(f) === undefined ? f.title : `${f.title} (${yearOf(f)})`);
export const genreNames = (f: Film): string[] => f.genres.map((g) => GENRES[g]).filter(Boolean);
/** Bayesian-shrunk TMDB score (protects against 10.0 from 3 votes). */
export const scoreOf = (f: Film): number => (f.votes <= 0 ? 6.3 : (f.vote * f.votes + 6.3 * 150) / (f.votes + 150));

type Json = Record<string, any>;

const provList = (l: any): Prov[] =>
  Array.isArray(l) ? l.map((p) => ({ id: p.provider_id as number, name: (p.provider_name ?? '') as string, logo: (p.logo_path ?? null) as string | null })) : [];

/** From a TMDB list item (search/discover/recommendations). */
export function filmFromList(j: Json): Film {
  return makeFilm({
    id: j.id,
    title: j.title ?? j.original_title ?? '',
    original: j.original_title ?? undefined,
    release: j.release_date || undefined,
    genres: (j.genre_ids ?? []) as number[],
    lang: j.original_language ?? undefined,
    poster: j.poster_path ?? undefined,
    backdrop: j.backdrop_path ?? undefined,
    overview: j.overview ?? '',
    vote: Number(j.vote_average ?? 0),
    votes: Math.trunc(Number(j.vote_count ?? 0)),
    pop: Number(j.popularity ?? 0),
    adult: j.adult === true,
  });
}

/** From /movie/{id}?append_to_response=keywords,credits,watch/providers,recommendations */
export function filmFromDetails(j: Json, region: string): Film {
  const crew: any[] = j.credits?.crew ?? [];
  const cast: any[] = j.credits?.cast ?? [];
  const kws: any[] = j.keywords?.keywords ?? [];
  const recs: any[] = j.recommendations?.results ?? [];
  const pr = j['watch/providers']?.results?.[region];
  return makeFilm({
    id: j.id,
    title: j.title ?? j.original_title ?? '',
    original: j.original_title ?? undefined,
    release: j.release_date || undefined,
    runtime: typeof j.runtime === 'number' ? Math.trunc(j.runtime) : undefined,
    genres: (j.genres ?? []).map((g: any) => g.id as number),
    lang: j.original_language ?? undefined,
    poster: j.poster_path ?? undefined,
    backdrop: j.backdrop_path ?? undefined,
    overview: j.overview ?? '',
    vote: Number(j.vote_average ?? 0),
    votes: Math.trunc(Number(j.vote_count ?? 0)),
    pop: Number(j.popularity ?? 0),
    directors: crew.filter((c) => c.job === 'Director').map((c) => c.name as string),
    cast: cast.slice(0, 6).map((c) => c.name as string),
    keywords: kws.map((k) => ({ id: k.id as number, name: k.name as string })),
    recs: recs.map((r) => r.id as number),
    prov: {
      region,
      flat: provList(pr?.flatrate),
      free: provList(pr?.free),
      ads: provList(pr?.ads),
      rent: provList(pr?.rent),
      buy: provList(pr?.buy),
      link: pr?.link ?? undefined,
      at: nowSec(),
    },
    full: true,
    adult: j.adult === true,
  });
}

const provJson = (l: Prov[]) => l.map((p) => [p.id, p.name, p.logo]);
const provFrom = (l: any): Prov[] => (Array.isArray(l) ? l.map((p) => ({ id: p[0], name: p[1], logo: p[2] ?? null })) : []);

/** Compact on-disk form (short keys keep the film cache small). */
export function filmToJson(f: Film): Json {
  const j: Json = { id: f.id, t: f.title };
  if (f.original && f.original !== f.title) j.o = f.original;
  if (f.release) j.d = f.release;
  if (f.runtime !== undefined) j.rt = f.runtime;
  j.g = f.genres;
  if (f.lang) j.l = f.lang;
  if (f.poster) j.p = f.poster;
  if (f.backdrop) j.b = f.backdrop;
  if (f.scene !== undefined) j.sc = f.scene;
  if (f.overview) j.ov = f.overview;
  j.v = f.vote;
  j.n = f.votes;
  j.pp = f.pop;
  if (f.directors.length) j.dir = f.directors;
  if (f.cast.length) j.c = f.cast;
  if (f.keywords.length) j.k = f.keywords.map((k) => [k.id, k.name]);
  if (f.recs.length) j.rc = f.recs;
  if (f.prov) {
    const p = f.prov;
    j.pr = { r: p.region, fl: provJson(p.flat), fr: provJson(p.free), ad: provJson(p.ads), re: provJson(p.rent), bu: provJson(p.buy), at: p.at };
    if (p.link) j.pr.l = p.link;
  }
  if (f.full) j.f = 1;
  if (f.adult) j.a = 1;
  j.at = f.at;
  return j;
}

export function filmFromJson(j: Json): Film {
  const p = j.pr;
  return makeFilm({
    id: j.id,
    title: j.t,
    original: j.o ?? undefined,
    release: j.d ?? undefined,
    runtime: j.rt ?? undefined,
    genres: j.g ?? [],
    lang: j.l ?? undefined,
    poster: j.p ?? undefined,
    backdrop: j.b ?? undefined,
    scene: typeof j.sc === 'string' ? j.sc : undefined,
    overview: j.ov ?? '',
    vote: Number(j.v ?? 0),
    votes: Math.trunc(Number(j.n ?? 0)),
    pop: Number(j.pp ?? 0),
    directors: j.dir ?? [],
    cast: j.c ?? [],
    keywords: (j.k ?? []).map((k: any) => ({ id: k[0], name: k[1] })),
    recs: j.rc ?? [],
    prov: p
      ? { region: p.r, flat: provFrom(p.fl), free: provFrom(p.fr), ads: provFrom(p.ad), rent: provFrom(p.re), buy: provFrom(p.bu), link: p.l ?? undefined, at: p.at ?? 0 }
      : undefined,
    full: j.f === 1,
    adult: j.a === 1,
    at: j.at ?? nowSec(),
  });
}

const mine = (my: number | undefined, lb: number | undefined): boolean => my !== undefined && (lb === undefined || my >= lb);

/**
 * One film in the user's library. Letterboxd-side and in-app values are kept
 * separately; getters resolve them with one rule: the latest change wins.
 * Derived rules: rated ⇒ watched, watched ⇒ not on the watchlist.
 */
export class Entry {
  // Letterboxd side (ZIP export + RSS).
  lbRating?: number;
  lbRatingAt?: number; // when this value took effect (compared with in-app changes)
  lbSrcAt?: number; // date of the Letterboxd entry it came from (orders Letterboxd entries)
  lbWatched = false;
  lbWatchedAt?: number;
  lbWatchlist = false;
  lbWatchlistAt?: number;
  lbLiked = false;
  favorite = false;
  lbRewatch = false;
  watchDates: string[] = [];

  // In-app side. A timestamp with an undefined value means "cleared here".
  myRating?: number;
  myRatingAt?: number;
  myWatched?: boolean;
  myWatchedAt?: number;
  myWatchlist?: boolean;
  myWatchlistAt?: number;
  notInterested = false;
  niAt?: number;

  constructor(public readonly id: number) {}

  get rating(): number | undefined {
    return mine(this.myRatingAt, this.lbRatingAt) ? this.myRating : this.lbRating;
  }
  get ratingAt(): number | undefined {
    return mine(this.myRatingAt, this.lbRatingAt) ? this.myRatingAt : this.lbRatingAt;
  }
  get watched(): boolean {
    if (this.rating !== undefined) return true;
    if (mine(this.myWatchedAt, this.lbWatchedAt)) return this.myWatched ?? false;
    return this.lbWatched;
  }
  get watchedAt(): number | undefined {
    const a = [this.lbWatchedAt, this.myWatched === true ? this.myWatchedAt : undefined, this.ratingAt].filter((x): x is number => x !== undefined);
    return a.length ? Math.max(...a) : undefined;
  }
  get watchlist(): boolean {
    if (this.watched) return false;
    if (mine(this.myWatchlistAt, this.lbWatchlistAt)) return this.myWatchlist ?? false;
    return this.lbWatchlist;
  }
  get watchlistAt(): number | undefined {
    return mine(this.myWatchlistAt, this.lbWatchlistAt) ? this.myWatchlistAt : this.lbWatchlistAt;
  }
  get liked(): boolean {
    return this.lbLiked || this.favorite;
  }
  get rewatched(): boolean {
    return this.lbRewatch || this.watchDates.length > 1;
  }
  get hasLetterboxd(): boolean {
    return this.lbRating !== undefined || this.lbWatched || this.lbWatchlist || this.lbLiked || this.favorite;
  }
  get isEmpty(): boolean {
    return !this.hasLetterboxd && this.myRating === undefined && this.myWatched !== true && this.myWatchlist !== true && !this.notInterested;
  }

  clearLetterboxd(): void {
    this.lbRating = undefined;
    this.lbRatingAt = undefined;
    this.lbSrcAt = undefined;
    this.lbWatched = false;
    this.lbWatchedAt = undefined;
    this.lbWatchlist = false;
    this.lbWatchlistAt = undefined;
    this.lbLiked = false;
    this.favorite = false;
    this.lbRewatch = false;
    this.watchDates = [];
  }

  toJson(): Json {
    const j: Json = { id: this.id };
    if (this.lbRating !== undefined) j.lr = this.lbRating;
    if (this.lbRatingAt !== undefined) j.lra = this.lbRatingAt;
    if (this.lbSrcAt !== undefined) j.lsa = this.lbSrcAt;
    if (this.lbWatched) j.lw = 1;
    if (this.lbWatchedAt !== undefined) j.lwa = this.lbWatchedAt;
    if (this.lbWatchlist) j.ll = 1;
    if (this.lbWatchlistAt !== undefined) j.lla = this.lbWatchlistAt;
    if (this.lbLiked) j.lk = 1;
    if (this.favorite) j.fav = 1;
    if (this.lbRewatch) j.rw = 1;
    if (this.watchDates.length) j.wd = this.watchDates;
    if (this.myRating !== undefined) j.mr = this.myRating;
    if (this.myRatingAt !== undefined) j.mra = this.myRatingAt;
    if (this.myWatched !== undefined) j.mw = this.myWatched ? 1 : 0;
    if (this.myWatchedAt !== undefined) j.mwa = this.myWatchedAt;
    if (this.myWatchlist !== undefined) j.ml = this.myWatchlist ? 1 : 0;
    if (this.myWatchlistAt !== undefined) j.mla = this.myWatchlistAt;
    if (this.notInterested) j.ni = 1;
    if (this.niAt !== undefined) j.nia = this.niAt;
    return j;
  }

  static fromJson(j: Json): Entry {
    const e = new Entry(j.id);
    e.lbRating = j.lr ?? undefined;
    e.lbRatingAt = j.lra ?? undefined;
    e.lbSrcAt = j.lsa ?? undefined;
    e.lbWatched = j.lw === 1;
    e.lbWatchedAt = j.lwa ?? undefined;
    e.lbWatchlist = j.ll === 1;
    e.lbWatchlistAt = j.lla ?? undefined;
    e.lbLiked = j.lk === 1;
    e.favorite = j.fav === 1;
    e.lbRewatch = j.rw === 1;
    e.watchDates = j.wd ?? [];
    e.myRating = j.mr ?? undefined;
    e.myRatingAt = j.mra ?? undefined;
    e.myWatched = j.mw === undefined || j.mw === null ? undefined : j.mw === 1;
    e.myWatchedAt = j.mwa ?? undefined;
    e.myWatchlist = j.ml === undefined || j.ml === null ? undefined : j.ml === 1;
    e.myWatchlistAt = j.mla ?? undefined;
    e.notInterested = j.ni === 1;
    e.niAt = j.nia ?? undefined;
    return e;
  }
}

/** The user's whole library plus Letterboxd sync bookkeeping. */
export class Library {
  entries = new Map<number, Entry>();
  lbUsername?: string;
  lbImportAt?: number; // when a ZIP export was last imported
  lbLastSync?: number; // last successful RSS sync
  lbSeen: Record<string, string> = {}; // RSS guid -> signature of what we applied
  lbGap = false; // RSS may have missed entries (>50 logs between syncs)
  unmatched: string[] = []; // Letterboxd films we could not find on TMDB
  lbKeys: Record<string, number> = {}; // Letterboxd "title|year" -> TMDB id chosen at import
  rev = 0; // bumped on every change

  entry(id: number): Entry {
    let e = this.entries.get(id);
    if (!e) this.entries.set(id, (e = new Entry(id)));
    return e;
  }
  get(id: number): Entry | undefined {
    return this.entries.get(id);
  }
  all(): Entry[] {
    return [...this.entries.values()];
  }
  get rated(): Entry[] {
    return this.all().filter((e) => e.rating !== undefined);
  }
  get watched(): Entry[] {
    return this.all().filter((e) => e.watched);
  }
  get watchlist(): Entry[] {
    return this.all().filter((e) => e.watchlist);
  }
  get notInterested(): Entry[] {
    return this.all().filter((e) => e.notInterested);
  }

  touch(): void {
    this.rev++;
  }
  prune(): void {
    for (const [id, e] of this.entries) if (e.isEmpty) this.entries.delete(id);
  }

  // In-app actions. Each stamps "now", so it wins until Letterboxd reports
  // something newer for the same field.
  rate(id: number, stars: number | undefined): void {
    const e = this.entry(id);
    e.myRating = stars;
    e.myRatingAt = nowSec();
    if (stars !== undefined) {
      e.myWatched = true;
      e.myWatchedAt = e.myRatingAt;
      e.notInterested = false;
    }
    this.touch();
  }
  setWatched(id: number, v: boolean): void {
    const e = this.entry(id);
    e.myWatched = v;
    e.myWatchedAt = nowSec();
    if (!v && e.rating !== undefined) {
      e.myRating = undefined;
      e.myRatingAt = e.myWatchedAt;
    }
    if (v) e.notInterested = false;
    this.touch();
  }
  setWatchlist(id: number, v: boolean): void {
    const e = this.entry(id);
    e.myWatchlist = v;
    e.myWatchlistAt = nowSec();
    if (v) e.notInterested = false;
    this.touch();
  }
  setNotInterested(id: number, v: boolean): void {
    const e = this.entry(id);
    e.notInterested = v;
    e.niAt = nowSec();
    if (v && e.watchlist) {
      e.myWatchlist = false;
      e.myWatchlistAt = e.niAt;
    }
    this.touch();
  }

  /** Replace this library's content with another's (restore, reset). */
  replaceWith(o: Library): void {
    this.entries = new Map(o.entries);
    this.lbUsername = o.lbUsername;
    this.lbImportAt = o.lbImportAt;
    this.lbLastSync = o.lbLastSync;
    this.lbSeen = o.lbSeen;
    this.lbGap = o.lbGap;
    this.unmatched = o.unmatched;
    this.lbKeys = o.lbKeys;
    this.touch();
  }

  toJson(): Json {
    const j: Json = { v: 1, entries: this.all().filter((e) => !e.isEmpty).map((e) => e.toJson()), lbSeen: this.lbSeen };
    if (this.lbUsername) j.lbUser = this.lbUsername;
    if (this.lbImportAt !== undefined) j.lbImportAt = this.lbImportAt;
    if (this.lbLastSync !== undefined) j.lbLastSync = this.lbLastSync;
    if (this.lbGap) j.lbGap = true;
    if (this.unmatched.length) j.unmatched = this.unmatched;
    if (Object.keys(this.lbKeys).length) j.lbKeys = this.lbKeys;
    return j;
  }

  static fromJson(j: Json): Library {
    const l = new Library();
    for (const e of j.entries ?? []) {
      const en = Entry.fromJson(e);
      l.entries.set(en.id, en);
    }
    l.lbUsername = j.lbUser ?? undefined;
    l.lbImportAt = j.lbImportAt ?? undefined;
    l.lbLastSync = j.lbLastSync ?? undefined;
    l.lbSeen = { ...(j.lbSeen ?? {}) };
    l.lbGap = j.lbGap === true;
    l.unmatched = [...(j.unmatched ?? [])];
    l.lbKeys = { ...(j.lbKeys ?? {}) };
    return l;
  }
}
