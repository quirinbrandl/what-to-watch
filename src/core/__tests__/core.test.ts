import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, test } from 'node:test';

import { strToU8, zipSync } from 'fflate';

import { b64urlDecode, b64urlEncode, verifyRs256 } from '../auth';
import { validateWhy } from '../engine/prompts';
import { Services, newRequest, rejectReason } from '../engine/request';
import { LbFormatError, applyExport, applyRss, cleanUsername, matchScore, parseCsv, parseLetterboxdZip, parseRss } from '../letterboxd';
import { extractJson, extractJsonLines } from '../llm';
import { Film, Library, Prov, filmFromJson, filmToJson, makeFilm, nowSec } from '../models';
import { parseScenes, sceneParts } from '../engine/scenes';
import { FilmCache, rankStills } from '../tmdb';
import { MISS } from '../engine/recommender';
import { Field, FieldInput, newField, speed, sprites, step } from '../field';

function film(id: number, title: string, o: Partial<Film> & { year?: number; flat?: Prov[]; region?: string } = {}): Film {
  const { year = 2015, flat = [], region = 'DE', ...rest } = o;
  return makeFilm({
    id,
    title,
    release: `${year}-05-01`,
    runtime: 110,
    genres: [18],
    lang: 'en',
    poster: `/p${id}.jpg`,
    vote: 7.5,
    votes: 2000,
    directors: ['A Director'],
    prov: { region, flat, free: [], ads: [], rent: [], buy: [], at: 0 },
    full: true,
    ...rest,
  });
}

const zipOf = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

describe('csv', () => {
  test('quotes, commas, newlines', () => {
    const rows = parseCsv('Name,Year\n"Crouching Tiger, Hidden Dragon",2000\n"He said ""hi""\nthere",1999\n');
    assert.deepEqual(rows[1], ['Crouching Tiger, Hidden Dragon', '2000']);
    assert.equal(rows[2][0], 'He said "hi"\nthere');
  });
});

describe('letterboxd zip', () => {
  const d = 'letterboxd-user-2026/';
  const zip = zipOf({
    [`${d}profile.csv`]: 'Date Joined,Username,Favorite Films\n2020-01-01,Tester,https://boxd.it/aaaa\n',
    [`${d}ratings.csv`]: 'Date,Name,Year,Letterboxd URI,Rating\n2021-01-02,Alpha,2001,https://boxd.it/aaaa,4.5\n2021-01-03,Beta,2002,https://boxd.it/bbbb,2\n',
    [`${d}watched.csv`]:
      'Date,Name,Year,Letterboxd URI\n2021-01-02,Alpha,2001,https://boxd.it/aaaa\n2021-01-03,Beta,2002,https://boxd.it/bbbb\n2021-01-04,Gamma,2003,https://boxd.it/cccc\n',
    [`${d}watchlist.csv`]: 'Date,Name,Year,Letterboxd URI\n2021-02-01,Delta,2004,https://boxd.it/dddd\n',
    [`${d}diary.csv`]:
      'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n2021-01-02,Alpha,2001,https://boxd.it/e1,4,,,2021-01-01\n2022-01-02,Alpha,2001,https://boxd.it/e2,4.5,Yes,,2022-01-01\n',
    [`${d}likes/films.csv`]: 'Date,Name,Year,Letterboxd URI\n2021-01-04,Gamma,2003,https://boxd.it/cccc\n',
    [`${d}lists/top-10.csv`]:
      'Letterboxd list export v7\nDate,Name,Tags,URL,Description\n2025-01-03,Top 10,,https://boxd.it/L,\n\nPosition,Name,Year,URL,Description\n1,Gamma,2003,https://boxd.it/cccc,\n',
    [`${d}deleted/diary.csv`]: 'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n2021-01-02,Zeta,1990,https://boxd.it/z,1,,,2021-01-01\n',
  });

  test('finds everything by itself', () => {
    const ex = parseLetterboxdZip(zip);
    assert.equal(ex.username, 'Tester');
    assert.equal(ex.films.size, 4);
    const alpha = ex.films.get('alpha|2001')!;
    assert.equal(alpha.rating, 4.5);
    assert.equal(alpha.favorite, true);
    assert.equal(alpha.rewatch, true);
    assert.deepEqual([...alpha.watchDates].sort(), ['2021-01-01', '2022-01-01']);
    assert.equal(ex.films.get('gamma|2003')!.liked, true);
    assert.equal(ex.films.get('gamma|2003')!.favorite, true);
    assert.equal(ex.films.get('delta|2004')!.watchlist, true);
    assert.equal(ex.films.has('zeta|1990'), false);
  });

  test('rejects other zips', () => {
    assert.throws(() => parseLetterboxdZip(zipOf({ 'hello.txt': 'x' })), LbFormatError);
    assert.throws(() => parseLetterboxdZip(new Uint8Array([1, 2, 3])), LbFormatError);
  });

  test('apply keeps in-app data and replaces the Letterboxd side', () => {
    const ex = parseLetterboxdZip(zip);
    let id = 1;
    for (const f of ex.films.values()) f.tmdbId = f.name === 'Beta' ? undefined : id++;
    const lib = new Library();
    lib.rate(99, 3.5);
    lib.entry(50).lbRating = 1; // stale Letterboxd value, gone from the export
    applyExport(lib, ex);
    assert.equal(lib.get(99)!.rating, 3.5);
    assert.equal(lib.get(50), undefined);
    assert.deepEqual(lib.unmatched, ['Beta (2002)']);
    assert.equal(lib.lbUsername, 'Tester');
    assert.equal(lib.rated.length, 2);
  });
});

