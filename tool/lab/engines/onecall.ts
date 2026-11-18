// The simplest LLM engine: one call. Ratings in, a list of titles out.
//   --set model=<slug>      required
//   --set effort=low        reasoning effort (omit to use the model's default)
//   --set k=30              how many titles to ask for (the first 24 valid ones are scored)
// (Runs made with `prompt=app` used the scouting prompt of the old pipeline, which is no longer in the app.)
import { extractJson } from '../../../src/core/llm';
import { labelOf } from '../../../src/core/models';
import { Engine, EngineInput, Known } from '../lab';

/** "5★: Heat (1995); Alien (1979)" — one line per star value, highest first. */
export function ratingsText(known: Known[]): string {
  const groups = new Map<number, string[]>();
  for (const k of known) {
    const g = groups.get(k.stars);
    if (g) g.push(labelOf(k.film));
    else groups.set(k.stars, [labelOf(k.film)]);
  }
  return [...groups.keys()]
    .sort((a, b) => b - a)
    .map((s) => `${s}★: ${groups.get(s)!.join('; ')}`)
    .join('\n');
}

/** Reads {"picks":[{"t":"title","y":1999}]} from model output. */
export function parsePicks(text: string): { t: string; y?: number }[] {
  const j = extractJson(text);
  let list = Array.isArray(j?.picks) ? (j!.picks as any[]) : [];
  if (!list.length) {
    // The answer was not valid JSON as a whole (e.g. one broken entry): read the entries one by one.
    for (const m of text.matchAll(/\{[^{}]*\}/g)) {
      try {
        list.push(JSON.parse(m[0]));
      } catch {}
    }
  }
  return list
    .filter((p) => p && typeof p.t === 'string' && p.t.trim())
    .map((p) => {
      const y = typeof p.y === 'number' ? Math.trunc(p.y) : parseInt(String(p.y), 10);
      return { t: p.t.trim(), y: Number.isFinite(y) ? y : undefined };
    });
}

export const OUTPUT = 'Answer with JSON only: {"picks":[{"t":"title","y":1999}]}';

export function minPrompt(input: EngineInput, k: number): { developer: string; user: string } {
  return {
    developer: 'You recommend films.',
    user: `My film ratings (0.5 to 5 stars):\n${ratingsText(input.known)}\n\nRecommend ${k} films I have not rated that I would love, best first. Only films released in ${input.cutoffYear} or earlier.\n${OUTPUT}`,
  };
}

const engine: Engine = async (input, io) => {
  const picks = parsePicks(await io.llm(minPrompt(input, io.num('k', 30))));
  io.note('titles', picks.length);
  return (await io.resolveAll(picks)).map((f) => f.id);
};

export default engine;
