// An agent: before it answers, the LLM may look things up on TMDB in several rounds.
// It decides itself what to look up, how often, and when to give its final list.
// (The lookups are requested as JSON and run here; the results go back in the next call. That is what tool calling does.)
//   --set rounds=3     rounds of lookups it may use
//   --set start=free   free = it may answer at once without any lookup; lookup = its first step must be lookups
//   --set perRound=8   lookups per round
//   --set k=60         titles in the final answer
//   --set judge=none   stars = one more call predicts my rating for every film and the list is sorted by it (as in combo.ts)
import { extractJson } from '../../../src/core/llm';
import { Film, GENRES, genreNames, labelOf } from '../../../src/core/models';
import { Engine, EngineInput, EngineIo } from '../lab';
import { judge } from './combo';
import { parsePicks } from './onecall';
import { ratingsBlock } from './prompts';

const DEVELOPER = `You recommend films. Before you answer you may look things up in a film database.

Lookups:
{"tool":"similar","film":"Heat","year":1995} = films that viewers of this film also liked
{"tool":"person","name":"Michael Mann"} = the best-known films of a director or actor
{"tool":"find","genre":"Thriller","from":1970,"to":1989} = the best-rated films of a genre in those years
{"tool":"film","film":"Thief","year":1981} = facts about one film: director, cast, genres, plot

The number after a film in a result is its public score out of 10.
To look things up, answer with JSON only: {"calls":[ ... ]}
To give your final answer, answer with JSON only: {"picks":[{"t":"title","y":1999}]}`;

type Item = { id: number; title: string; year: number; vote: number; votes: number };
const yearOf = (date: unknown): number => (typeof date === 'string' && date.length >= 4 ? parseInt(date.slice(0, 4), 10) : NaN);
const fromFilm = (f: Film): Item => ({ id: f.id, title: f.title, year: yearOf(f.release), vote: f.vote, votes: f.votes });
const fromRaw = (r: any): Item => ({ id: r.id, title: String(r.title ?? ''), year: yearOf(r.release_date), vote: +r.vote_average || 0, votes: +r.vote_count || 0 });
const GENRE_IDS = new Map(Object.entries(GENRES).map(([id, name]) => [name.toLowerCase(), id]));
GENRE_IDS.set('science fiction', GENRE_IDS.get('sci-fi')!);

/** The lookups. Results never contain films the person already rated or films released after their cutoff. */
export class Lookups {
  shown = new Set<number>(); // every film a result has shown
  private known: Set<number>;
  constructor(private input: EngineInput, private io: EngineIo) {
    this.known = new Set(input.known.map((k) => k.film.id));
  }

  private list(items: Item[], n: number): string {
    const out = items.filter((x) => x.title && x.year <= this.input.cutoffYear && !this.known.has(x.id)).slice(0, n);
    for (const x of out) this.shown.add(x.id);
    return out.length ? out.map((x) => `${x.title} (${x.year}) ${x.vote.toFixed(1)}`).join('; ') : 'nothing new';
  }

