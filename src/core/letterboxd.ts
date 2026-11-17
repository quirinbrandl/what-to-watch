import { strFromU8, unzipSync } from 'fflate';

import { Film, Library, nowSec, yearOf } from './models';
import { Tmdb } from './tmdb';

// ---------------------------------------------------------------- CSV

/** RFC 4180 CSV parser (quoted fields, escaped quotes, embedded newlines). */
export function parseCsv(s: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else {
      cell += c;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function csvMaps(rows: string[][]): Record<string, string>[] {
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().replace(/﻿/g, ''));
  return rows
    .slice(1)
    .filter((r) => r.some((c) => c.length))
    .map((r) => {
      const m: Record<string, string> = {};
      for (let i = 0; i < head.length && i < r.length; i++) m[head[i]] = r[i];
      return m;
    });
}

function dateSec(d: string | undefined | null): number | undefined {
  if (!d || d.length < 10) return undefined;
  const t = Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
}

// ---------------------------------------------------------------- export ZIP

export const filmKey = (name: string, year: number | undefined): string => `${name.toLowerCase()}|${year ?? ''}`;

export class LbFilm {
  uri?: string;
  rating?: number;
  ratingAt?: number;
  watched = false;
  watchedAt?: number;
  watchlist = false;
  watchlistAt?: number;
  liked = false;
  favorite = false;
  rewatch = false;
  watchDates = new Set<string>();
  tmdbId?: number;
  constructor(public readonly name: string, public readonly year: number | undefined) {}
  get key(): string {
    return filmKey(this.name, this.year);
  }
}

export class LbExport {
  username?: string;
  exportAt?: number;
  films = new Map<string, LbFilm>(); // by name|year
  private count(f: (x: LbFilm) => boolean): number {
    return [...this.films.values()].filter(f).length;
  }
  get ratings(): number {
    return this.count((f) => f.rating !== undefined);
  }
  get watched(): number {
    return this.count((f) => f.watched);
  }
  get watchlist(): number {
    return this.count((f) => f.watchlist);
  }
}

export class LbFormatError extends Error {}

const SUBDIRS = new Set(['likes', 'lists', 'deleted', 'orphaned']);

/** Maps a path inside an export to its canonical relative name. */
export function exportRelPath(path: string): string | undefined {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length || !parts[parts.length - 1].toLowerCase().endsWith('.csv')) return undefined;
  if (parts.some((p) => p.startsWith('__MACOSX') || p.startsWith('._'))) return undefined;
  const base = parts[parts.length - 1].toLowerCase();
  const parent = parts.length > 1 ? parts[parts.length - 2].toLowerCase() : '';
  return SUBDIRS.has(parent) ? `${parent}/${base}` : base;
}

/**
 * Reads a complete Letterboxd export ZIP. The user never picks single CSVs:
 * every known file is located by name, wherever it sits inside the archive.
 */
export function parseLetterboxdZip(bytes: Uint8Array): LbExport {
  let zip: Record<string, Uint8Array>;
  try {
    zip = unzipSync(bytes, { filter: (f) => f.name.toLowerCase().endsWith('.csv') });
  } catch {
    throw new LbFormatError('That file is not a ZIP archive.');
  }
  const files: Record<string, string> = {};
  for (const [name, data] of Object.entries(zip)) {
    const rel = exportRelPath(name);
    if (rel) files[rel] = strFromU8(data);
  }
  return parseLetterboxdFiles(files);
}

