import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PROPOSE_ROLE, RATE_ROLE, WHY_ROLE, dialSentence, filterSentences, parsePicks, parseStars, proposeUser, ratingsBlock, reader, ENTRY, STAR_PAIR } from '../engine/prompts';
import { Recommender, Session, engineConfig } from '../engine/recommender';
import { Services, newRequest } from '../engine/request';
import { Llm } from '../llm';
import { Library } from '../models';
import { FilmCache, Tmdb } from '../tmdb';

// ------------------------------------------------------------ a small world

interface Row {
  id: number;
  title: string;
  year: number;
  genres?: number[];
  runtime?: number;
  vote?: number;
  director?: string;
  date?: string;
}

/** A TMDB that knows only these films. */
function tmdbOf(rows: Row[]): { tmdb: Tmdb; asked: string[] } {
  const asked: string[] = [];
  const item = (r: Row) => ({
    id: r.id,
    title: r.title,
    release_date: r.date ?? `${r.year}-05-01`,
    genre_ids: r.genres ?? [18],
    original_language: 'en',
    poster_path: `/p${r.id}.jpg`,
    overview: `About ${r.title}.`,
    vote_average: r.vote ?? 7.5,
    vote_count: 2000,
  });
  const fetchFn = (async (url: string) => {
    const u = new URL(url);
    asked.push(`${u.pathname}?${u.searchParams.toString()}`);
    let body: unknown;
    if (u.pathname.endsWith('/search/movie')) {
      const q = u.searchParams.get('query')!.toLowerCase();
      body = { results: rows.filter((r) => r.title.toLowerCase() === q).map(item) };
    } else if (u.pathname.endsWith('/discover/movie')) {
      const from = u.searchParams.get('primary_release_date.gte') ?? '0000';
      const genre = u.searchParams.get('with_genres');
      const page = u.searchParams.get('page');
      body = { results: page === '1' ? rows.filter((r) => (r.date ?? `${r.year}-05-01`) >= from && (!genre || (r.genres ?? [18]).includes(+genre))).map(item) : [] };
    } else {
      const r = rows.find((x) => u.pathname.endsWith(`/movie/${x.id}`));
      if (!r) return { status: 404, json: async () => ({}) };
      body = { ...item(r), genres: (r.genres ?? [18]).map((id) => ({ id })), runtime: r.runtime ?? 110, credits: { crew: [{ job: 'Director', name: r.director ?? `Director ${r.id}` }], cast: [{ name: `Actor ${r.id}` }] } };
    }
    return { status: 200, json: async () => body };
  }) as unknown as typeof fetch;
  return { tmdb: new Tmdb(new FilmCache(), fetchFn), asked };
}

/** An LLM that answers from a script and remembers what it was asked. */
class Script extends Llm {
  asked: { developer: string; user: string }[] = [];
  constructor(private answer: (developer: string, user: string, n: number) => string) {
    super(async () => '');
  }
  override async respond(opts: Parameters<Llm['respond']>[0]): Promise<string> {
    const user = opts.user as string;
    this.asked.push({ developer: opts.developer, user });
    const text = this.answer(opts.developer, user, this.asked.filter((a) => a.developer === opts.developer).length);
    // Arrives in two pieces, like a real answer.
    opts.onText?.(text.slice(0, Math.floor(text.length / 2)));
    opts.onText?.(text);
    return text;
  }
  of(role: string): string[] {
    return this.asked.filter((a) => a.developer === role).map((a) => a.user);
  }
}

/** An answer to question 1: these films, then enough titles TMDB does not know to make it a full-length answer. */
const picks = (...titles: [string, number][]) => JSON.stringify({ picks: [...titles, ...[...Array(30)].map((_, i): [string, number] => [`Nowhere ${i}`, 1900])].map(([t, y]) => ({ t, y })) });
/** Stars for the numbered films of a rating question, by title. */
const stars = (user: string, by: Record<string, number>) =>
  JSON.stringify({
    r: [...user.matchAll(/^(\d+)\. (.*?) \(\d{4}\)/gm)].filter((m) => by[m[2]] !== undefined).map((m) => [+m[1], by[m[2]]]),
  });

