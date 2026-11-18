// The engine as the app ships it (src/core/engine/recommender.ts), run on the test people with
// no typed request, the dial in the middle and no filter except the test's own year limit.
// In that state the app sends the questions of combo.ts (k=60, judge=stars, judgeRatings=words)
// word for word, so most answers come from the LLM cache: this run is the check that the app's
// engine is the tested one.
//   --set model=<slug>      required
//   --set obscurity=0.5     the mainstream ↔ niche dial (0 … 1); 0.5 says nothing
//   --set prompt=…          a typed request
import { Recommender, engineConfig } from '../../../src/core/engine/recommender';
import { Services, newRequest } from '../../../src/core/engine/request';
import { Llm } from '../../../src/core/llm';
import { Library } from '../../../src/core/models';
import { Engine, EngineInput, EngineIo } from '../lab';

/** Routes the engine's LLM calls through the lab client (cache, token counts). */
class Adapter extends Llm {
  constructor(private io: EngineIo) {
    super(async () => '');
  }
  override async respond(opts: Parameters<Llm['respond']>[0]): Promise<string> {
    if (typeof opts.user !== 'string') throw new Error('image input is not supported in the lab');
    const text = await this.io.llm({ developer: opts.developer, user: opts.user, model: opts.model, effort: opts.effort });
    opts.onText?.(text);
    return text;
  }
}

/** The visible ratings as an app library, each with the time it was given (the questions list the most recent first). */
function library(input: EngineInput): Library {
  const lib = new Library();
  for (const k of input.known) {
    const e = lib.entry(k.film.id);
    e.myRating = k.stars;
    e.myRatingAt = k.at;
  }
  return lib;
}

const engine: Engine = async (input, io) => {
  const rec = new Recommender(io.data.tmdb, new Adapter(io), library(input), new Services('DE'), engineConfig(io.param('model', ''), { effort: io.param('effort', 'low') }));
  const s = await rec.start(newRequest({ yearMax: input.cutoffYear, obscurity: io.num('obscurity', 0.5), prompt: io.param('prompt', '') }));
  io.data.touch();
  io.note('films', s.picks.length);
  return s.picks.map((p) => p.film.id);
};

export default engine;