describe('merge rules', () => {
  test('latest change wins, rated implies watched, watched leaves watchlist', () => {
    const lib = new Library();
    const e = lib.entry(1);
    e.lbRating = 3;
    e.lbRatingAt = nowSec() - 1000;
    e.lbWatchlist = true;
    e.lbWatchlistAt = 5;
    assert.equal(e.rating, 3);
    assert.equal(e.watched, true);
    assert.equal(e.watchlist, false);
    lib.rate(1, 4.5);
    assert.equal(e.rating, 4.5);
    e.lbRating = 2;
    e.lbRatingAt = nowSec() + 50; // newer Letterboxd rating arrives later
    assert.equal(e.rating, 2);
    lib.rate(2, undefined);
    assert.equal(lib.get(2)!.rating, undefined);
    lib.setWatchlist(3, true);
    assert.equal(lib.get(3)!.watchlist, true);
    lib.setWatched(3, true);
    assert.equal(lib.get(3)!.watchlist, false);
    lib.setWatched(1, false);
    assert.equal(e.watched, true, 'the newer Letterboxd rating still stands');
  });

  test('json round trip', () => {
    const lib = new Library();
    lib.rate(1, 4);
    lib.setNotInterested(2, true);
    lib.lbUsername = 'x';
    const back = Library.fromJson(JSON.parse(JSON.stringify(lib.toJson())));
    assert.equal(back.get(1)!.rating, 4);
    assert.equal(back.get(2)!.notInterested, true);
    assert.equal(back.lbUsername, 'x');
    const f = film(7, 'Round Trip', { keywords: [{ id: 1, name: 'k' }], recs: [3], flat: [{ id: 8, name: 'Netflix', logo: null }] });
    const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
    assert.deepEqual(plain(filmFromJson(plain(filmToJson(f)))), plain(f));
  });
});