/** `files` maps a relative path such as `ratings.csv` or `likes/films.csv` to its text. */
export function parseLetterboxdFiles(files: Record<string, string>): LbExport {
  if (!('ratings.csv' in files) && !('watched.csv' in files) && !('watchlist.csv' in files)) {
    throw new LbFormatError('This ZIP does not look like a Letterboxd export.');
  }
  const ex = new LbExport();
  const byUri = new Map<string, LbFilm>();
  let maxDate = 0;
  const rows = (name: string) => (files[name] === undefined ? [] : csvMaps(parseCsv(files[name])));

  const film = (r: Record<string, string>, uriIsFilm = true): LbFilm | undefined => {
    const name = (r['Name'] ?? '').trim();
    if (!name) return undefined;
    const y = parseInt((r['Year'] ?? '').trim(), 10);
    const year = Number.isFinite(y) ? y : undefined;
    const key = `${name.toLowerCase()}|${year ?? ''}`;
    let f = ex.films.get(key);
    if (!f) ex.films.set(key, (f = new LbFilm(name, year)));
    const uri = r['Letterboxd URI'] ?? r['URL'];
    if (uriIsFilm && uri) {
      f.uri ??= uri;
      byUri.set(uri, f);
    }
    const d = dateSec(r['Date']);
    if (d !== undefined && d > maxDate) maxDate = d;
    return f;
  };

  for (const r of rows('watched.csv')) {
    const f = film(r);
    if (!f) continue;
    f.watched = true;
    f.watchedAt = dateSec(r['Date']);
  }
  for (const r of rows('ratings.csv')) {
    const f = film(r);
    const rating = parseFloat(r['Rating'] ?? '');
    if (!f || !Number.isFinite(rating)) continue;
    f.rating = rating;
    f.ratingAt = dateSec(r['Date']);
    f.watched = true;
    f.watchedAt ??= f.ratingAt;
  }
  for (const r of rows('watchlist.csv')) {
    const f = film(r);
    if (!f) continue;
    f.watchlist = true;
    f.watchlistAt = dateSec(r['Date']);
  }
  // Diary and review rows carry the URI of the *entry*, not of the film.
  for (const name of ['diary.csv', 'reviews.csv']) {
    for (const r of rows(name)) {
      const f = film(r, false);
      if (!f) continue;
      f.watched = true;
      const wd = (r['Watched Date'] ?? '').trim();
      if (wd.length >= 10) f.watchDates.add(wd.slice(0, 10));
      if ((r['Rewatch'] ?? '').trim().toLowerCase() === 'yes') f.rewatch = true;
      const when = dateSec(wd || r['Date']) ?? dateSec(r['Date']);
      if (when !== undefined && (f.watchedAt === undefined || when > f.watchedAt)) f.watchedAt = when;
      // A diary rating only fills in when ratings.csv has none for this film.
      const rating = parseFloat(r['Rating'] ?? '');
      if (Number.isFinite(rating) && f.rating === undefined) {
        f.rating = rating;
        f.ratingAt = dateSec(r['Date']);
      }
    }
  }
  for (const r of rows('likes/films.csv')) {
    const f = film(r);
    if (f) f.liked = true;
  }
  // Lists that read like favourites ("Top 10", "Favorites", ...) count as favourites.
  for (const [path, text] of Object.entries(files)) {
    if (!path.startsWith('lists/')) continue;
    const all = parseCsv(text);
    const head = all.findIndex((r) => r.length > 0 && r[0].trim() === 'Position');
    if (head < 0) continue;
    const listName = (head >= 2 && all[head - 2].length > 1 ? all[head - 2][1] : path).toLowerCase();
    const fav = /top|fav|best|loved|all[- ]?time|greatest/.test(listName) && !/worst|hate|bad|disappoint|watchlist|to watch/.test(listName);
    if (!fav) continue;
    for (const r of csvMaps(all.slice(head))) {
      const f = film(r);
      if (f) f.favorite = true;
    }
  }
  for (const r of rows('profile.csv')) {
    const u = (r['Username'] ?? '').trim();
    if (u) ex.username = u;
    for (const uri of (r['Favorite Films'] ?? '').split(',')) {
      const f = byUri.get(uri.trim());
      if (f) f.favorite = true;
    }
    const d = dateSec(r['Date Joined']);
    if (d !== undefined && d > maxDate) maxDate = d;
  }
  ex.exportAt = maxDate === 0 ? undefined : maxDate + 86399;
  return ex;
}

