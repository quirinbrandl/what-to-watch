// One LLM call that sees the graph candidates.
//   --set source=list   the LLM may only choose from the candidates
//   --set source=both   the LLM recommends freely, the candidates are suggestions
//   --set candidates=120  --set k=40
import { extractJson } from '../../../src/core/llm';
import { labelOf } from '../../../src/core/models';
import { Engine } from '../lab';
import { graphCandidates } from './graph';
import { OUTPUT, parsePicks } from './onecall';
import { ratingsBlock } from './prompts';

const engine: Engine = async (input, io) => {
  const k = io.num('k', 40);
  const mode = io.param('source', 'list');
  const cands = graphCandidates(input, io).slice(0, io.num('candidates', 120)).map((c) => c.film);
  const developer = 'You recommend films.';
  if (mode === 'list') {
    const user = `${ratingsBlock(input.known, 'words')}\n\nCandidates:\n${cands.map((f, i) => `${i + 1}. ${labelOf(f)}`).join('\n')}\n\nChoose the ${k} candidates I would love most, best first.\nAnswer with JSON only: {"picks":[12,5,33]} (candidate numbers)`;
    const j = extractJson(await io.llm({ developer, user }));
    const raw: any[] = Array.isArray(j?.picks) ? j!.picks : [];
    const seen = new Set<number>();
    const ids: number[] = [];
    for (const n of raw) {
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > cands.length || seen.has(n)) continue;
      seen.add(n);
      ids.push(cands[n - 1].id);
    }
    io.note('chosen', ids.length);
    return ids;
  }
  if (mode === 'both') {
    const user = `${ratingsBlock(input.known, 'words')}\n\nFilms that viewers of my favourites often like: ${cands.map((f) => labelOf(f)).join('; ')}\n\nRecommend ${k} films I have not rated that I would love, best first. You may use films from that list or any other film. Only films released in ${input.cutoffYear} or earlier.\n${OUTPUT}`;
    const text = await io.llm({ developer, user });
    const films = await io.resolveAll(parsePicks(text));
    const set = new Set(cands.map((f) => f.id));
    io.note('fromList', films.filter((f) => set.has(f.id)).length);
    return films.map((f) => f.id);
  }
  throw new Error('unknown source');
};

export default engine;