describe('rss', () => {
  const item = (n: number, tmdb: number, date: string, o: { rating?: number; rewatch?: boolean } = {}) => `
<item><title>Film ${tmdb} &amp; more</title><guid isPermaLink="false">letterboxd-watch-${n}</guid>
<pubDate>${+date.slice(8, 10)} Nov 2026 10:00:00 +0100</pubDate>
<letterboxd:watchedDate>${date}</letterboxd:watchedDate><letterboxd:rewatch>${o.rewatch ? 'Yes' : 'No'}</letterboxd:rewatch>
<letterboxd:filmTitle>Film ${tmdb} &amp; more</letterboxd:filmTitle><letterboxd:filmYear>2020</letterboxd:filmYear>
${o.rating === undefined ? '' : `<letterboxd:memberRating>${o.rating.toFixed(1)}</letterboxd:memberRating>`}<letterboxd:memberLike>No</letterboxd:memberLike>
<tmdb:movieId>${tmdb}</tmdb:movieId><description><![CDATA[<p>poster</p>]]></description></item>`;
  const feed = (items: string[]) =>
    `<?xml version="1.0"?><rss version="2.0" xmlns:letterboxd="https://letterboxd.com" xmlns:tmdb="https://themoviedb.org"><channel>${items.join('')}` +
    '<item><title>A list</title><guid>letterboxd-list-1</guid></item></channel></rss>';

  test('parses diary items only', () => {
    const items = parseRss(feed([item(1, 10, '2026-11-02', { rating: 4 }), item(2, 11, '2026-11-03')]));
    assert.equal(items.length, 2);
    assert.equal(items[0].tmdbId, 10);
    assert.equal(items[0].rating, 4);
    assert.equal(items[0].title, 'Film 10 & more');
    assert.equal(items[0].pubAt, Date.UTC(2026, 10, 2, 9) / 1000);
    assert.equal(items[1].rating, undefined);
    assert.throws(() => parseRss('<html>blocked</html>'));
  });

  test('duplicates, changed ratings, rewatches', () => {
    const lib = new Library();
    lib.setWatchlist(10, true);
    lib.get(10)!.lbWatchlist = true;
    let res = applyRss(lib, parseRss(feed([item(1, 10, '2026-11-02', { rating: 4 })])));
    assert.equal(res.updated + res.added, 1);
    assert.equal(lib.get(10)!.rating, 4);
    assert.equal(lib.get(10)!.watchlist, false);
    res = applyRss(lib, parseRss(feed([item(1, 10, '2026-11-02', { rating: 4 })])));
    assert.equal(res.added + res.updated, 0, 'same feed twice changes nothing');
    applyRss(lib, parseRss(feed([item(1, 10, '2026-11-02', { rating: 2.5 })])));
    assert.equal(lib.get(10)!.rating, 2.5, 'edited rating is picked up');
    applyRss(lib, parseRss(feed([item(1, 10, '2026-11-02', { rating: 2.5 }), item(7, 10, '2026-11-09', { rating: 5, rewatch: true })])));
    assert.equal(lib.get(10)!.rating, 5);
    assert.equal(lib.get(10)!.rewatched, true);
    assert.equal(lib.get(10)!.watchDates.length, 2);
  });

  test('in-app rating beats older Letterboxd entry, loses to newer', () => {
    const lib = new Library();
    lib.rate(10, 1);
    applyRss(lib, parseRss(feed([item(1, 10, '2026-11-02', { rating: 4 })])));
    assert.equal(lib.get(10)!.rating, 1);
    lib.get(10)!.myRatingAt = 100; // pretend the in-app rating is old
    applyRss(lib, parseRss(feed([item(2, 10, '2026-11-05', { rating: 3 })])));
    assert.equal(lib.get(10)!.rating, 3);
  });

  test('detects a gap after a long absence', () => {
    const lib = new Library();
    applyRss(lib, parseRss(feed(Array.from({ length: 50 }, (_, i) => item(i, 100 + i, '2026-11-01', { rating: 3 })))), 1000);
    assert.equal(lib.lbGap, false);
    const res = applyRss(lib, parseRss(feed(Array.from({ length: 50 }, (_, i) => item(100 + i, 400 + i, '2026-11-20', { rating: 3 })))));
    assert.equal(res.gap, true);
    assert.equal(lib.lbGap, true);
  });

  test('the feed corrects a wrong title match from the export', () => {
    const lib = new Library();
    const wrong = lib.entry(555); // export matched "Film 10 & more (2020)" to the wrong TMDB film
    wrong.lbRating = 4;
    wrong.lbRatingAt = 10;
    wrong.lbSrcAt = 10;
    wrong.lbWatched = true;
    lib.lbKeys['film 10 & more|2020'] = 555;
    applyRss(lib, parseRss(feed([item(1, 10, '2026-11-02', { rating: 4 })])));
    assert.equal(lib.get(555), undefined, 'the wrong entry is gone');
    assert.equal(lib.get(10)!.rating, 4);
    assert.equal(lib.rated.length, 1);
    assert.equal(lib.lbKeys['film 10 & more|2020'], 10);
  });

  test('username cleaning', () => {
    assert.equal(cleanUsername(' https://letterboxd.com/Some_User/ '), 'Some_User');
    assert.equal(cleanUsername('@abc'), 'abc');
    assert.equal(cleanUsername('bad name/../x'), undefined);
  });
});

