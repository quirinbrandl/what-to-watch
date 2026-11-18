// What the engine asks the LLM, and how its answers are read.
//
// Questions 1 and 2 are the ones that won the engine experiments (tool/lab/README.md). With no
// typed request, no filter and the dial in the middle they are sent word for word as tested;
// each feature in use adds one line or one sentence and changes nothing else.
import { extractJson } from '../llm';
import { Entry, Film, GENRES, LANGUAGES, Library, genreNames, labelOf } from '../models';
import { FilmCache } from '../tmdb';
import { Request, Services } from './request';

// ------------------------------------------------------------ the ratings

/** The rated films the LLM is shown: highest rating first, then most recent. */
export function ratedFilms(lib: Library, films: FilmCache, max = 500): Entry[] {
  const recent = (a: Entry, b: Entry) => (b.ratingAt ?? 0) - (a.ratingAt ?? 0);
  let rated = lib.rated.filter((e) => films.get(e.id) !== undefined);
  if (rated.length > max) {
    // A very large library: every strong opinion, then the most recent of the rest.
    const strong = rated.filter((e) => e.rating! >= 4.5 || e.rating! <= 2.5).sort(recent);
    const rest = rated.filter((e) => e.rating! < 4.5 && e.rating! > 2.5).sort(recent);
    rated = [...strong, ...rest].slice(0, max);
  }
  return rated.sort((a, b) => b.rating! - a.rating! || recent(a, b));
}

export interface Ratings {
  text: string; // '' when there is nothing to show
  tags: Record<string, number>; // "L12" -> TMDB id (only when tagged)
}

/**
 * The ratings in three plain groups: loved (4★ and up), liked (3 and 3.5★), did not like.
 * With `tagged`, films rated 3.5★ or higher get a tag ([L12]) that a reason can point to
 * and code can check.
 */
export function ratingsBlock(lib: Library, films: FilmCache, opts: { tagged?: boolean } = {}): Ratings {
  const tags: Record<string, number> = {};
  let n = 0;
  const name = (e: Entry) => {
    const label = labelOf(films.get(e.id)!);
    if (!opts.tagged || e.rating! < 3.5) return label;
    const tag = `L${++n}`;
    tags[tag] = e.id;
    return `[${tag}] ${label}`;
  };
  const rated = ratedFilms(lib, films);
  const line = (title: string, items: Entry[]) => (items.length ? `${title}: ${items.map(name).join('; ')}` : '');
  const lines = [
    line('Loved', rated.filter((e) => e.rating! >= 4)),
    line('Liked', rated.filter((e) => e.rating! >= 3 && e.rating! < 4)),
    line('Did not like', rated.filter((e) => e.rating! < 3)),
  ].filter(Boolean);
  return { text: lines.length ? `My film ratings:\n${lines.join('\n')}` : '', tags };
}

// ------------------------------------------------- what the features add