// ---------------------------------------------------------------- TMDB matching

const FOLD: Record<string, string> = {
  à: 'a', á: 'a', â: 'a', ã: 'a', ä: 'a', å: 'a', æ: 'ae', ç: 'c', è: 'e', é: 'e', ê: 'e', ë: 'e',
  ì: 'i', í: 'i', î: 'i', ï: 'i', ñ: 'n', ò: 'o', ó: 'o', ô: 'o', õ: 'o', ö: 'o', ø: 'o', œ: 'oe',
  ù: 'u', ú: 'u', û: 'u', ü: 'u', ý: 'y', ÿ: 'y', ß: 'ss', ł: 'l', ś: 's', š: 's', ž: 'z', ż: 'z',
  č: 'c', ć: 'c', ř: 'r', ě: 'e', ő: 'o', ű: 'u', ğ: 'g', ı: 'i', ş: 's', đ: 'd', ā: 'a', ō: 'o', ū: 'u',
};

export function normTitle(s: string): string {
  let out = '';
  for (const ch of s.toLowerCase().replace(/&/g, 'and')) {
    const f = FOLD[ch] ?? ch;
    for (let i = 0; i < f.length; i++) {
      const u = f.charCodeAt(i);
      if ((u >= 97 && u <= 122) || (u >= 48 && u <= 57) || u > 0x2ff) out += f[i];
    }
  }
  return out;
}

function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let hit = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      hit++;
      grams.set(g, n - 1);
    }
  }
  return (2 * hit) / (a.length + b.length - 2);
}

/** How well a TMDB film matches a title/year pair. ≥ 100 is a confident match. */
export function matchScore(f: Film, title: string, year: number | undefined, yearHit = false): number {
  const n = normTitle(title);
  const exact = normTitle(f.title) === n || (f.original !== undefined && normTitle(f.original) === n);
  // "Glass Onion" vs "Glass Onion: A Knives Out Mystery": main titles agree.
  const main = (t: string) => normTitle(t.split(/:| - | – /)[0]);
  const sub = !exact && n.length >= 4 && f.votes >= 100 && (main(f.title) === n || normTitle(f.title) === main(title));
  let s = exact ? 100 : sub ? 90 : 60 * Math.max(dice(normTitle(f.title), n), f.original === undefined ? 0 : dice(normTitle(f.original), n));
  if (year !== undefined) {
    const fy = yearOf(f);
    if (fy === undefined) {
      s -= 20;
    } else {
      const d = Math.abs(fy - year);
      // yearHit: TMDB's year-filtered search returned it, so it has *a*
      // release in that year even if its primary date moved (re-releases).
      s += d === 0 ? 40 : d === 1 || (yearHit && exact) ? 25 : d === 2 ? 0 : -40;
    }
  }
  // Popularity breaks ties between namesakes: Letterboxd often uses the
  // festival year, and TMDB is full of near-empty entries with the same title.
  return s + Math.min(24, Math.log10(f.votes + 1) * 6) - (f.votes < 5 ? 10 : 0);
}

/**
 * Finds the TMDB film for a title/year. Returns undefined when nothing
 * matches with confidence, rather than guessing.
 */
export async function matchTitle(tmdb: Tmdb, title: string, year: number | undefined): Promise<Film | undefined> {
  let best: Film | undefined;
  let bestScore = 0;
  const consider = (l: Film[], yearHit = false) => {
    for (const f of l.slice(0, 10)) {
      const s = matchScore(f, title, year, yearHit);
      if (s > bestScore) {
        bestScore = s;
        best = f;
      }
    }
  };
  consider(await tmdb.search(title, { year }), year !== undefined);
  if (bestScore < 125 && year !== undefined) consider(await tmdb.search(title));
  return bestScore >= 100 ? best : undefined;
}

