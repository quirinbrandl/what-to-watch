// How much of the rating history does the LLM need? Same prompt as onecall's minimal one, less ratings.
//   --set ratings=all|strong|loved|top50|recent150|nostars
import { labelOf } from '../../../src/core/models';
import { Engine, Known } from '../lab';
import { OUTPUT, parsePicks, ratingsText } from './onecall';

const byStars = (a: Known, b: Known) => b.stars - a.stars || b.at - a.at;

const engine: Engine = async (input, io) => {
  const k = io.num('k', 40);
  const mode = io.param('ratings', 'all');
  let list: Known[] = input.known;
  let shown: string;
  switch (mode) {
    case 'all':
      shown = ratingsText(list);
      break;
    case 'strong':
      list = input.known.filter((x) => x.stars >= 4 || x.stars < 3);
      shown = ratingsText(list);
      break;
    case 'loved':
      list = input.known.filter((x) => x.stars >= 4);
      shown = ratingsText(list);
      break;
    case 'top50':
      list = input.known.slice(0, 50);
      shown = ratingsText(list);
      break;
    case 'recent150':
      list = [...input.known].sort((a, b) => b.at - a.at).slice(0, 150).sort(byStars);
      shown = ratingsText(list);
      break;
    case 'nostars': {
      const line = (name: string, items: Known[]) => (items.length ? `${name}: ${items.map((x) => labelOf(x.film)).join('; ')}` : '');
      shown = [
        line('Loved', input.known.filter((x) => x.stars >= 4)),
        line('Liked', input.known.filter((x) => x.stars === 3 || x.stars === 3.5)),
        line('Did not like', input.known.filter((x) => x.stars < 3)),
      ]
        .filter(Boolean)
        .join('\n');
      break;
    }
    default:
      throw new Error('unknown ratings mode');
  }
  const head = mode === 'nostars' ? 'My film ratings:' : 'My film ratings (0.5 to 5 stars):';
  const developer = 'You recommend films.';
  const user = `${head}\n${shown}\n\nRecommend ${k} films I have not rated that I would love, best first. Only films released in ${input.cutoffYear} or earlier.\n${OUTPUT}`;
  const picks = parsePicks(await io.llm({ developer, user }));
  io.note('shown', mode === 'nostars' ? input.known.length : list.length);
  return (await io.resolveAll(picks)).map((f) => f.id);
};

export default engine;
