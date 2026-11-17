import { Film, Prov, filmFromDetails, filmFromJson, filmFromList, filmToJson, nowSec } from './models';

/** Runs at most `max` tasks at once. */
export class Pool {
  private running = 0;
  private queue: (() => void)[] = [];
  constructor(private max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) await new Promise<void>((r) => this.queue.push(r));
    else this.running++;
    try {
      return await task();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.running--;
    }
  }
}

export class TmdbError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * In-memory film cache shared by the whole app. Persistence is handled by
 * the caller, which serialises it with toJson().
 */
export class FilmCache {
  films = new Map<number, Film>();

  get(id: number): Film | undefined {
    return this.films.get(id);
  }

  /** Insert a film, never downgrading a full record to a list-level one. */
  put(f: Film): Film {
    const old = this.films.get(f.id);
    if (old && old.full && !f.full) {
      old.vote = f.vote;
      old.votes = f.votes;
      old.pop = f.pop;
      return old;
    }
    if (old?.scene !== undefined && f.scene === undefined) f.scene = old.scene;
    this.films.set(f.id, f);
    return f;
  }

  toJson(): { films: unknown[] } {
    return { films: [...this.films.values()].map(filmToJson) };
  }

  load(j: any): void {
    for (const f of j?.films ?? []) {
      const film = filmFromJson(f);
      this.films.set(film.id, film);
    }
  }

  /** Keep the cache bounded: drop the stalest films that are not in `keep`. */
  prune(keep: Set<number>, max = 6000): void {
    if (this.films.size <= max) return;
    const rest = [...this.films.values()].filter((f) => !keep.has(f.id)).sort((a, b) => a.at - b.at);
    for (const f of rest.slice(0, this.films.size - max)) this.films.delete(f.id);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Orders a film's textless backdrops for scene picking: the main one first, then by rating. */
export function rankStills(main: string | undefined, backdrops: unknown, n = 5): string[] {
  const list = (Array.isArray(backdrops) ? backdrops : [])
    .filter((b) => b && typeof b.file_path === 'string' && (b.iso_639_1 === null || b.iso_639_1 === undefined) && b.file_path !== main)
    .sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0) || (b.vote_count ?? 0) - (a.vote_count ?? 0))
    .map((b) => b.file_path as string);
  return [...(main ? [main] : []), ...list].slice(0, n);
}

export class Tmdb {
  /**
   * Read-only TMDB API token, embedded on purpose (see README): it only
   * grants access to public movie metadata and images.
   */
  static readonly readToken =
    'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJmY2FiZDVhMWU5OTY2YmEzM2MyMTU1ZTYyMGI5NDczZSIsIm5iZiI6MTc3MjY1NDI0NS41MjQsInN1YiI6IjY5YTg4ZWE1ZTE0M2QyY2RlMjA4MGI1ZiIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.IxTOK2570KkFtZXlpsk857fVwqnylZZ1fzSEzecrQUk';
  private static readonly base = 'https://api.themoviedb.org/3';

  static img(path: string, size = 'w500'): string {
    return `https://image.tmdb.org/t/p/${size}${path}`;
  }

  private pool = new Pool(12);
  private memo = new Map<string, any>();
  calls = 0;

  constructor(public cache: FilmCache, private fetchFn: typeof fetch = fetch) {}

