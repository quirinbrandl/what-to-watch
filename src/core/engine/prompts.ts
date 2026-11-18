import { Entry, Film, GENRES, LANGUAGES, Library, genreNames, labelOf } from '../models';
import { FilmCache } from '../tmdb';
import { Request, Services, hasPrompt } from './request';
import { TasteModel } from './taste';

const stars = (r: number) => `${r}★`;

/** The user's taste evidence as compact text for the LLM. */
export interface TasteBrief {
  text: string;
  tags: Record<string, number>; // "L12" -> TMDB id (only when tagged)
}

/**
 * `tagged` prefixes every rated film with a reference tag ([L12]) so the
 * judge can cite films in a way code can verify. `hide` omits films
 * (evaluation hold-out).
 */
export function tasteBrief(
  lib: Library,
  films: FilmCache,
  model: TasteModel | undefined,
  opts: { tagged?: boolean; hide?: Set<number>; maxRated?: number; listSeen?: boolean } = {},
): TasteBrief {
  const { tagged = false, hide = new Set<number>(), maxRated = 320, listSeen = true } = opts;
  const lines: string[] = [];
  const tags: Record<string, number> = {};
  const name = (id: number) => labelOf(films.get(id)!);
  const known = (e: Entry) => !hide.has(e.id) && films.get(e.id) !== undefined;

  let rated = lib.rated.filter(known);
  if (rated.length > maxRated) {
    // Keep every strong opinion, fill up with the most recent of the rest.
    const strong = rated.filter((e) => e.rating! >= 4.5 || e.rating! <= 2.5 || e.favorite);
    const rest = rated.filter((e) => !strong.includes(e)).sort((a, b) => (b.ratingAt ?? 0) - (a.ratingAt ?? 0));
    rated = [...strong, ...rest.slice(0, Math.max(0, maxRated - strong.length))];
  }
  if (rated.length) {
    const mean = rated.reduce((a, e) => a + e.rating!, 0) / rated.length;
    lines.push(`RATINGS by this user (0.5–5★, their average is ${mean.toFixed(1)}★, ♥ = also liked):`);
    const groups = new Map<number, Entry[]>();
    for (const e of rated) {
      const g = groups.get(e.rating!);
      if (g) g.push(e);
      else groups.set(e.rating!, [e]);
    }
    let n = 0;
    for (const r of [...groups.keys()].sort((a, b) => b - a)) {
      const items = groups.get(r)!.sort((a, b) => (b.ratingAt ?? 0) - (a.ratingAt ?? 0));
      lines.push(
        `${stars(r)}: ${items
          .map((e) => {
            let s = name(e.id);
            if (tagged) {
              const tag = `L${++n}`;
              tags[tag] = e.id;
              s = `[${tag}] ${s}`;
            }
            return e.liked ? `${s} ♥` : s;
          })
          .join('; ')}`,
      );
    }
  }
  const names = (es: Entry[], max: number) => es.filter(known).slice(0, max).map((e) => name(e.id));
  const all = lib.all();
  const fav = names(all.filter((e) => e.favorite), 20);
  if (fav.length) lines.push(`ALL-TIME FAVOURITES: ${fav.join('; ')}`);
  const re = names(all.filter((e) => e.rewatched && !e.favorite), 20);
  if (re.length) lines.push(`REWATCHED: ${re.join('; ')}`);
  const wl = names(lib.watchlist.sort((a, b) => (b.watchlistAt ?? 0) - (a.watchlistAt ?? 0)), 60);
  if (wl.length) lines.push(`WATCHLIST (unseen, wants to see): ${wl.join('; ')}`);
  const ni = names(all.filter((e) => e.notInterested), 40);
  if (ni.length) lines.push(`NOT INTERESTED (dismissed): ${ni.join('; ')}`);
  if (listSeen) {
    const seen = names(all.filter((e) => e.watched && e.rating === undefined), 120);
    if (seen.length) lines.push(`SEEN, UNRATED: ${seen.join('; ')}`);
  }
  if (model && model.rated >= 12) {
    const parts = [
      model.top('g').length ? `rates above their average: ${model.top('g', 5).join(', ')}` : '',
      model.top('g', 6, false).length ? `below their average: ${model.top('g', 4, false).join(', ')}` : '',
      model.top('d').length ? `directors: ${model.top('d', 6).join(', ')}` : '',
      model.top('k').length ? `recurring themes in high ratings: ${model.top('k', 8).join(', ')}` : '',
      model.top('k', 6, false).length ? `themes in low ratings: ${model.top('k', 6, false).join(', ')}` : '',
    ].filter(Boolean);
    if (parts.length) lines.push(`PATTERNS (computed statistics, weaker evidence than the ratings): ${parts.join(' · ')}`);
  }
  return { text: lines.join('\n').trim(), tags };
}

/**
 * Tonight's request as text. Hard filters are stated so the LLM does not
 * waste picks, but they are enforced by code regardless.
 */