/**
 * Letterboxd's RSS feed carries exact TMDB ids. Use them for the films of an
 * export that also appear in the feed, before falling back to title search.
 */
export function seedMatches(ex: LbExport, items: RssItem[]): void {
  for (const it of items) {
    const f = ex.films.get(filmKey(it.title, it.year));
    if (f) f.tmdbId = it.tmdbId;
  }
}

/** Resolves every film of an export to a TMDB id (films that already have one are kept). */
export async function matchExport(ex: LbExport, tmdb: Tmdb, onProgress?: (done: number, total: number, film?: Film) => void): Promise<void> {
  const list = [...ex.films.values()];
  let done = 0;
  await Promise.all(
    list.map(async (f) => {
      let m: Film | undefined;
      if (f.tmdbId === undefined) {
        try {
          m = await matchTitle(tmdb, f.name, f.year);
        } catch {}
        f.tmdbId = m?.id;
      } else {
        m = tmdb.cache.get(f.tmdbId);
      }
      onProgress?.(++done, list.length, m);
    }),
  );
}

/**
 * A ZIP export is a full snapshot of the Letterboxd side: replace all
 * Letterboxd-derived values, keep everything done in the app.
 */
export function applyExport(lib: Library, ex: LbExport): void {
  for (const e of lib.entries.values()) e.clearLetterboxd();
  lib.unmatched = [];
  lib.lbKeys = {};
  for (const f of ex.films.values()) {
    const id = f.tmdbId;
    if (id === undefined) {
      lib.unmatched.push(f.year === undefined ? f.name : `${f.name} (${f.year})`);
      continue;
    }
    lib.lbKeys[f.key] = id;
    const e = lib.entry(id);
    if (f.rating !== undefined && (e.lbRatingAt === undefined || (f.ratingAt ?? 0) >= e.lbRatingAt)) {
      e.lbRating = f.rating;
      e.lbRatingAt = f.ratingAt ?? 0;
      e.lbSrcAt = f.ratingAt ?? 0;
    }
    if (f.watched) {
      e.lbWatched = true;
      if (f.watchedAt !== undefined && (e.lbWatchedAt === undefined || f.watchedAt > e.lbWatchedAt)) e.lbWatchedAt = f.watchedAt;
    }
    if (f.watchlist) {
      e.lbWatchlist = true;
      e.lbWatchlistAt = f.watchlistAt ?? 0;
    }
    e.lbLiked = e.lbLiked || f.liked;
    e.favorite = e.favorite || f.favorite;
    e.lbRewatch = e.lbRewatch || f.rewatch;
    for (const d of f.watchDates) if (!e.watchDates.includes(d)) e.watchDates.push(d);
  }
  if (ex.username) lib.lbUsername = ex.username;
  lib.lbImportAt = ex.exportAt ?? nowSec();
  lib.lbSeen = {};
  lib.lbGap = false;
  lib.prune();
  lib.touch();
}

// ---------------------------------------------------------------- RSS sync

export interface RssItem {
  guid: string;
  tmdbId: number;
  title: string;
  year?: number;
  rating?: number;
  liked: boolean;
  rewatch: boolean;
  watchedDate?: string;
  pubAt: number;
}

const sig = (i: RssItem) => `${i.rating ?? ''}|${i.liked ? 1 : 0}|${i.watchedDate ?? ''}`;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Parses an RFC 822 date ("Tue, 17 Nov 2026 11:22:49 +1300") to epoch seconds. */
export function parseRfc822(s: string): number | undefined {
  const m = /(\d{1,2}) (\w{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2})(?: ([+-])(\d{2})(\d{2}))?/.exec(s);
  if (!m) return undefined;
  const mon = MONTHS.indexOf(m[2].toLowerCase());
  if (mon < 0) return undefined;
  let t = Date.UTC(+m[3], mon, +m[1], +m[4], +m[5], +m[6]) / 1000;
  if (m[7]) {
    const off = +m[8] * 3600 + +m[9] * 60;
    t += m[7] === '+' ? -off : off;
  }
  return t;
}

