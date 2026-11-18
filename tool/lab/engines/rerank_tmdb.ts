// Same single LLM call as onecall (k=60), then reorder with public TMDB data only.
//   --set k=60
//   --set mode=score   sort by TMDB score (scoreOf), descending
//   --set mode=blend   sum of LLM position and score position, ascending (ties: LLM order)
import { scoreOf } from '../../../src/core/models';
import { Engine } from '../lab';
import { OUTPUT, minPrompt, parsePicks } from './onecall';

void OUTPUT;

const engine: Engine = async (input, io) => {
  const k = io.num('k', 60);
  const picks = parsePicks(await io.llm(minPrompt(input, k)));
  const films = await io.resolveAll(picks);
  io.note('titles', picks.length);

  const known = new Set(input.known.map((x) => x.film.id));
  const kept = films.filter((f) => {
    if (known.has(f.id)) return false;
    const y = f.release ? parseInt(f.release.slice(0, 4), 10) : NaN;
    return Number.isFinite(y) && y <= input.cutoffYear;
  });

  if (io.param('mode', 'score') === 'blend') {
    const llmPos = new Map<number, number>();
    kept.forEach((f, i) => llmPos.set(f.id, i));
    const byScore = [...kept].sort((a, b) => scoreOf(b) - scoreOf(a));
    const scorePos = new Map<number, number>();
    byScore.forEach((f, i) => scorePos.set(f.id, i));
    const sum = (f: (typeof kept)[number]) => llmPos.get(f.id)! + scorePos.get(f.id)!;
    return [...kept]
      .sort((a, b) => sum(a) - sum(b) || llmPos.get(a.id)! - llmPos.get(b.id)!)
      .map((f) => f.id);
  }
  return [...kept].sort((a, b) => scoreOf(b) - scoreOf(a)).map((f) => f.id);
};

export default engine;