export function requestBrief(r: Request, sv: Services, seed?: Film): string {
  const lines: string[] = [];
  if (seed) lines.push(`MORE LIKE: ${labelOf(seed)} — films that give a similar experience, not just the same genre.`);
  if (hasPrompt(r)) lines.push(`REQUEST (in the user's words): "${r.prompt.trim()}"`);
  else if (!seed) lines.push('REQUEST: none — a great film for tonight.');
  const hard = [
    r.genres.length ? `must be ${r.genres.map((g) => GENRES[g]).join(' AND ')}` : '',
    r.notGenres.length ? `must not be ${r.notGenres.map((g) => GENRES[g]).join(' or ')}` : '',
    r.yearMin !== undefined || r.yearMax !== undefined ? `released ${r.yearMin ?? '…'}–${r.yearMax ?? 'today'}` : '',
    r.runMin !== undefined || r.runMax !== undefined ? `runtime ${r.runMin ?? 0}–${r.runMax ?? '∞'} min` : '',
    r.langs.length ? `original language: ${r.langs.map((l) => LANGUAGES[l] ?? l).join(' or ')}` : '',
    r.streamingOnly && sv.names.length ? `must be streaming in ${sv.region} on: ${sv.names.join(', ')}` : '',
  ].filter(Boolean);
  if (hard.length) lines.push(`HARD FILTERS: ${hard.join('; ')}.`);
  const o = r.obscurity;
  lines.push(
    `FAMILIAR↔OBSCURE: ${
      o < 0.2
        ? 'well-known, widely loved films'
        : o < 0.4
          ? 'lean towards well-known films'
          : o <= 0.6
            ? 'balanced mix of known films and discoveries'
            : o <= 0.8
              ? 'lean towards lesser-known films and discoveries'
              : 'deep cuts: films most people have not heard of'
    }.`,
  );
  if (!r.excludeWatched) lines.push('Rewatches are allowed: films the user has already seen may be suggested when they fit.');
  if (r.excludeWatchlist) lines.push("Films on the user's WATCHLIST are excluded tonight: do not propose them.");
  return lines.join('\n').trim();
}

export const ideationSystem = `You are the scouting stage of a personal film recommender. You know cinema deeply: mainstream, arthouse, world cinema, classics and deep cuts.

Goal: propose feature films this specific user would rate 3★ or higher after watching — ideally 4★+ ("that was worth my evening"). Fit to their personal taste comes first, tonight's request second, everything else third.

How to work: study what separates their 4.5–5★ films from their ≤2.5★ films — tone, pacing, craft, themes, eras, directors, not just genres. Pick what a perceptive friend with exactly their taste would pick. Stay away from films that resemble what they rated low. Mix confident picks with a few well-reasoned stretches.

Rules:
- Real, released feature films only (no series, shorts, or unreleased films). Give the common English release title (or the original title) and the release year.
- Never propose a film listed under RATINGS, SEEN, NOT INTERESTED or ALREADY SUGGESTED (unless rewatches are allowed).
- Obey every HARD FILTER. Code verifies them against TMDB and discards violations.
- Follow the FAMILIAR↔OBSCURE preference.
- Watchlist films are allowed when they truly fit tonight, but at most a quarter of the picks.
- Spread the picks across directors, decades and countries unless the request narrows them.

Output one JSON object and nothing else:
{"seeds":[{"t":"title","y":1999}],"picks":[{"t":"title","y":1999}]}
"seeds": films the request text itself names as a reference point (empty list if none).
"picks": exactly the requested number of films, best first.`;

export const ideationSystemGeneric = `You are the scouting stage of a film recommender. The user switched personalisation off, so ignore personal taste: propose excellent, widely admired feature films that fit tonight's request.

Rules:
- Real, released feature films only. Give the common English release title (or the original title) and the release year.
- Never propose a film listed under SEEN, NOT INTERESTED or ALREADY SUGGESTED (unless rewatches are allowed).
- Obey every HARD FILTER. Code verifies them against TMDB and discards violations.
- Follow the FAMILIAR↔OBSCURE preference. Spread picks across directors, decades and countries unless the request narrows them.

Output one JSON object and nothing else:
{"seeds":[{"t":"title","y":1999}],"picks":[{"t":"title","y":1999}]}
"seeds": films the request text itself names as a reference point (empty list if none).
"picks": exactly the requested number of films, best first.`;

export const ideationUser = (taste: string, request: string, n: number, already: string[]): string =>
  [taste, request, already.length ? `ALREADY SUGGESTED (do not repeat): ${already.join('; ')}` : '', `Propose ${n} films.`].filter(Boolean).join('\n\n');

