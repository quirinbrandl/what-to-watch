// Prompt wording, on top of the simplest engine (one call: ratings in, titles out).
//   --set variant=base      base | persona | think | similar | mix | sure   (see `ask` below)
//   --set ratings=words     words = "Loved: … / Liked: … / Did not like: …", stars = one line per star value
//   --set n=20              show only n of the person's ratings (a fixed random sample): how many ratings does it need?
//   --set k=40              how many titles to ask for
import { labelOf } from '../../../src/core/models';
import { Engine, EngineInput, Known } from '../lab';
import { mulberry32 } from '../panel';
import { OUTPUT, parsePicks, ratingsText } from './onecall';

/** The ratings in three plain groups instead of star values. */
export function ratingsWords(known: Known[]): string {
  const line = (name: string, items: Known[]) => (items.length ? `${name}: ${items.map((x) => labelOf(x.film)).join('; ')}` : '');
  return [
    line('Loved', known.filter((x) => x.stars >= 4)),
    line('Liked', known.filter((x) => x.stars >= 3 && x.stars < 4)),
    line('Did not like', known.filter((x) => x.stars < 3)),
  ]
    .filter(Boolean)
    .join('\n');
}

/** The ratings block with its heading, in either format. */
export function ratingsBlock(known: Known[], format: string): string {
  return format === 'stars' ? `My film ratings (0.5 to 5 stars):\n${ratingsText(known)}` : `My film ratings:\n${ratingsWords(known)}`;
}

/** A fixed random sample of n ratings, as if the person had rated only those. */
export function sample(input: EngineInput, n: number): Known[] {
  if (!(n > 0) || n >= input.known.length) return input.known;
  const rnd = mulberry32((+input.userId ^ 0x9e3779b9) >>> 0);
  const a = [...input.known];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n).sort((x, y) => y.stars - x.stars || y.at - x.at);
}

export function ask(variant: string, k: number, year: number): { developer: string; request: string; output: string } {
  const limit = `Only films released in ${year} or earlier.`;
  const base = `Recommend ${k} films I have not rated that I would love, best first. ${limit}`;
  const plain = { developer: 'You recommend films.', request: base, output: OUTPUT };
  switch (variant) {
    case 'base':
      return plain;
    case 'persona': // does a grand role description help?
      return { ...plain, developer: "You are a world-class film curator with encyclopedic knowledge of cinema from every era and country, and a gift for reading a person's taste from their ratings." };
    case 'think': // does writing down the taste first help?
      return { ...plain, request: `First describe my taste in three sentences. Then recommend ${k} films I have not rated that I would love, best first. ${limit}`, output: 'Answer with JSON only: {"taste":"three sentences","picks":[{"t":"title","y":1999}]}' };
    case 'similar': // the collaborative-filtering framing
      return { ...plain, request: `Recommend ${k} films I have not rated that people who rate films like I do love most, best first. ${limit}` };
    case 'mix': // the app's default wish for discoveries
      return { ...plain, request: `${base} A balanced mix of known films and discoveries.` };
    case 'sure': // play it safe
      return { ...plain, request: `${base} Only films you are confident I would love.` };
    default:
      throw new Error(`unknown variant "${variant}"`);
  }
}

const engine: Engine = async (input, io) => {
  const k = io.num('k', 40);
  const shown = sample(input, io.num('n', 0));
  const a = ask(io.param('variant', 'base'), k, input.cutoffYear);
  const user = `${ratingsBlock(shown, io.param('ratings', 'words'))}\n\n${a.request}\n${a.output}`;
  const picks = parsePicks(await io.llm({ developer: a.developer, user }));
  io.note('shown', shown.length);
  io.note('titles', picks.length);
  return (await io.resolveAll(picks)).map((f) => f.id);
};

export default engine;