// The user's library: four rated films, newest rating first within a group.
const OWN: Row[] = [
  { id: 1, title: 'Heat', year: 1995, director: 'Michael Mann' },
  { id: 2, title: 'Alien', year: 1979 },
  { id: 3, title: 'Amélie', year: 2001 },
  { id: 4, title: 'Cats', year: 2019 },
];
const NEW: Row[] = [
  { id: 10, title: 'Thief', year: 1981, director: 'Michael Mann' },
  { id: 11, title: 'Ronin', year: 1998 },
  { id: 12, title: 'Le Samouraï', year: 1967 },
  { id: 13, title: 'Drive', year: 2011 },
  { id: 14, title: 'Rio Bravo', year: 1959, genres: [37] },
  { id: 15, title: 'Unforgiven', year: 1992, genres: [37], vote: 8.1 },
  { id: 16, title: 'The Searchers', year: 1956, genres: [37], vote: 7.7 },
  { id: 17, title: 'Brand New', year: 2025, date: '2025-09-12', vote: 7.9 },
];

async function world(script: (developer: string, user: string, n: number) => string, rows = [...OWN, ...NEW]) {
  const { tmdb, asked } = tmdbOf(rows);
  const lib = new Library();
  const rate = (id: number, r: number, at: number) => {
    const e = lib.entry(id);
    e.myRating = r;
    e.myRatingAt = at;
  };
  rate(2, 4, 300);
  rate(1, 5, 100);
  rate(3, 3.5, 200);
  rate(4, 1, 400);
  const llm = new Script(script);
  const rec = new Recommender(tmdb, llm, lib, new Services('DE'), engineConfig('m', { batch: 2 }));
  await rec.ensureLibraryDetails();
  return { rec, llm, lib, tmdb, asked };
}

const RATINGS = 'My film ratings:\nLoved: Heat (1995); Alien (1979)\nLiked: Amélie (2001)\nDid not like: Cats (2019)';
const titles = (s: Session) => s.picks.map((p) => p.film.title);

// ------------------------------------------------------------------ tests

describe('the engine with nothing set', () => {
  const answer = (d: string, u: string) =>
    d === PROPOSE_ROLE ? picks(['Thief', 1981], ['Ronin', 1998], ['Heat', 1995], ['Le Samouraï', 1967], ['Drive', 2011]) : stars(u, { Thief: 4.5, Ronin: 4.5, 'Le Samouraï': 5, Drive: 2.5 });

  test('asks the two tested questions, word for word', async () => {
    const { rec, llm } = await world(answer);
    await rec.start(newRequest());
    assert.deepEqual(llm.of(PROPOSE_ROLE), [`${RATINGS}\n\nRecommend 60 films I have not rated that I would love, best first.\nAnswer with JSON only: {"picks":[{"t":"title","y":1999}]}`]);
    assert.deepEqual(llm.of(RATE_ROLE), [
      `${RATINGS}\n\nPredict the rating (0.5 to 5 stars) I would give each of these films I have not rated:\n1. Thief (1981)\n2. Ronin (1998)\n3. Le Samouraï (1967)\n4. Drive (2011)\n\nAnswer with JSON only: {"r":[[1,4.5],[2,3.0]]} (film number, predicted stars)`,
    ]);
    assert.equal(llm.asked.length, 2, 'nothing else is asked until a film is looked at');
  });

  test('the year limit of the lab is the one sentence it tested', () => {
    const p = proposeUser(RATINGS, newRequest({ yearMax: 2023 }), new Services('DE'), 60);
    assert.ok(p.includes('\n\nRecommend 60 films I have not rated that I would love, best first. Only films released in 2023 or earlier.\nAnswer with JSON only:'));
  });

  test('sorts by predicted rating, keeps the proposed order among equals, drops the rest', async () => {
    const { rec } = await world(answer);
    const s = await rec.start(newRequest());
    // Heat is already rated, the "Nowhere" titles are not on TMDB, Drive is predicted a miss.
    assert.deepEqual(titles(s), ['Le Samouraï', 'Thief', 'Ronin']);
    assert.deepEqual(s.picks.map((p) => p.predicted), [5, 4.5, 4.5]);
    assert.ok(s.picks.every((p) => p.personal && p.why === undefined && p.film.full));
    assert.deepEqual(s.picks[1].facts, ['From Michael Mann, director of Heat']);
  });

  test('a far too short answer is asked for once more', async () => {
    const { rec, llm } = await world((d, u, n) => (d === PROPOSE_ROLE ? (n === 1 ? 'Sorry, {"picks":[' : picks(['Thief', 1981])) : stars(u, { Thief: 4 })));
    const s = await rec.start(newRequest());
    assert.equal(llm.of(PROPOSE_ROLE).length, 2);
    assert.deepEqual(titles(s), ['Thief']);
  });

  test('"more" is a new round that does not repeat anything', async () => {
    const { rec, llm } = await world((d, u, n) => (d === PROPOSE_ROLE ? (n === 1 ? picks(['Thief', 1981], ['Ronin', 1998]) : picks(['Thief', 1981], ['Drive', 2011])) : stars(u, { Thief: 4, Ronin: 4, Drive: 4 })));
    const s = await rec.start(newRequest());
    assert.equal(await rec.more(s), 1);
    assert.deepEqual(titles(s), ['Thief', 'Ronin', 'Drive']);
    assert.ok(llm.of(PROPOSE_ROLE)[1].includes('\n\nDo not recommend these: Thief (1981); Ronin (1998); Nowhere 0 (1900); '));
    assert.equal(await rec.more(s), 0);
    assert.equal(s.exhausted, true);
  });
});