describe('title matching', () => {
  test('scores', () => {
    assert.ok(matchScore(film(1, 'Glass Onion: A Knives Out Mystery', { year: 2022, votes: 5000 }), 'Glass Onion', 2022) > 100);
    assert.ok(matchScore(film(2, 'Onion', { year: 2022, votes: 20 }), 'Glass Onion', 2022) < 100);
    assert.ok(matchScore(film(3, 'Amélie', { year: 2001 }), 'Amelie', 2001) > 130);
    assert.ok(matchScore(film(4, 'Dune', { year: 1984 }), 'Dune', 2021) < 100);
    assert.ok(matchScore(film(5, 'Hamilton', { year: 2025, votes: 170 }), 'Hamilton', 2020, true) > 100, 're-released film found by year search');
    assert.ok(matchScore(film(6, 'Hamilton: History Has Its Eyes On You', { year: 2020, votes: 8 }), 'Hamilton', 2020, true) < 100);
    // Festival year vs release year: the real film beats a voteless namesake with the exact year.
    assert.ok(matchScore(film(7, 'Obsession', { year: 2026, votes: 6652 }), 'Obsession', 2025) > matchScore(film(8, 'Obsession', { year: 2025, votes: 1 }), 'Obsession', 2025));
    assert.ok(matchScore(film(9, 'Twins', { year: 1988, votes: 500 }), 'Twins', 1988) > matchScore(film(10, 'Twins', { year: 1989, votes: 50000 }), 'Twins', 1988), 'a real film with the exact year still wins');
  });
});

describe('hard filters', () => {
  const netflix: Prov = { id: 8, name: 'Netflix', logo: null };
  const sv = new Services('DE', { 8: 'Netflix' });
  const lib = new Library();
  const ok = film(1, 'Ok', { flat: [netflix] });

  test('passes when everything fits', () => {
    const r = newRequest({ genres: [18], yearMin: 2010, yearMax: 2020, runMin: 90, runMax: 120, langs: ['en'], streamingOnly: true });
    assert.equal(rejectReason(ok, r, lib, sv), undefined);
  });
  test('each filter rejects', () => {
    assert.equal(rejectReason(ok, newRequest({ genres: [18, 35] }), lib, sv), 'genre');
    assert.equal(rejectReason(ok, newRequest({ notGenres: [18] }), lib, sv), 'genre');
    assert.equal(rejectReason(ok, newRequest({ yearMin: 2016 }), lib, sv), 'year');
    assert.equal(rejectReason(ok, newRequest({ yearMax: 2014 }), lib, sv), 'year');
    assert.equal(rejectReason(ok, newRequest({ runMax: 100 }), lib, sv), 'runtime');
    assert.equal(rejectReason(ok, newRequest({ runMin: 120 }), lib, sv), 'runtime');
    assert.equal(rejectReason(ok, newRequest({ langs: ['fr'] }), lib, sv), 'language');
    const only = newRequest({ streamingOnly: true });
    assert.equal(rejectReason(film(2, 'Elsewhere', { flat: [{ id: 337, name: 'Disney Plus', logo: null }] }), only, lib, sv), 'streaming');
    assert.equal(rejectReason(film(3, 'Other region', { flat: [netflix], region: 'US' }), only, lib, sv), 'streaming');
    assert.equal(rejectReason(film(4, 'Ads tier', { flat: [{ id: 1796, name: 'Netflix Standard with Ads', logo: null }] }), only, lib, sv), undefined);
    assert.equal(rejectReason(ok, newRequest(), lib, sv, { shown: new Set([1]) }), 'shown');
    assert.equal(rejectReason(film(5, 'Unknown runtime', { runtime: 0 }), newRequest({ runMax: 100 }), lib, sv), 'runtime');
    assert.equal(rejectReason(makeFilm({ id: 6, title: 'Future', release: '2999-01-01', poster: '/x', votes: 100, full: true }), newRequest(), lib, sv), 'unreleased');
    assert.equal(rejectReason(film(8, 'Short', { runtime: 12 }), newRequest(), lib, sv), 'short film');
  });
  test('watched and dismissed films', () => {
    const l = new Library();
    l.rate(1, 4);
    l.setNotInterested(7, true);
    assert.equal(rejectReason(ok, newRequest(), l, sv), 'watched');
    assert.equal(rejectReason(ok, newRequest({ excludeWatched: false }), l, sv), undefined);
    assert.equal(rejectReason(film(7, 'No'), newRequest({ excludeWatched: false }), l, sv), 'not interested');
  });
});

