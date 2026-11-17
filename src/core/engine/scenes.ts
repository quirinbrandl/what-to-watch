// Background scenes for the feed.
//
// TMDB's main "backdrop" for a film is often poster artwork in landscape
// format, and nothing in its data tells artwork from a real scene. So the
// model looks at a handful of small candidate images per film and picks one
// that shows an actual moment of the film. One cheap call per batch of picks
// (about 75 tokens per image); the choice is cached on the film.
import { Llm, UserPart, extractJsonLines } from '../llm';
import { Film, labelOf } from '../models';
import { Tmdb } from '../tmdb';

export interface SceneItem {
  film: Film;
  stills: string[];
}

export const sceneSystem =
  'You pick background images for a film app. For each film you get candidate images. ' +
  'Decide for each image whether it is an actual scene from the film (a frame or production still showing a moment of the film) or promotional artwork (poster art, a composed montage of characters, a logo, an illustration, a collage). ' +
  "Then choose the one image to show full-screen behind the film's poster: it must be a real scene if any candidate is one; among real scenes prefer the most striking, atmospheric one that does not give away the ending. " +
  'Answer with one JSON object per line and nothing else: {"f": <film number>, "scenes": [<numbers of the images that are real scenes>], "pick": <number>}';

/** The message for one call: each film's name, then its numbered candidate images. */
export function sceneParts(items: SceneItem[]): UserPart[] {
  const parts: UserPart[] = [];
  items.forEach((it, n) => {
    parts.push({ text: `Film ${n + 1}: ${labelOf(it.film)}. ${it.stills.length} candidate images follow, numbered from 0.` });
    it.stills.forEach((path, i) => {
      parts.push({ text: `Film ${n + 1}, image ${i}:` });
      parts.push({ image: Tmdb.img(path, 'w300') });
    });
  });
  return parts;
}

/**
 * The model's choice per film id. A film the model skipped, or an answer
 * that points outside the candidates, falls back to the first candidate.
 */
export function parseScenes(text: string, items: SceneItem[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const j of extractJsonLines(text)) {
    const it = items[Number(j.f) - 1];
    const pick = Number(j.pick);
    if (it && Number.isInteger(pick) && pick >= 0 && pick < it.stills.length && !out.has(it.film.id)) out.set(it.film.id, it.stills[pick]);
  }
  for (const it of items) if (!out.has(it.film.id)) out.set(it.film.id, it.stills[0]);
  return out;
}

/**
 * Chooses a scene for every film that has none yet and stores it on the film
 * (and on the cached copy). Films whose lookup or model call fails stay
 * undecided and are tried again next time. Returns how many were decided.
 */
export async function pickScenes(tmdb: Tmdb, llm: Llm, model: string, films: Film[]): Promise<number> {
  const todo = films.filter((f) => f.scene === undefined);
  let done = 0;
  const set = (f: Film, scene: string) => {
    f.scene = scene;
    const cached = tmdb.cache.get(f.id);
    if (cached) cached.scene = scene;
    done++;
  };
  const looked = await Promise.all(todo.map((film) => tmdb.stills(film).then((stills): SceneItem => ({ film, stills }), () => undefined)));
  const ask: SceneItem[] = [];
  for (const it of looked) {
    if (!it) continue;
    if (it.stills.length >= 2) ask.push(it);
    else set(it.film, it.stills[0] ?? '');
  }
  // The first films are on screen first, so they get a small call of their own that answers sooner.
  const groups = [ask.slice(0, 3), ask.slice(3)].filter((g) => g.length);
  await Promise.all(
    groups.map(async (items) => {
      try {
        const text = await llm.respond({ model, developer: sceneSystem, user: sceneParts(items), effort: 'low', retries: 0 });
        for (const [id, scene] of parseScenes(text, items)) set(items.find((it) => it.film.id === id)!.film, scene);
      } catch {
        // Best effort: the feed keeps its plain background for these films.
      }
    }),
  );
  return done;
}