export const judgeSystem = `You are the judging stage of a personal film recommender. For every candidate, predict how THIS user would rate the film after watching it, and how well it fits tonight's request.

Use what you know about each film — tone, pacing, craft, reputation, how viewers with similar taste respond — together with the user's ratings. The metadata shown only identifies the film; your knowledge of it matters more. Be calibrated to this user: use their scale in 0.5 steps, and be honest about likely misses. A falsely high score wastes their evening; below 3★ counts as a miss.

Output JSON Lines — one line per candidate, in the given order, nothing else:
{"c":7,"r":4.0,"m":8,"why":"…"}

"r": predicted rating by this user, 0.5–5.
"m": 0–10, fit to tonight's request text and soft preferences (10 = exactly what was asked for, 5 = loosely related, 0 = contradicts it). Without request text, judge how good an evening pick it is for this user.
"why": at most 38 words, spoken to the user ("you"), concrete about why this film suits them and tonight's request: tone, craft, themes. Anchor it in their taste by referring to one or two films they rated 3.5★ or higher, using ONLY the tag form, e.g. "has the patient dread of [L12]" (the app prints the title). Never write the title of any film other than through a tag (a film the user names in tonight's request is the one exception), never state star ratings, never invent facts about the user, and reveal nothing beyond the basic premise — no spoilers. If no honest anchor exists, describe the film's appeal for tonight without one.`;

export const judgeSystemGeneric = `You are the judging stage of a film recommender. Personalisation is off. For every candidate, estimate how much a general film lover would enjoy it and how well it fits tonight's request.

Output JSON Lines — one line per candidate, in the given order, nothing else:
{"c":7,"r":4.0,"m":8,"why":"…"}

"r": expected enjoyment on a 0.5–5 star scale.
"m": 0–10, fit to tonight's request (10 = exactly what was asked for, 5 = loosely related, 0 = contradicts it).
"why": at most 38 words, spoken to the user ("you"), concrete about why this film suits tonight's request: tone, craft, themes. Never write the title of any other film, never invent facts about the user, and reveal nothing beyond the basic premise — no spoilers.`;

export function candidateLine(n: number, f: Film): string {
  const votes = f.votes >= 1000 ? `${(f.votes / 1000).toFixed(1)}k` : `${f.votes}`;
  const ov = f.overview.length > 170 ? `${f.overview.slice(0, 170)}…` : f.overview;
  return [
    `C${n}`,
    labelOf(f),
    (f.runtime ?? 0) > 0 ? `${f.runtime} min` : '',
    genreNames(f).join(', '),
    f.lang && f.lang !== 'en' ? LANGUAGES[f.lang] ?? f.lang : '',
    f.directors.length ? `dir. ${f.directors.slice(0, 2).join(', ')}` : '',
    f.cast.length ? `cast: ${f.cast.slice(0, 3).join(', ')}` : '',
    f.keywords.length ? `themes: ${f.keywords.slice(0, 7).map((k) => k.name).join(', ')}` : '',
    `TMDB ${f.vote.toFixed(1)} (${votes} votes)`,
    ov,
  ]
    .filter(Boolean)
    .join(' | ');
}

export const judgeUser = (taste: string, request: string, candidates: Film[]): string =>
  [taste, request, `CANDIDATES:\n${candidates.map((f, i) => candidateLine(i + 1, f)).join('\n')}`].filter(Boolean).join('\n\n');

export interface Why {
  text: string;
  refs: number[]; // library films the text refers to
}

/**
 * Checks an LLM-written "why" against the user's real data. Every film it
 * refers to must be a tagged library film the user rated ≥ 3.5★; star
 * claims are not allowed (the app shows real ratings itself). Sentences that
 * fail are removed. Returns undefined when too little survives, in which
 * case a deterministic explanation is used instead.
 */
export function validateWhy(raw: string, tags: Record<string, number>, lib: Library, films: FilmCache): Why | undefined {
  const clean = raw.trim().replace(/\s+/g, ' ');
  if (clean.length < 12 || clean.length > 480) return undefined;
  const refs: number[] = [];
  const kept: string[] = [];
  // Judge sentence by sentence: one unverifiable claim should not cost the
  // user the rest of an otherwise sound explanation.
  for (const sentence of clean.match(/[^.!?]+[.!?]*\s*/g) ?? [clean]) {
    if (/\d\s*(★|stars?\b|\/\s*5|out of)/.test(sentence) || sentence.includes('★')) continue;
    let bad = false;
    const local: number[] = [];
    const text = sentence.replace(/\[\s*(L\d+)\s*\]|\b(L\d+)\b/g, (_m, a, b) => {
      const id = tags[a ?? b];
      const e = id === undefined ? undefined : lib.get(id);
      const f = id === undefined ? undefined : films.get(id);
      if (!e || !f || (e.rating ?? 0) < 3.5) {
        bad = true;
        return '';
      }
      local.push(id);
      return f.title;
    });
    if (bad || text.includes('[') || text.includes(']')) continue;
    kept.push(text);
    for (const id of local) if (!refs.includes(id)) refs.push(id);
  }
  const text = kept.join('').trim();
  return text.length >= 40 || (text.length >= 12 && kept.length > 0 && text.length === clean.length) ? { text, refs } : undefined;
}
