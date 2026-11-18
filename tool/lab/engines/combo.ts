// Combinations of the steps that helped on their own (see README: only what is proven stays).
//   --set ratings=words        how the ratings are written in the proposing call(s): words | stars
//   --set asks=1               proposing calls (1–3), each with the ratings listed in a different order, sent at the same time;
//                              films named more often and earlier come first
//   --set k=40                 titles per proposing call
//   --set judge=none           stars = one more call predicts my rating for every candidate; candidates are sorted by it
//   --set judgeRatings=stars   how the ratings are written in the judging call: stars | words
//   --set top=60               how many candidates go to the judge
import { extractJson } from '../../../src/core/llm';
import { Film, labelOf } from '../../../src/core/models';
import { Engine, EngineInput, EngineIo, Known } from '../lab';
import { parsePicks } from './onecall';
import { ask, ratingsBlock } from './prompts';

/** The same ratings written in up to three different orders. */
function orders(known: Known[], format: string, n: number): string[] {
  const a = ratingsBlock(known, format);
  const [head, ...lines] = a.split('\n');
  const b = [head, ...lines.reverse()].join('\n'); // groups in the opposite order
  const c = ratingsBlock([...known].reverse(), format); // same groups, films inside each group in the opposite order
  return [a, b, c].slice(0, Math.max(1, Math.min(3, n)));
}

/** Proposing: one call per ordering, merged so that films named more often and earlier come first. */
export async function propose(input: EngineInput, io: EngineIo, format: string, asks: number, k: number): Promise<Film[]> {
  const a = ask('base', k, input.cutoffYear);
  const texts = await Promise.all(orders(input.known, format, asks).map((block) => io.llm({ developer: a.developer, user: `${block}\n\n${a.request}\n${a.output}` })));
  const lists = await Promise.all(texts.map((t) => io.resolveAll(parsePicks(t))));
  const known = new Set(input.known.map((x) => x.film.id));
  const info = new Map<number, { film: Film; points: number; best: number; order: number; n: number }>();
  lists.forEach((list, li) => {
    const inList = new Set<number>();
    list.forEach((f, pos) => {
      const year = f.release ? parseInt(f.release.slice(0, 4), 10) : NaN;
      if (inList.has(f.id) || known.has(f.id) || !(year <= input.cutoffYear)) return;
      inList.add(f.id);
      const e = info.get(f.id);
      const points = Math.max(1, k - pos);
      if (e) {
        e.points += points;
        e.best = Math.min(e.best, pos);
        e.n++;
      } else info.set(f.id, { film: f, points, best: pos, order: li * 1e6 + pos, n: 1 });
    });
  });
  const all = [...info.values()].sort((x, y) => y.points - x.points || x.best - y.best || x.order - y.order);
  io.note('candidates', all.length);
  if (asks > 1) io.note('namedTwice', all.filter((e) => e.n > 1).length);
  return all.map((e) => e.film);
}

/** Judging: one call predicts the person's rating for each film; sorted by it (ties keep the incoming order). */
export async function judge(input: EngineInput, io: EngineIo, films: Film[], format: string): Promise<Film[]> {
  if (!films.length) return films;
  const list = films.map((f, i) => `${i + 1}. ${labelOf(f)}`).join('\n');
  const request = format === 'stars' ? 'Predict the rating I would give each of these films I have not rated:' : 'Predict the rating (0.5 to 5 stars) I would give each of these films I have not rated:';
  const text = await io.llm({
    developer: 'You predict how a person will rate films.',
    user: `${ratingsBlock(input.known, format)}\n\n${request}\n${list}\n\nAnswer with JSON only: {"r":[[1,4.5],[2,3.0]]} (film number, predicted stars)`,
  });
  const j = extractJson(text);
  const pred = new Map<number, number>();
  if (Array.isArray(j?.r)) {
    for (const e of j!.r as any[]) {
      if (!Array.isArray(e)) continue;
      const n = Number(e[0]);
      const s = Number(e[1]);
      if (Number.isInteger(n) && n >= 1 && n <= films.length && Number.isFinite(s) && !pred.has(n - 1)) pred.set(n - 1, s);
    }
  }
  io.note('predicted', pred.size);
  return films
    .map((film, i) => ({ film, i, s: pred.get(i) ?? -1 }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.film);
}

const engine: Engine = async (input, io) => {
  const films = await propose(input, io, io.param('ratings', 'words'), io.num('asks', 1), io.num('k', 40));
  if (io.param('judge', 'none') === 'none') return films.map((f) => f.id);
  const top = io.num('top', 60);
  const judged = await judge(input, io, films.slice(0, top), io.param('judgeRatings', 'stars'));
  return [...judged, ...films.slice(top)].map((f) => f.id);
};

export default engine;