describe('each feature adds one line or sentence', () => {
  const sv = new Services('DE', { 8: 'Netflix', 337: 'Disney Plus' });

  test('the typed request goes into both questions', async () => {
    const { rec, llm } = await world((d, u) => (d === PROPOSE_ROLE ? picks(['Thief', 1981]) : stars(u, { Thief: 4 })));
    await rec.start(newRequest({ prompt: '  slow and  tense ' }));
    assert.ok(llm.of(PROPOSE_ROLE)[0].startsWith(`${RATINGS}\n\nWhat I want tonight: slow and tense\n\nRecommend 60 films`));
    assert.ok(llm.of(RATE_ROLE)[0].startsWith(`${RATINGS}\n\nWhat I want tonight: slow and tense\n\nPredict the rating`));
  });

  test('filters and the dial are sentences after the question', () => {
    assert.deepEqual(filterSentences(newRequest(), sv), []);
    assert.equal(dialSentence(0.5), '');
    const r = newRequest({ genres: [53, 80], notGenres: [27], yearMin: 1970, yearMax: 1989, runMax: 120, langs: ['fr', 'ja'], streamingOnly: true, obscurity: 0.25 });
    assert.ok(
      proposeUser(RATINGS, r, sv, 60).includes(
        'best first. Only films released from 1970 to 1989. Only films that are Thriller and Crime at the same time. No Horror films. Prefer shorter films, around 120 minutes or less. Only films whose original language is French or Japanese. Only films that can be streamed on Netflix or Disney Plus (country: DE). Prefer well-known films.\nAnswer',
      ),
    );
    assert.equal(dialSentence(1), 'Only little-known films that few people have seen.');
  });

  test('a search that is not personal asks without ratings and keeps the proposed order', async () => {
    const { rec, llm } = await world(() => picks(['Ronin', 1998], ['Heat', 1995], ['Thief', 1981]));
    const s = await rec.start(newRequest({ personalize: false }));
    assert.ok(llm.asked[0].user.startsWith('Recommend 60 great films, best first.'));
    assert.equal(llm.asked.length, 1);
    assert.deepEqual(titles(s), ['Ronin', 'Thief']);
    assert.ok(s.picks.every((p) => !p.personal && p.predicted === undefined));
  });

  test('when a filter leaves too few ideas, TMDB adds films that pass it', async () => {
    const { rec, llm } = await world((d, u) => (d === PROPOSE_ROLE ? picks(['Thief', 1981], ['Rio Bravo', 1959]) : stars(u, { 'Rio Bravo': 4, Unforgiven: 4.5, 'The Searchers': 3.5 })));
    const s = await rec.start(newRequest({ genres: [37] }));
    assert.ok(llm.of(PROPOSE_ROLE)[0].includes('best first. Only Western films.\n'));
    assert.deepEqual(titles(s), ['Unforgiven', 'Rio Bravo', 'The Searchers']);
  });

  test('new releases come from TMDB with their facts and are sorted in by predicted rating', async () => {
    const { rec, llm, asked } = await world((d, u) => (d === PROPOSE_ROLE ? picks(['Thief', 1981], ['Ronin', 1998]) : stars(u, { Thief: 5, Ronin: 4, 'Brand New': 4 })));
    const s = await rec.start(newRequest({ recent: true }));
    assert.ok(asked.some((a) => a.startsWith('/3/discover/movie') && a.includes('primary_release_date.gte=2024-07-01')));
    const facts = llm.of(RATE_ROLE).find((u) => u.includes('new films you may not know'))!;
    assert.ok(facts.includes('1. Brand New (2025) | Drama | directed by Director 17 | with Actor 17 | TMDB users give it 7.9 | About Brand New.'));
    assert.deepEqual(titles(s), ['Thief', 'Brand New', 'Ronin']);
    assert.equal(s.picks[1].fresh, true);
    // Off by default: no extra question, no extra film.
    const plain = await world((d, u) => (d === PROPOSE_ROLE ? picks(['Thief', 1981]) : stars(u, { Thief: 5 })));
    assert.deepEqual(titles(await plain.rec.start(newRequest())), ['Thief']);
    assert.equal(plain.llm.asked.length, 2);
  });

  test('with the switch on, at least every fourth film is a new release even when older films are predicted higher', async () => {
    const older: [string, number][] = [['Thief', 1981], ['Ronin', 1998], ['Le Samouraï', 1967], ['Drive', 2011], ['Rio Bravo', 1959]];
    const five = Object.fromEntries(older.map(([t]) => [t, 5]));
    const { rec } = await world((d, u) => (d === PROPOSE_ROLE ? picks(...older) : stars(u, { ...five, 'Brand New': 3.5 })));
    const s = await rec.start(newRequest({ recent: true }));
    assert.deepEqual(titles(s), ['Thief', 'Ronin', 'Le Samouraï', 'Brand New', 'Drive', 'Rio Bravo']);
  });

  test('a year filter that starts after everything the LLM knows brings the new releases by itself', async () => {
    const { rec } = await world((d, u) => (d === PROPOSE_ROLE ? picks(['Thief', 1981]) : stars(u, { 'Brand New': 4 })));
    const s = await rec.start(newRequest({ yearMin: 2025 }));
    assert.deepEqual(titles(s), ['Brand New']);
  });
});

