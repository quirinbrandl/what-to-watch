// Classic "people who liked this also liked" data (film.recs from TMDB), no LLM.
import { Film, scoreOf } from '../../../src/core/models';
import { Engine, EngineInput, EngineIo } from '../lab';

export function graphCandidates(input: EngineInput, io: EngineIo): { film: Film; points: number }[] {
  const points = new Map<number, number>();
  for (const k of input.known) {
    if (k.stars < 4) continue;
    for (const id of k.film.recs ?? []) points.set(id, (points.get(id) ?? 0) + 1);
  }
  const known = new Set(input.known.map((k) => k.film.id));
  const out: { film: Film; points: number }[] = [];
  for (const [id, p] of points) {
    if (known.has(id)) continue;
    const film = io.data.films.get(id);
    if (!film || !film.release || +film.release.slice(0, 4) > input.cutoffYear) continue;
    out.push({ film, points: p });
  }
  return out.sort((a, b) => b.points - a.points || scoreOf(b.film) - scoreOf(a.film) || a.film.id - b.film.id);
}

const engine: Engine = async (input, io) => {
  const all = graphCandidates(input, io);
  io.note('candidates', all.length);
  return all.slice(0, 60).map((c) => c.film.id);
};

export default engine;