  async get(path: string, q: Record<string, string> = {}, memo = true): Promise<any> {
    const params = new URLSearchParams({ language: 'en-US', ...q });
    const url = `${Tmdb.base}${path}?${params.toString()}`;
    if (memo && this.memo.has(url)) return this.memo.get(url);
    const body = await this.pool.run(async () => {
      for (let attempt = 0; ; attempt++) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 20000);
        try {
          this.calls++;
          const r = await this.fetchFn(url, { headers: { Authorization: `Bearer ${Tmdb.readToken}`, Accept: 'application/json' }, signal: ctl.signal });
          if (r.status === 200) return await r.json();
          if ((r.status === 429 || r.status >= 500) && attempt < 4) {
            await sleep(400 * (attempt + 1) * (attempt + 1));
            continue;
          }
          throw new TmdbError(r.status, r.status === 404 ? 'Not found' : 'Request failed');
        } catch (e) {
          if (e instanceof TmdbError) throw e;
          if (attempt >= 3) throw new TmdbError(0, 'Network problem');
          await sleep(500 * (attempt + 1));
        } finally {
          clearTimeout(timer);
        }
      }
    });
    if (memo) this.memo.set(url, body);
    return body;
  }

  private list(body: any): Film[] {
    return ((body?.results ?? []) as any[]).filter((r) => r && typeof r.id === 'number' && r.adult !== true).map((r) => this.cache.put(filmFromList(r)));
  }

  /** Full film details. Served from cache when fresh for this region. */
  async details(id: number, region: string, opts: { maxAgeDays?: number; providerMaxAgeDays?: number } = {}): Promise<Film> {
    const { maxAgeDays = 30, providerMaxAgeDays = 3 } = opts;
    const c = this.cache.get(id);
    const now = nowSec();
    if (c && c.full && now - c.at < maxAgeDays * 86400) {
      const p = c.prov;
      if (p && p.region === region && now - p.at < providerMaxAgeDays * 86400) return c;
    }
    const j = await this.get(`/movie/${id}`, { append_to_response: 'keywords,credits,watch/providers,recommendations' }, false);
    for (const r of (j.recommendations?.results ?? []) as any[]) {
      if (r && typeof r.id === 'number' && r.adult !== true) this.cache.put(filmFromList(r));
    }
    return this.cache.put(filmFromDetails(j, region));
  }

  /**
   * Candidate background images for a film: its main backdrop first, then the
   * best-rated other backdrops without text. TMDB does not say which of these
   * are real scenes and which are poster artwork; see engine/scenes.ts.
   */
  async stills(f: Film, n = 5): Promise<string[]> {
    const j = await this.get(`/movie/${f.id}/images`, { include_image_language: 'null' });
    return rankStills(f.backdrop, j?.backdrops, n);
  }

  /** Details for many films; failures are skipped (the result may be shorter). */
  async detailsAll(ids: Iterable<number>, region: string, opts: { onEach?: (f: Film) => void; providerMaxAgeDays?: number } = {}): Promise<Film[]> {
    const out = await Promise.all(
      [...ids].map(async (id) => {
        try {
          const f = await this.details(id, region, { providerMaxAgeDays: opts.providerMaxAgeDays });
          opts.onEach?.(f);
          return f;
        } catch {
          return undefined;
        }
      }),
    );
    return out.filter((f): f is Film => !!f);
  }

  async search(query: string, opts: { year?: number; primary?: boolean } = {}): Promise<Film[]> {
    const q: Record<string, string> = { query, include_adult: 'false' };
    if (opts.year !== undefined) q[opts.primary ? 'primary_release_year' : 'year'] = String(opts.year);
    return this.list(await this.get('/search/movie', q));
  }

  async recommendations(id: number, page = 1): Promise<Film[]> {
    return this.list(await this.get(`/movie/${id}/recommendations`, { page: String(page) }));
  }

  async similar(id: number): Promise<Film[]> {
    return this.list(await this.get(`/movie/${id}/similar`));
  }

  async discover(q: Record<string, string>, page = 1): Promise<Film[]> {
    return this.list(await this.get('/discover/movie', { include_adult: 'false', include_video: 'false', ...q, page: String(page) }));
  }

  async trending(): Promise<Film[]> {
    return this.list(await this.get('/trending/movie/week'));
  }

  async topRated(page = 1): Promise<Film[]> {
    return this.list(await this.get('/movie/top_rated', { page: String(page) }));
  }

  /** Streaming services offered in a region, most relevant first. */
  async providerCatalog(region: string): Promise<Prov[]> {
    const j = await this.get('/watch/providers/movie', { watch_region: region });
    const l = ((j.results ?? []) as any[]).slice();
    const prio = (p: any): number => Number(p.display_priorities?.[region] ?? p.display_priority ?? 999);
    l.sort((a, b) => prio(a) - prio(b));
    return l.map((p) => ({ id: p.provider_id as number, name: (p.provider_name ?? '') as string, logo: (p.logo_path ?? null) as string | null }));
  }
}