describe('reasons', () => {
  const answer = (d: string, u: string, n: number) => {
    if (d === PROPOSE_ROLE) return picks(['Thief', 1981], ['Ronin', 1998], ['Le Samouraï', 1967], ['Drive', 2011]);
    if (d === RATE_ROLE) return stars(u, { Thief: 5, Ronin: 4.5, 'Le Samouraï': 4, Drive: 3.5 });
    return n === 1
      ? '{"n":1,"why":"A cool, exact heist film with the night-time city mood of [L1]. You gave that 5 stars."}\n{"n":2,"why":"Just like [L9]."}'
      : '{"n":1,"why":"Quiet and precise, and it rewards the patience you showed with [L2]."}\n{"n":2,"why":"Stylish and spare: a driver, a city and very few words."}';
  };

  test('are written a batch at a time, only as far as asked, and point to real films', async () => {
    const { rec, llm } = await world(answer);
    const s = await rec.start(newRequest());
    let told = 0;
    await rec.explain(s, 2, () => told++);
    assert.equal(llm.of(WHY_ROLE).length, 1);
    assert.ok(llm.of(WHY_ROLE)[0].startsWith('My film ratings:\nLoved: [L1] Heat (1995); [L2] Alien (1979)\nLiked: [L3] Amélie (2001)\nDid not like: Cats (2019)\n\nThese films were recommended to me.'));
    assert.ok(llm.of(WHY_ROLE)[0].includes('\n1. Thief (1981)\n2. Ronin (1998)\n\nAnswer with JSON Lines only'));
    assert.equal(s.picks[0].why, 'A cool, exact heist film with the night-time city mood of Heat.');
    assert.deepEqual(s.picks[0].anchors, [{ id: 1, title: 'Heat', poster: '/p1.jpg' }]);
    assert.equal(s.picks[1].why, 'A well-regarded drama film: TMDB users give it 7.5.', 'an unusable reason falls back to plain facts');
    assert.equal(s.picks[2].why, undefined);
    assert.ok(told >= 2);

    await rec.explain(s, 4);
    await rec.explain(s, 4);
    assert.equal(llm.of(WHY_ROLE).length, 2, 'nothing is written twice');
    assert.equal(s.picks[2].why, 'Quiet and precise, and it rewards the patience you showed with Alien.');
    assert.deepEqual(s.picks[3].anchors, []);
  });

  test('survive saving, and films an older version held back are in the list', async () => {
    const { rec, tmdb } = await world(answer);
    const s = await rec.start(newRequest());
    await rec.explain(s, 2);
    const back = Session.fromJson(JSON.parse(JSON.stringify(s.toJson())), tmdb.cache);
    assert.deepEqual(back.picks.map((p) => [p.film.title, p.predicted, p.why === undefined]), [['Thief', 5, false], ['Ronin', 4.5, false], ['Le Samouraï', 4, true], ['Drive', 3.5, true]]);
    const old = Session.fromJson({ request: {}, picks: [{ id: 10, predicted: 4.1, why: 'Because.' }], reserve: [{ id: 11, predicted: 3.9, why: 'Also.' }] }, tmdb.cache);
    assert.deepEqual(titles(old), ['Thief', 'Ronin']);
  });
});