describe('explanations', () => {
  const cache = new FilmCache();
  cache.put(film(1, 'Loved Film'));
  cache.put(film(2, 'Hated Film'));
  const lib = new Library();
  lib.rate(1, 4.5);
  lib.rate(2, 1.5);
  const tags = { L1: 1, L2: 2 };
  test('tags become titles and are recorded', () => {
    const w = validateWhy('Shares the slow-burn tension of [L1] and fits a quiet night.', tags, lib, cache)!;
    assert.equal(w.text, 'Shares the slow-burn tension of Loved Film and fits a quiet night.');
    assert.deepEqual(w.refs, [1]);
  });
  test('rejects unknown tags, low-rated anchors and star claims', () => {
    assert.equal(validateWhy('Just like [L9], which you adored.', tags, lib, cache), undefined);
    assert.equal(validateWhy('You loved [L2], so this is for you.', tags, lib, cache), undefined);
    assert.equal(validateWhy('You gave [L1] 5 stars, so this is for you.', tags, lib, cache), undefined);
  });
  test('keeps the sound sentences and drops the unverifiable one', () => {
    const w = validateWhy('A tense, patient thriller with the slow-burn dread of [L1]. You also adored [L2]. Dry humour keeps it light.', tags, lib, cache)!;
    assert.equal(w.text, 'A tense, patient thriller with the slow-burn dread of Loved Film. Dry humour keeps it light.');
    assert.deepEqual(w.refs, [1]);
    assert.equal(validateWhy('You adored [L2]. Fun.', tags, lib, cache), undefined, 'too little left');
  });
});

describe('llm output parsing', () => {
  test('json with prose and fences', () => {
    assert.ok(extractJson('Sure!\n```json\n{"picks":[{"t":"A","y":1}]}\n```')!.picks.length > 0);
    assert.equal(extractJson('nothing here'), undefined);
  });
  test('json lines', () => {
    const rows = extractJsonLines('{"c":1,"r":4}\nnoise\n{"c":2,"r":3.5},\n{broken');
    assert.equal(rows.length, 2);
    assert.equal(rows[1].r, 3.5);
  });
});

describe('id token crypto', () => {
  test('base64url round trip', () => {
    for (const len of [0, 1, 2, 3, 4, 31, 32, 33]) {
      const b = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 5) & 255);
      assert.deepEqual([...b64urlDecode(b64urlEncode(b))], [...b]);
      assert.equal(b64urlEncode(b), Buffer.from(b).toString('base64url'));
    }
  });
  test('RS256 verification accepts a real signature and rejects tampering', () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
    const data = new TextEncoder().encode('header.payload');
    const sig = new Uint8Array(createSign('RSA-SHA256').update(data).sign(privateKey));
    const n = b64urlDecode(jwk.n);
    const e = b64urlDecode(jwk.e);
    assert.equal(verifyRs256(data, sig, n, e), true);
    assert.equal(verifyRs256(new TextEncoder().encode('header.payloae'), sig, n, e), false);
    const bad = Uint8Array.from(sig);
    bad[10] ^= 1;
    assert.equal(verifyRs256(data, bad, n, e), false);
  });
});

describe('privacy policy', () => {
  test('the in-app copy matches PRIVACY.md', async () => {
    const { readFileSync } = await import('node:fs');
    const { plainPrivacy } = await import('../../../tool/sync-privacy');
    const { PRIVACY_TEXT } = await import('../../app/privacy');
    assert.equal(PRIVACY_TEXT, plainPrivacy(readFileSync('PRIVACY.md', 'utf8')));
  });
});

