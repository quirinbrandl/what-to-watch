import { Session } from './engine/recommender';
import { GENRES, LANGUAGES } from './models';
import { FilmCache } from './tmdb';

/** A streaming service as the filter shows it. */
export interface Service {
  id: number;
  name: string;
  logo: string | null;
}

/** One search the user ran, kept on the device so it can be opened again without waiting. */
export interface SavedSearch {
  id: string;
  at: number; // ms since epoch, when the search was made
  region: string;
  services: Service[]; // the streaming services it was limited to; empty = anywhere
  seedTitle?: string; // for "more like this" searches
  session: Session;
}

/** How many searches are kept; the oldest go first. */
export const MAX_SEARCHES = 20;

export function historyToJson(list: SavedSearch[], current?: string): Record<string, unknown> {
  return {
    v: 1,
    current,
    list: list.map((e) => ({
      id: e.id,
      at: e.at,
      region: e.region,
      services: e.services,
      seedTitle: e.seedTitle,
      s: e.session.toJson(),
    })),
  };
}

const isService = (x: any): x is Service => x && typeof x.id === 'number' && typeof x.name === 'string';

export function historyFromJson(j: any, films: FilmCache): { list: SavedSearch[]; current?: string } {
  const list: SavedSearch[] = [];
  for (const e of Array.isArray(j?.list) ? j.list : []) {
    if (typeof e?.id !== 'string' || typeof e.at !== 'number' || !e.s) continue;
    try {
      const session = Session.fromJson(e.s, films);
      if (!session.picks.length) continue;
      list.push({
        id: e.id,
        at: e.at,
        region: typeof e.region === 'string' ? e.region : 'DE',
        services: (Array.isArray(e.services) ? e.services : []).filter(isService).map((s: Service) => ({
          id: s.id,
          name: s.name,
          logo: s.logo ?? null,
        })),
        seedTitle: typeof e.seedTitle === 'string' ? e.seedTitle : undefined,
        session,
      });
    } catch {}
  }
  const current = typeof j?.current === 'string' && list.some((e) => e.id === j.current) ? (j.current as string) : undefined;
  return { list, current };
}

/** Adds a search at the top, keeping at most `max`. */
export function addSearch(list: SavedSearch[], e: SavedSearch, max = MAX_SEARCHES): SavedSearch[] {
  return [e, ...list.filter((x) => x.id !== e.id)].slice(0, max);
}

/** What the user asked for, in a few words. */
export function searchTitle(e: SavedSearch): string {
  const p = e.session.request.prompt.trim();
  if (p) return p;
  if (e.seedTitle) return `More like ${e.seedTitle}`;
  return 'Anything good tonight';
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number) => String(n).padStart(2, '0');

/** "Today, 17:12", "Yesterday, 21:03", "Mon 9 Nov" or "9 Nov 2025", in the phone's time zone. */
export function whenLabel(at: number, now = Date.now()): string {
  const d = new Date(at);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date(now)) - day(d)) / 86400000);
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (diff <= 0) return `Today, ${time}`;
  if (diff === 1) return `Yesterday, ${time}`;
  if (diff < 7) return `${DAYS[d.getDay()]}, ${time}`;
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === new Date(now).getFullYear() ? `${DAYS[d.getDay()]} ${date}` : `${date} ${d.getFullYear()}`;
}

/** The filters that shaped a search, briefly: services, genres, years, length. */
export function searchFilters(e: SavedSearch): string[] {
  const r = e.session.request;
  const out: string[] = [];
  if (e.services.length) out.push(e.services.map((s) => s.name).join(', '));
  if (r.genres.length) out.push(r.genres.map((g) => GENRES[g]).join(', '));
  if (r.notGenres.length) out.push(r.notGenres.map((g) => `no ${GENRES[g]}`).join(', '));
  if (r.yearMin !== undefined || r.yearMax !== undefined) out.push(`${r.yearMin ?? '…'}–${r.yearMax ?? 'now'}`);
  if (r.runMin !== undefined) out.push(`≥ ${r.runMin} min`);
  if (r.runMax !== undefined) out.push(`≤ ${r.runMax} min`);
  if (r.langs.length) out.push(r.langs.map((l) => LANGUAGES[l] ?? l).join(', '));
  const lv = levelOf(r.obscurity);
  if (lv !== 2) out.push(LEVELS[lv]);
  if (!r.personalize) out.push('not personal');
  if (!r.excludeWatched) out.push('rewatches');
  if (r.excludeWatchlist) out.push('not on watchlist');
  if (r.recent) out.push('new releases');
  return out;
}

/** The five steps of the mainstream ↔ niche dial (request.obscurity 0 … 1). */
export const LEVELS = ['Mainstream', 'Popular', 'Balanced', 'Lesser-known', 'Niche'];
export const levelOf = (obscurity: number) => Math.max(0, Math.min(4, Math.round(obscurity * 4)));
