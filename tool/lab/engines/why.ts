import { ratingsText } from './onecall';
import { Engine } from '../lab';
import { extractJson } from '../../../src/core/llm';

const engine: Engine = async (input, io) => {
  const k = io.num('k', 30);
  const text = await io.llm({
    developer: 'You recommend films.',
    user: `My film ratings (0.5 to 5 stars):\n${ratingsText(input.known)}\n\nRecommend ${k} films I have not rated that I would love, best first. Only films released in ${input.cutoffYear} or earlier. For each film add one sentence on why it fits me.\nAnswer with JSON only: {"picks":[{"t":"title","y":1999,"why":"one sentence"}]}`,
  });
  const j = extractJson(text);
  const list = Array.isArray(j?.picks) ? (j!.picks as any[]) : [];
  const good = list.filter((p) => p && typeof p.t === 'string' && p.t.trim());
  const picks = good.map((p) => {
    const y = typeof p.y === 'number' ? Math.trunc(p.y) : parseInt(String(p.y), 10);
    return { t: String(p.t).trim(), y: Number.isFinite(y) ? y : undefined };
  });
  const whys = good.map((p) => (typeof p.why === 'string' ? p.why.length : 0));
  io.note('whyChars', whys.length ? whys.reduce((a, b) => a + b, 0) / whys.length : 0);
  return (await io.resolveAll(picks)).map((f) => f.id);
};

export default engine;