describe('reading the answers', () => {
  test('picks, also from an answer that is broken as a whole', () => {
    assert.deepEqual(parsePicks('```json\n{"picks":[{"t":" Heat ","y":1995},{"t":"Alien","y":"1979"},{"y":3}]}\n```'), [{ t: 'Heat', y: 1995 }, { t: 'Alien', y: 1979 }]);
    assert.deepEqual(parsePicks('{"picks":[{"t":"Heat","y":1995},{"t":"Al'), [{ t: 'Heat', y: 1995 }]);
  });
  test('stars: the first value per film counts, numbers outside the list are ignored', () => {
    assert.deepEqual([...parseStars('{"r":[[1,4.5],[2,3],[2,5],[9,4],[3,7]]}', 3)], [[0, 4.5], [1, 3], [2, 5]]);
    assert.deepEqual([...parseStars('{"r":[[1,4.5],[2,3.0],[3,', 3)], [[0, 4.5], [1, 3]]);
  });
  test('an answer that arrives in pieces is read entry by entry, each once', () => {
    const got: string[] = [];
    const read = reader(ENTRY, (m) => got.push(m[0]));
    read('{"picks":[{"t":"A","y":1},{"t":"B"');
    read('{"picks":[{"t":"A","y":1},{"t":"B","y":2}]}');
    read('{"picks":[{"t":"A","y":1},{"t":"B","y":2}]}');
    assert.deepEqual(got, ['{"t":"A","y":1}', '{"t":"B","y":2}']);
    const pairs: string[] = [];
    const stars2 = reader(STAR_PAIR, (m) => pairs.push(`${m[1]}=${m[2]}`));
    stars2('{"r":[[1,4.5],[2,3');
    stars2('{"r":[[1,4.5],[2,3.5]]}');
    assert.deepEqual(pairs, ['1=4.5', '2=3.5']);
  });
  test('only films rated 3.5★ or higher get a tag', () => {
    const cache = new FilmCache();
    const lib = new Library();
    [5, 3.5, 3, 2].forEach((r, i) => {
      cache.put({ id: i + 1, title: `F${i + 1}`, release: '2015-05-01', genres: [], overview: '', vote: 7, votes: 100, pop: 1, directors: [], cast: [], keywords: [], recs: [], full: true, adult: false, at: 0 });
      lib.rate(i + 1, r);
    });
    const b = ratingsBlock(lib, cache, { tagged: true });
    assert.equal(b.text, 'My film ratings:\nLoved: [L1] F1 (2015)\nLiked: [L2] F2 (2015); F3 (2015)\nDid not like: F4 (2015)');
    assert.deepEqual(b.tags, { L1: 1, L2: 2 });
    assert.equal(ratingsBlock(new Library(), cache).text, '');
  });
});