const listed = (items: string[], word: 'and' | 'or'): string => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`);

/** The typed request, or the film to find more like: one line, in both questions. */
export function wishLine(r: Request, seed?: Film): string {
  if (seed) return `What I want tonight: films like ${labelOf(seed)}, that give a similar experience.`;
  const p = r.prompt.trim().replace(/\s+/g, ' ');
  return p ? `What I want tonight: ${p}` : '';
}

/** One sentence per filter in use. Code enforces every filter anyway; this only saves wasted ideas. */
export function filterSentences(r: Request, sv: Services): string[] {
  const out: string[] = [];
  if (r.yearMin !== undefined && r.yearMax !== undefined) out.push(r.yearMin === r.yearMax ? `Only films released in ${r.yearMin}.` : `Only films released from ${r.yearMin} to ${r.yearMax}.`);
  else if (r.yearMax !== undefined) out.push(`Only films released in ${r.yearMax} or earlier.`);
  else if (r.yearMin !== undefined) out.push(`Only films released in ${r.yearMin} or later.`);
  const genres = r.genres.map((g) => GENRES[g]).filter(Boolean);
  if (genres.length === 1) out.push(`Only ${genres[0]} films.`);
  else if (genres.length) out.push(`Only films that are ${listed(genres, 'and')} at the same time.`);
  const not = r.notGenres.map((g) => GENRES[g]).filter(Boolean);
  if (not.length) out.push(`No ${listed(not, 'or')} films.`);
  // Length is only a leaning here: asked to keep an exact limit, the LLM checks every film's runtime and takes three times as long.
  if (r.runMin !== undefined && r.runMax !== undefined) out.push(`Prefer films around ${r.runMin} to ${r.runMax} minutes long.`);
  else if (r.runMax !== undefined) out.push(`Prefer shorter films, around ${r.runMax} minutes or less.`);
  else if (r.runMin !== undefined) out.push(`Prefer longer films, around ${r.runMin} minutes or more.`);
  if (r.langs.length) out.push(`Only films whose original language is ${listed(r.langs.map((l) => LANGUAGES[l] ?? l), 'or')}.`);
  if (r.streamingOnly && sv.names.length) out.push(`Only films that can be streamed on ${listed(sv.names, 'or')} (country: ${sv.region}).`);
  return out;
}

/** The mainstream ↔ niche dial in its five steps. The middle says nothing. */
export function dialSentence(obscurity: number): string {
  const step = Math.max(0, Math.min(4, Math.round(obscurity * 4)));
  return ['Only well-known films that many people have seen.', 'Prefer well-known films.', '', 'Prefer little-known films.', 'Only little-known films that few people have seen.'][step];
}

// -------------------------------------------------- question 1: propose

export const PROPOSE_ROLE = 'You recommend films.';
const PICKS_FORMAT = 'Answer with JSON only: {"picks":[{"t":"title","y":1999}]}';

/**
 * Question 1: which films would I love? `ratings` is empty when the search is not personal.
 * `avoid` lists films that must not come back (seen without a rating, dismissed, proposed before).
 */
export function proposeUser(ratings: string, r: Request, sv: Services, k: number, opts: { seed?: Film; avoid?: string[] } = {}): string {
  const base = !ratings
    ? `Recommend ${k} great films, best first.`
    : r.excludeWatched
      ? `Recommend ${k} films I have not rated that I would love, best first.`
      : `Recommend ${k} films that I would love to watch, best first. Films I have already seen are welcome.`;
  const ask = [base, ...filterSentences(r, sv), dialSentence(r.obscurity)].filter(Boolean).join(' ');
  const avoid = opts.avoid?.length ? `Do not recommend these: ${opts.avoid.join('; ')}` : '';
  return [ratings, wishLine(r, opts.seed), avoid, `${ask}\n${PICKS_FORMAT}`].filter(Boolean).join('\n\n');
}

export interface Idea {
  t: string;
  y?: number;
}

/** One {"t":"title","y":1999} entry, or undefined when it is something else. */
export function ideaOf(p: any): Idea | undefined {
  if (!p || typeof p.t !== 'string' || !p.t.trim()) return undefined;
  const y = typeof p.y === 'number' ? Math.trunc(p.y) : parseInt(String(p.y), 10);
  return { t: p.t.trim(), y: Number.isFinite(y) ? y : undefined };
}

/** Reads the answer to question 1. When it is broken as a whole (one bad entry), the entries are read one by one. */
export function parsePicks(text: string): Idea[] {
  const j = extractJson(text);
  const list: unknown[] = Array.isArray(j?.picks) ? j!.picks : [];
  if (!list.length) {
    for (const m of text.matchAll(/\{[^{}]*\}/g)) {
      try {
        list.push(JSON.parse(m[0]));
      } catch {}
    }
  }
  return list.map(ideaOf).filter((x): x is Idea => !!x);
}

// ----------------------------------------------------- question 2: rate

export const RATE_ROLE = 'You predict how a person will rate films.';
const STARS_FORMAT = 'Answer with JSON only: {"r":[[1,4.5],[2,3.0]]} (film number, predicted stars)';

/** A film the LLM cannot know (released after its training), described by its facts. */
export function factsLine(f: Film): string {
  const overview = f.overview.length > 220 ? `${f.overview.slice(0, 220)}…` : f.overview;
  return [
    labelOf(f),
    genreNames(f).join(', '),
    f.lang && f.lang !== 'en' ? LANGUAGES[f.lang] ?? f.lang : '',
    f.directors.length ? `directed by ${f.directors.slice(0, 2).join(', ')}` : '',
    f.cast.length ? `with ${f.cast.slice(0, 3).join(', ')}` : '',
    f.votes > 0 ? `TMDB users give it ${f.vote.toFixed(1)}` : '',
    overview,
  ]
    .filter(Boolean)
    .join(' | ');
}

/** Question 2: how would I rate each of these? With `facts`, for new releases the LLM is told about. */
export function rateUser(ratings: string, films: Film[], opts: { wish?: string; facts?: boolean } = {}): string {
  const ask = opts.facts
    ? 'Predict the rating (0.5 to 5 stars) I would give each of these films I have not rated. They are new films you may not know, so each comes with its facts:'
    : 'Predict the rating (0.5 to 5 stars) I would give each of these films I have not rated:';
  const list = films.map((f, i) => `${i + 1}. ${opts.facts ? factsLine(f) : labelOf(f)}`).join('\n');
  return [ratings, opts.wish ?? '', `${ask}\n${list}`, STARS_FORMAT].filter(Boolean).join('\n\n');
}

/** Reads the answer to question 2 for `n` films: index in the list (from 0) -> stars. */
export function parseStars(text: string, n: number): Map<number, number> {
  const j = extractJson(text);
  let rows: unknown[] = Array.isArray(j?.r) ? j!.r : [];
  if (!rows.length) rows = [...text.matchAll(STAR_PAIR)].map((m) => [m[1], m[2]]); // broken as a whole: pair by pair
  const out = new Map<number, number>();
  for (const e of rows) {
    if (!Array.isArray(e)) continue;
    const i = Number(e[0]);
    const s = Number(e[1]);
    if (Number.isInteger(i) && i >= 1 && i <= n && Number.isFinite(s) && !out.has(i - 1)) out.set(i - 1, Math.min(5, Math.max(0.5, s)));
  }
  return out;
}

/** One [film number, stars] pair in an answer to question 2. */
export const STAR_PAIR = /\[\s*(\d+)\s*,\s*(\d+(?:\.\d+)?)\s*\]/g;
/** One complete {...} entry without anything nested: a pick in answer 1, a line of reasons. */
export const ENTRY = /\{[^{}]*\}/g;

/**
 * For an answer that arrives piece by piece: returns a function that takes the text so far
 * and hands every newly completed match of `pattern` to `each`, once.
 */
export function reader(pattern: RegExp, each: (m: RegExpExecArray) => void): (text: string) => void {
  const re = new RegExp(pattern.source, 'g');
  let read = 0;
  return (text) => {
    re.lastIndex = read;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      read = re.lastIndex;
      each(m);
    }
  };
}

// ------------------------------------------------------------- reasons

export const WHY_ROLE = 'You explain film recommendations.';

/**
 * Why each film fits. `ratings` must be the tagged block (or empty when the search is not
 * personal); films flagged `facts` are new releases and come with their facts.
 */
export function whyUser(ratings: string, films: { film: Film; facts?: boolean }[], wish = ''): string {
  const ask = ratings
    ? 'These films were recommended to me. For each one, tell me in one or two sentences (at most 35 words) why it suits me: its tone, craft or themes, speaking to me as "you". Point to one or two of my films above that it has something in common with, using only their tags, like "has the patient dread of [L12]". Write no other film titles, no star ratings and no spoilers.'
    : 'These films were recommended to me. For each one, tell me in one or two sentences (at most 35 words) why it is worth my evening: its tone, craft or themes, speaking to me as "you". Write no other film titles and no spoilers.';
  const list = films.map((x, i) => `${i + 1}. ${x.facts ? factsLine(x.film) : labelOf(x.film)}`).join('\n');
  return [ratings, wish, `${ask}\n${list}`, 'Answer with JSON Lines only, one line per film: {"n":1,"why":"…"}'].filter(Boolean).join('\n\n');
}

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