const unescapeXml = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

/**
 * Diary items of a Letterboxd RSS feed. Lists, TV entries and anything
 * without a TMDB movie id are ignored.
 */
export function parseRss(body: string): RssItem[] {
  if (!/<rss[\s>]/.test(body)) throw new Error('Not an RSS feed');
  const out: RssItem[] = [];
  for (const m of body.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    const t = (name: string): string | undefined => {
      const r = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(it);
      return r ? unescapeXml(r[1]).trim() : undefined;
    };
    const guid = t('guid');
    const id = parseInt(t('tmdb:movieId') ?? '', 10);
    if (!guid || !Number.isFinite(id) || !(guid.startsWith('letterboxd-watch') || guid.startsWith('letterboxd-review'))) continue;
    const wd = t('letterboxd:watchedDate');
    const year = parseInt(t('letterboxd:filmYear') ?? '', 10);
    const rating = parseFloat(t('letterboxd:memberRating') ?? '');
    const watchedDate = wd && wd.length >= 10 ? wd.slice(0, 10) : undefined;
    out.push({
      guid,
      tmdbId: id,
      title: t('letterboxd:filmTitle') ?? '',
      year: Number.isFinite(year) ? year : undefined,
      rating: Number.isFinite(rating) ? rating : undefined,
      liked: (t('letterboxd:memberLike') ?? '').toLowerCase() === 'yes',
      rewatch: (t('letterboxd:rewatch') ?? '').toLowerCase() === 'yes',
      watchedDate,
      pubAt: parseRfc822(t('pubDate') ?? '') ?? dateSec(watchedDate) ?? nowSec(),
    });
  }
  return out;
}

export function cleanUsername(s: string): string | undefined {
  let u = s.trim();
  const m = /letterboxd\.com\/([A-Za-z0-9_]+)/.exec(u);
  if (m) u = m[1];
  if (u.startsWith('@')) u = u.slice(1);
  return /^[A-Za-z0-9_]{2,40}$/.test(u) ? u : undefined;
}

export class LbNotFound extends Error {}

export async function fetchRss(username: string, fetchFn: typeof fetch = fetch): Promise<RssItem[]> {
  const u = cleanUsername(username);
  if (!u) throw new LbNotFound();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetchFn(`https://letterboxd.com/${u.toLowerCase()}/rss/`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; rss-reader)', Accept: 'application/rss+xml, application/xml' },
      signal: ctl.signal,
    });
    if (r.status === 404) throw new LbNotFound();
    if (r.status !== 200) throw new Error(`Letterboxd answered ${r.status}`);
    return parseRss(await r.text());
  } finally {
    clearTimeout(timer);
  }
}

export interface SyncResult {
  added: number; // films new to the library
  updated: number; // existing films that changed
  gap: boolean;
  ids: number[];
}

/**
 * Merges RSS diary items into the library.
 *
 * - Duplicates: every item is remembered by guid + signature, and films are
 *   keyed by TMDB id, so re-reading the feed changes nothing.
 * - Changed ratings: a known guid with a new signature is applied again and
 *   stamped "now", so it beats older in-app values.
 * - Rewatches: each distinct watched date counts once.
 * - Gaps: the feed only holds the ~50 latest entries. If none of them is
 *   known although we synced before, entries in between were missed.
 */
