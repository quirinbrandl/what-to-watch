import { minPrompt, parsePicks, ratingsText } from './onecall';
import { Engine } from '../lab';
import { extractJson } from '../../../src/core/llm';
import { labelOf } from '../../../src/core/models';

const engine: Engine = async (input, io) => {
  const picks = parsePicks(await io.llm(minPrompt(input, io.num('k', 60))));
  let films = await io.resolveAll(picks);
  const seen = new Set<number>(input.known.map((k) => k.film.id));
  films = films.filter((f) => {
    if (seen.has(f.id)) return false;
    seen.add(f.id);
    const y = f.release && f.release.length >= 4 ? parseInt(f.release.slice(0, 4), 10) : NaN;
    return Number.isFinite(y) && y <= input.cutoffYear;
  });
  if (!films.length) return [];
  const text = await io.llm({
    developer: 'You predict how a person will rate films.',
    user: `My film ratings (0.5 to 5 stars):\n${ratingsText(input.known)}\n\nPredict the rating I would give each of these films I have not rated:\n${films.map((f, i) => `${i + 1}. ${labelOf(f)}`).join('\n')}\n\nAnswer with JSON only: {"r":[[1,4.5],[2,3.0]]} (film number, predicted stars)`,
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
    .map((f, i) => ({ id: f.id, i, s: pred.get(i) ?? -1 }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.id);
};

export default engine;