  async run(c: any): Promise<string> {
    const tmdb = this.io.data.tmdb;
    const year = Number.isFinite(+c?.year) ? Math.trunc(+c.year) : undefined;
    try {
      if (c?.tool === 'similar' || c?.tool === 'film') {
        const f = typeof c.film === 'string' ? await this.io.data.resolve(c.film, year) : undefined;
        if (!f) return `${c.tool} "${c?.film}": film not found`;
        if (c.tool === 'similar') return `Viewers of ${labelOf(f)} also liked: ${this.list((await tmdb.recommendations(f.id)).map(fromFilm), 20)}`;
        const full = await tmdb.details(f.id, 'DE');
        return `${labelOf(full)}: directed by ${full.directors.join(', ') || '?'}; with ${full.cast.slice(0, 4).join(', ') || '?'}; ${genreNames(full).join(', ')}; score ${full.vote.toFixed(1)}; ${full.overview.slice(0, 220)}`;
      }
      if (c?.tool === 'person' && typeof c.name === 'string') {
        const p = (await tmdb.get('/search/person', { query: c.name, include_adult: 'false' }))?.results?.[0];
        if (!p) return `person "${c.name}": not found`;
        const cr = await tmdb.get(`/person/${p.id}/movie_credits`);
        const directed = ((cr?.crew ?? []) as any[]).filter((x) => x.job === 'Director');
        const acted = (cr?.cast ?? []) as any[];
        const films = (p.known_for_department === 'Directing' && directed.length ? directed : [...directed, ...acted]).filter((x) => x && typeof x.id === 'number' && x.adult !== true && (+x.vote_count || 0) >= 20);
        const unique = [...new Map(films.map((x) => [x.id, x])).values()].sort((a, b) => b.vote_count - a.vote_count);
        return `Films of ${p.name}: ${this.list(unique.map(fromRaw), 15)}`;
      }
      if (c?.tool === 'find' && typeof c.genre === 'string') {
        const gid = GENRE_IDS.get(c.genre.trim().toLowerCase());
        if (!gid) return `find "${c.genre}": unknown genre. Genres: ${Object.values(GENRES).join(', ')}`;
        const from = Number.isFinite(+c.from) ? Math.trunc(+c.from) : 1900;
        const to = Math.min(Number.isFinite(+c.to) ? Math.trunc(+c.to) : this.input.cutoffYear, this.input.cutoffYear);
        const films = await tmdb.discover({ with_genres: gid, 'primary_release_date.gte': `${from}-01-01`, 'primary_release_date.lte': `${to}-12-31`, sort_by: 'vote_average.desc', 'vote_count.gte': '300' });
        return `Best-rated ${GENRES[+gid]} films ${from}–${to}: ${this.list(films.map(fromFilm), 20)}`;
      }
      return `unknown lookup ${JSON.stringify(c).slice(0, 80)}`;
    } catch {
      return `${c?.tool} lookup failed`;
    }
  }
}

const engine: Engine = async (input, io) => {
  const k = io.num('k', 60);
  const rounds = io.num('rounds', 3);
  const perRound = io.num('perRound', 8);
  const mustStart = io.param('start', 'free') === 'lookup';
  const lookups = new Lookups(input, io);
  const head = `${ratingsBlock(input.known, 'words')}\n\nRecommend ${k} films I have not rated that I would love, best first. Only films released in ${input.cutoffYear} or earlier.`;
  const log: string[] = [];
  let used = 0; // rounds of lookups that count against the limit
  let ran = 0; // rounds that really ran
  let asked = 0;
  let picks: { t: string; y?: number }[] = [];
  for (let strict = 0; strict < 2; ) {
    const left = rounds - used;
    const next =
      left <= 0
        ? `No lookups left. Give your final answer now${strict ? ', as {"picks":[…]} and nothing else' : ''}.`
        : mustStart && !ran
          ? `Start by looking things up: up to ${perRound} lookups per round, ${left} rounds. After that you can look up more or give your final answer.`
          : `You may look things up now: up to ${perRound} lookups per round, ${left} round${left > 1 ? 's' : ''} left. Or give your final answer.`;
    const user = [head, log.length ? `Your lookups so far:\n${log.join('\n')}` : '', next].filter(Boolean).join('\n\n');
    const text = await io.llm({ developer: DEVELOPER, user });
    const j = extractJson(text);
    const calls: any[] = Array.isArray(j?.calls) ? (j!.calls as any[]).slice(0, perRound) : [];
    if (left > 0 && calls.length && !Array.isArray(j?.picks)) {
      const results = await Promise.all(calls.map((c) => lookups.run(c)));
      log.push(...results.map((r) => `- ${r}`));
      used++;
      ran++;
      asked += calls.length;
      continue;
    }
    picks = parsePicks(text);
    if (picks.length) break;
    if (left > 0) used = rounds; // neither lookups nor picks: ask for the final answer
    else strict++;
  }
  io.note('rounds', ran);
  io.note('lookups', asked);
  io.note('titles', picks.length);
  const films = await io.resolveAll(picks);
  io.note('fromLookups', films.filter((f) => lookups.shown.has(f.id)).length);
  if (io.param('judge', 'none') === 'none') return films.map((f) => f.id);
  const known = new Set(input.known.map((x) => x.film.id));
  const seen = new Set<number>();
  const fresh = films.filter((f) => !known.has(f.id) && !seen.has(f.id) && seen.add(f.id) && yearOf(f.release) <= input.cutoffYear);
  return (await judge(input, io, fresh.slice(0, 60), 'words')).map((f) => f.id);
};

export default engine;
