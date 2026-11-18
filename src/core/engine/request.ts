import { Film, Library, Prov, isReleased, streamable, yearOf } from '../models';

/** What the user asked for tonight. */
export interface Request {
  prompt: string;
  genres: number[]; // every selected genre must be present
  notGenres: number[]; // none of these may be present
  yearMin?: number;
  yearMax?: number;
  runMin?: number; // minutes
  runMax?: number;
  langs: string[]; // original language, any of
  obscurity: number; // 0 = familiar … 1 = obscure
  excludeWatched: boolean;
  excludeWatchlist: boolean; // leave out films on the user's watchlist
  personalize: boolean;
  streamingOnly: boolean; // only films on the user's services
  seedId?: number; // "more like this"
}

export function newRequest(r: Partial<Request> = {}): Request {
  return { prompt: '', genres: [], notGenres: [], langs: [], obscurity: 0.5, excludeWatched: true, excludeWatchlist: false, personalize: true, streamingOnly: false, ...r };
}

export const hasPrompt = (r: Request): boolean => r.prompt.trim().length > 0;

export const hardFilterCount = (r: Request): number =>
  (r.genres.length ? 1 : 0) +
  (r.notGenres.length ? 1 : 0) +
  (r.yearMin !== undefined || r.yearMax !== undefined ? 1 : 0) +
  (r.runMin !== undefined || r.runMax !== undefined ? 1 : 0) +
  (r.langs.length ? 1 : 0) +
  (r.streamingOnly ? 1 : 0);

export const copyRequest = (r: Request): Request => ({ ...r, genres: [...r.genres], notGenres: [...r.notGenres], langs: [...r.langs] });

export function requestFromJson(j: any): Request {
  return newRequest({
    prompt: typeof j?.prompt === 'string' ? j.prompt : '',
    genres: Array.isArray(j?.genres) ? j.genres : [],
    notGenres: Array.isArray(j?.notGenres) ? j.notGenres : [],
    yearMin: j?.yearMin ?? undefined,
    yearMax: j?.yearMax ?? undefined,
    runMin: j?.runMin ?? undefined,
    runMax: j?.runMax ?? undefined,
    langs: Array.isArray(j?.langs) ? j.langs : [],
    obscurity: typeof j?.obscurity === 'number' ? j.obscurity : 0.5,
    excludeWatched: j?.excludeWatched !== false,
    excludeWatchlist: j?.excludeWatchlist === true,
    personalize: j?.personalize !== false,
    streamingOnly: j?.streamingOnly === true,
    seedId: j?.seedId ?? undefined,
  });
}

/** The user's region and streaming services. */
export class Services {
  /** `mine` maps provider id → name. */
  constructor(readonly region: string, readonly mine: Record<number, string> = {}) {}

  get names(): string[] {
    return Object.values(this.mine);
  }
  get ids(): number[] {
    return Object.keys(this.mine).map(Number);
  }

  /**
   * TMDB lists plan variants separately ("Netflix Standard with Ads"), so a
   * provider also counts when its name starts with one of the user's.
   */
  has(p: Prov): boolean {
    if (p.id in this.mine) return true;
    const n = p.name.toLowerCase();
    return this.names.some((m) => n.startsWith(m.toLowerCase()));
  }

  available(f: Film): Prov[] {
    return f.prov && f.prov.region === this.region ? streamable(f.prov).filter((p) => this.has(p)) : [];
  }
}

/**
 * The single place where hard constraints are enforced. Returns undefined
 * when the film may be recommended, otherwise the reason it may not.
 *
 * With `listLevel` the film only carries list fields (no runtime/providers
 * yet); those checks are skipped and must be repeated on the full record.
 * Final picks always pass through here with `listLevel: false`.
 */
export function rejectReason(f: Film, r: Request, lib: Library, sv: Services, opts: { shown?: Set<number>; listLevel?: boolean } = {}): string | undefined {
  if (f.adult) return 'adult';
  if (!isReleased(f)) return 'unreleased';
  if (f.id === r.seedId) return 'seed';
  if (opts.shown?.has(f.id)) return 'shown';
  const e = lib.get(f.id);
  if (e) {
    if (e.notInterested) return 'not interested';
    if (r.excludeWatched && e.watched) return 'watched';
    if (r.excludeWatchlist && e.watchlist) return 'watchlist';
  }
  const y = yearOf(f);
  if (r.yearMin !== undefined && (y === undefined || y < r.yearMin)) return 'year';
  if (r.yearMax !== undefined && (y === undefined || y > r.yearMax)) return 'year';
  if (!r.genres.every((g) => f.genres.includes(g))) return 'genre';
  if (r.notGenres.some((g) => f.genres.includes(g))) return 'genre';
  if (r.langs.length && !(f.lang && r.langs.includes(f.lang))) return 'language';
  if (!f.poster) return 'no poster';
  if (f.votes < 15) return 'too few votes';
  if (opts.listLevel) return undefined;
  if (!f.full) return 'no details';
  const rt = f.runtime ?? 0;
  if (r.runMin !== undefined || r.runMax !== undefined) {
    if (rt <= 0) return 'runtime';
    if (r.runMin !== undefined && rt < r.runMin) return 'runtime';
    if (r.runMax !== undefined && rt > r.runMax) return 'runtime';
  } else if (rt > 0 && rt < 40) {
    return 'short film';
  }
  if (r.streamingOnly && sv.available(f).length === 0) return 'streaming';
  return undefined;
}