describe('background scenes', () => {
  const backdrops = [
    { file_path: '/main.jpg', iso_639_1: null, vote_average: 5.8, vote_count: 7 },
    { file_path: '/titled.jpg', iso_639_1: 'en', vote_average: 9, vote_count: 50 },
    { file_path: '/low.jpg', iso_639_1: null, vote_average: 2, vote_count: 3 },
    { file_path: '/high.jpg', iso_639_1: null, vote_average: 5.7, vote_count: 29 },
    { file_path: '/tie.jpg', iso_639_1: null, vote_average: 2, vote_count: 9 },
  ];

  test('candidates: main image first, then textless ones by rating', () => {
    assert.deepEqual(rankStills('/main.jpg', backdrops), ['/main.jpg', '/high.jpg', '/tie.jpg', '/low.jpg']);
    assert.deepEqual(rankStills('/main.jpg', backdrops, 2), ['/main.jpg', '/high.jpg']);
    assert.deepEqual(rankStills(undefined, backdrops, 1), ['/main.jpg']);
    assert.deepEqual(rankStills('/only.jpg', undefined), ['/only.jpg']);
    assert.deepEqual(rankStills(undefined, 'nonsense'), []);
  });

  test('the model sees each film and its numbered images', () => {
    const parts = sceneParts([{ film: film(1, 'Heat', { year: 1995 }), stills: ['/a.jpg', '/b.jpg'] }]);
    assert.equal(parts.length, 5);
    assert.match((parts[0] as { text: string }).text, /^Film 1: Heat \(1995\)\. 2 candidate images/);
    assert.deepEqual(parts[2], { image: 'https://image.tmdb.org/t/p/w300/a.jpg' });
    assert.deepEqual(parts[3], { text: 'Film 1, image 1:' });
  });

  test('choices are read per film; anything unusable falls back to the main image', () => {
    const items = [1, 2, 3, 4].map((id) => ({ film: film(id, `F${id}`), stills: [`/${id}-0.jpg`, `/${id}-1.jpg`, `/${id}-2.jpg`] }));
    const out = parseScenes('{"f":1,"scenes":[2],"pick":2}\n{"f":2,"scenes":[],"pick":7}\nnot json\n{"f":4,"scenes":[1],"pick":1}\n{"f":4,"scenes":[0],"pick":0}\n{"f":9,"pick":0}', items);
    assert.deepEqual([...out], [[1, '/1-2.jpg'], [4, '/4-1.jpg'], [2, '/2-0.jpg'], [3, '/3-0.jpg']]);
  });

  test('a chosen scene survives saving and a refresh of the film', () => {
    const f = film(7, 'Zodiac', { scene: '/scene.jpg' });
    assert.equal(filmFromJson(filmToJson(f)).scene, '/scene.jpg');
    assert.equal(filmFromJson(filmToJson(film(8, 'None', { scene: '' }))).scene, '');
    assert.equal(filmFromJson(filmToJson(film(9, 'Undecided'))).scene, undefined);
    const cache = new FilmCache();
    cache.put(f);
    assert.equal(cache.put(film(7, 'Zodiac', { vote: 8 })).scene, '/scene.jpg');
  });
});

describe('wait screen fly-through', () => {
  const input = (o: Partial<FieldInput> = {}): FieldInput => ({ found: [], finalists: [], verdicts: [], done: false, miss: MISS, ...o });
  const run = (f: Field, inp: FieldInput, secs: number) => {
    for (let t = 0; t < secs; t += 1 / 30) step(f, inp, 1 / 30);
  };

  test('found films come off the far wall into the flight', () => {
    const f = newField(400, 860);
    run(f, input(), 2);
    assert.ok(f.ps.length > 200 && f.ps.every((p) => p.film === ''), 'at first only the user\'s own films fly');
    const found = [...Array(20)].map((_, i) => `/found${i}.jpg`);
    run(f, input({ found }), 0.5);
    const flying = new Set(f.ps.filter((p) => p.film).map((p) => p.film));
    assert.equal(flying.size, 20, 'every found film is in the flight');
    assert.ok(sprites(f).some((s) => s.film && s.edge > 0), 'found films carry the accent edge');
  });

  test('the rated films gather, the better ones in front; below the cutoff they go back to the wall', () => {
    const f = newField(400, 860);
    const finalists = [...Array(30)].map((_, i) => `/f${i}.jpg`);
    const verdicts: [string, number][] = [];
    const inp = input({ found: finalists, finalists, verdicts });
    run(f, inp, 3);
    assert.equal(Object.keys(f.cloud).length, 30, 'every film being rated is in the cloud');
    assert.ok(speed(f) < 0.3, 'the flight slows down while rating');
    finalists.forEach((film, i) => verdicts.push([film, [2, 3, 4, 5, 2.5, 3.5][i % 6]]));
    run(f, inp, 12);
    const kept = finalists.filter((_, i) => [2, 3, 4, 5, 2.5, 3.5][i % 6] >= MISS);
    assert.deepEqual(Object.keys(f.cloud).sort(), kept.sort(), 'only the films that make the feed stay');
    const depth = (film: string) => f.ps[f.cloud[film]].z;
    assert.ok(depth('/f3.jpg') < depth('/f2.jpg') && depth('/f2.jpg') < depth('/f1.jpg'), '5 stars in front of 4, 4 in front of 3');
    assert.ok(!f.ps.some((p) => p.film === '/f0.jpg' && p.hold), 'a 2-star film has left the cloud');

    // The search is done: the flight stops, the cloud holds.
    run(f, { ...inp, done: true }, 1);
    assert.equal(speed(f), 0);
    assert.deepEqual(Object.keys(f.cloud).sort(), kept.sort());
  });
});
