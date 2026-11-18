import { OUTPUT, minPrompt, parsePicks, ratingsText } from './onecall';
import { Engine } from '../lab';

const engine: Engine = async (input, io) => {
  const k = io.num('k', 30);
  const a = minPrompt(input, k);
  const b = {
    developer: a.developer,
    user: `My film ratings (0.5 to 5 stars):\n${ratingsText(input.known).split('\n').reverse().join('\n')}\n\nRecommend ${k} films I have not rated that I would love, best first. Only films released in ${input.cutoffYear} or earlier.\n${OUTPUT}`,
  };
  const [ta, tb] = await Promise.all([io.llm(a), io.llm(b)]);
  const [fa, fb] = await Promise.all([io.resolveAll(parsePicks(ta)), io.resolveAll(parsePicks(tb))]);
  const info = new Map<number, { points: number; best: number; order: number; n: number }>();
  fa.forEach((f, pos) => {
    if (info.has(f.id)) return;
    info.set(f.id, { points: k - pos, best: pos, order: pos, n: 1 });
  });
  const seenB = new Set<number>();
  fb.forEach((f, pos) => {
    if (seenB.has(f.id)) return;
    seenB.add(f.id);
    const e = info.get(f.id);
    if (e) {
      e.points += k - pos;
      e.best = Math.min(e.best, pos);
      e.n++;
    } else info.set(f.id, { points: k - pos, best: pos, order: 1e9 + pos, n: 1 });
  });
  io.note('both', [...info.values()].filter((e) => e.n === 2).length);
  return [...info.entries()]
    .sort((x, y) => y[1].points - x[1].points || x[1].best - y[1].best || x[1].order - y[1].order)
    .map(([id]) => id);
};

export default engine;