export function applyRss(lib: Library, items: RssItem[], now?: number): SyncResult {
  const res: SyncResult = { added: 0, updated: 0, gap: false, ids: [] };
  const t = now ?? nowSec();
  const sorted = [...items].sort((a, b) => a.pubAt - b.pubAt);
  if (sorted.length >= 50) {
    const overlap = sorted.some((i) => i.guid in lib.lbSeen);
    const since = Object.keys(lib.lbSeen).length ? lib.lbLastSync : lib.lbImportAt;
    if (!overlap && since !== undefined && sorted[0].pubAt > since) res.gap = true;
  }
  for (const it of sorted) {
    // The feed's TMDB id is authoritative. If the export's title match put
    // this film under another id, move its Letterboxd data to the right one.
    const key = filmKey(it.title, it.year);
    const old = lib.lbKeys[key];
    if (old !== undefined && old !== it.tmdbId) {
      const from = lib.entries.get(old);
      if (from?.hasLetterboxd) {
        const to = lib.entry(it.tmdbId);
        if (from.lbRating !== undefined && (to.lbSrcAt === undefined || (from.lbSrcAt ?? 0) > to.lbSrcAt)) {
          to.lbRating = from.lbRating;
          to.lbRatingAt = from.lbRatingAt;
          to.lbSrcAt = from.lbSrcAt;
        }
        to.lbWatched = to.lbWatched || from.lbWatched;
        if (from.lbWatchedAt !== undefined && (to.lbWatchedAt === undefined || from.lbWatchedAt > to.lbWatchedAt)) to.lbWatchedAt = from.lbWatchedAt;
        to.lbLiked = to.lbLiked || from.lbLiked;
        to.favorite = to.favorite || from.favorite;
        to.lbRewatch = to.lbRewatch || from.lbRewatch;
        for (const d of from.watchDates) if (!to.watchDates.includes(d)) to.watchDates.push(d);
        from.clearLetterboxd();
        res.updated++;
        res.ids.push(it.tmdbId);
        lib.touch();
      }
    }
    if (old !== undefined) lib.lbKeys[key] = it.tmdbId;
    const prev = lib.lbSeen[it.guid];
    if (prev === sig(it)) continue;
    const isNew = !lib.entries.has(it.tmdbId);
    const e = lib.entry(it.tmdbId);
    const at = prev === undefined ? it.pubAt : t;
    const snap = () => `${e.lbRating}|${e.lbWatched}|${e.lbLiked}|${e.watchDates.length}|${e.lbWatchlist}`;
    const before = snap();
    e.lbWatched = true;
    const wAt = dateSec(it.watchedDate) ?? it.pubAt;
    if (e.lbWatchedAt === undefined || wAt > e.lbWatchedAt) e.lbWatchedAt = wAt;
    if (it.watchedDate && !e.watchDates.includes(it.watchedDate)) e.watchDates.push(it.watchedDate);
    if (it.rewatch) e.lbRewatch = true;
    // Among Letterboxd entries the most recent one carries the rating; an
    // edited entry replaces its own earlier value.
    if (it.rating !== undefined && it.pubAt >= (e.lbSrcAt ?? 0)) {
      e.lbRating = it.rating;
      e.lbSrcAt = it.pubAt;
      if (e.lbRatingAt === undefined || at > e.lbRatingAt) e.lbRatingAt = at;
    }
    if (it.liked) e.lbLiked = true;
    if (e.lbWatchlist) {
      e.lbWatchlist = false; // Letterboxd drops watched films from the watchlist
      e.lbWatchlistAt = at;
    }
    lib.lbSeen[it.guid] = sig(it);
    if (isNew) {
      res.added++;
      res.ids.push(it.tmdbId);
    } else if (before !== snap()) {
      res.updated++;
      res.ids.push(it.tmdbId);
    }
  }
  const seen = Object.keys(lib.lbSeen);
  if (seen.length > 400) {
    const keep = new Set(sorted.map((i) => i.guid));
    for (const k of seen.filter((k) => !keep.has(k)).slice(0, seen.length - 400)) delete lib.lbSeen[k];
  }
  if (res.gap) lib.lbGap = true;
  lib.prune();
  lib.lbLastSync = t;
  if (res.added + res.updated > 0) lib.touch();
  return res;
}
