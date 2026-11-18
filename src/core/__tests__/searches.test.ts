import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Pick, Session } from '../engine/recommender';
import { Services, newRequest, rejectReason, requestFromJson } from '../engine/request';
import { MAX_SEARCHES, SavedSearch, addSearch, historyFromJson, historyToJson, searchFilters, searchTitle, whenLabel } from '../history';
import { LbExport, LbFilm, applyExport, dropWatchlistOnly } from '../letterboxd';
import { Film, Library, makeFilm } from '../models';
import { guessRegion, regionFromTimeZone } from '../region';
import { pickableServices } from '../services';
import { FilmCache } from '../tmdb';

const film = (id: number, title: string): Film =>
  makeFilm({ id, title, release: '2015-05-01', runtime: 110, genres: [18], lang: 'en', poster: `/p${id}.jpg`, vote: 7.5, votes: 2000, directors: ['A Director'], full: true });

const pick = (f: Film): Pick => ({ film: f, predicted: 4.1, why: 'Because.', anchors: [], facts: [], personal: true });

describe('region from the phone, without location access', () => {
  const known = { DE: 'Germany', AT: 'Austria', US: 'United States', GB: 'United Kingdom', AU: 'Australia', AR: 'Argentina' };

  test('time zones map to their country', () => {
    assert.equal(regionFromTimeZone('Europe/Berlin'), 'DE');
    assert.equal(regionFromTimeZone('Europe/Vienna'), 'AT');
    assert.equal(regionFromTimeZone('America/Indiana/Indianapolis'), 'US');
    assert.equal(regionFromTimeZone('America/Argentina/Cordoba'), 'AR');
    assert.equal(regionFromTimeZone('Australia/Perth'), 'AU');
    assert.equal(regionFromTimeZone('Asia/Dubai'), undefined);
    assert.equal(regionFromTimeZone(undefined), undefined);
  });

  test('where the phone is beats the language setting; Germany when nothing fits', () => {
    // An English phone in Vienna is in Austria.
    assert.equal(guessRegion({ timeZone: 'Europe/Vienna', localeRegion: 'US' }, known), 'AT');
    // A time zone without streaming data falls back to the language region…
    assert.equal(guessRegion({ timeZone: 'Asia/Dubai', localeRegion: 'gb' }, known), 'GB');
    // …and to Germany when that does not help either.
    assert.equal(guessRegion({ timeZone: 'Asia/Dubai', localeRegion: 'AE' }, known), 'DE');
    assert.equal(guessRegion({}, known), 'DE');
  });
});

describe('services offered in the filter', () => {
  test('one tile per service: no plan variants, no rent-or-buy shops', () => {
    const names = ['Netflix', 'Amazon Prime Video', 'Apple TV', 'Disney Plus', 'Apple TV Store', 'Amazon Video', 'Amazon Prime Video with Ads', 'Netflix Standard with Ads', 'Paramount Plus', 'Paramount+ Amazon Channel', 'Sky Store', 'RTL+'];
    const kept = pickableServices(names.map((name, id) => ({ id, name, logo: null }))).map((p) => p.name);
    assert.deepEqual(kept, ['Netflix', 'Amazon Prime Video', 'Apple TV', 'Disney Plus', 'Amazon Video', 'Paramount Plus', 'Paramount+ Amazon Channel', 'RTL+']);
  });
});

describe('hide films on the watchlist', () => {
  const lib = new Library();
  const f = film(1, 'Wanted');
  lib.setWatchlist(1, true);
  const sv = new Services('DE');

  test('off by default, also for requests saved before the option existed', () => {
    assert.equal(newRequest().excludeWatchlist, false);
    assert.equal(requestFromJson({ prompt: 'x' }).excludeWatchlist, false);
    assert.equal(requestFromJson({ excludeWatchlist: true }).excludeWatchlist, true);
    assert.equal(requestFromJson({ prompt: 'x' }).recent, false, 'new releases are off unless asked for');
    assert.equal(rejectReason(f, newRequest(), lib, sv), undefined);
  });

  test('when on, watchlist films are rejected', () => {
    const r = newRequest({ excludeWatchlist: true });
    assert.equal(rejectReason(f, r, lib, sv), 'watchlist');
    assert.equal(rejectReason(film(2, 'Other'), r, lib, sv), undefined);
  });
});

describe('Letterboxd import without the watchlist', () => {
  const lb = (name: string, o: Partial<LbFilm>, id: number) => Object.assign(new LbFilm(name, 2015), { tmdbId: id }, o);

  test('films only on the watchlist stay out; seen films keep everything else', () => {
    const ex = new LbExport();
    const rated = lb('Rated', { rating: 4, watched: true }, 1);
    const wanted = lb('Wanted', { watchlist: true }, 2);
    const both = lb('Seen and listed', { watched: true, watchlist: true }, 3);
    for (const f of [rated, wanted, both]) ex.films.set(f.key, f);
    assert.equal(dropWatchlistOnly(ex), 1);
    assert.deepEqual([...ex.films.values()].map((f) => f.name), ['Rated', 'Seen and listed']);
    const lib = new Library();
    applyExport(lib, ex);
    assert.equal(lib.rated.length, 1);
    assert.equal(lib.watched.length, 2);
    assert.equal(lib.watchlist.length, 0);
  });
});

describe('saved searches', () => {
  const films = new FilmCache();
  const a = films.put(film(10, 'Heat'));
  const b = films.put(film(11, 'Zodiac'));
  const search = (id: string, prompt: string, at = Date.now()): SavedSearch => {
    const s = new Session(newRequest({ prompt, genres: [53], yearMin: 1990 }));
    s.picks = [pick(a), pick(b)];
    return { id, at, region: 'DE', services: [{ id: 8, name: 'Netflix', logo: '/n.png' }], session: s };
  };

  test('a search survives saving: request, films, services and which one is open', () => {
    const list = [search('x', 'slow-burn and clever'), search('y', '')];
    const back = historyFromJson(JSON.parse(JSON.stringify(historyToJson(list, 'y'))), films);
    assert.equal(back.current, 'y');
    assert.equal(back.list.length, 2);
    const e = back.list[0];
    assert.equal(e.session.request.prompt, 'slow-burn and clever');
    assert.deepEqual(e.session.picks.map((p) => p.film.title), ['Heat', 'Zodiac']);
    assert.deepEqual(e.session.picks.map((p) => p.why), ['Because.', 'Because.']);
    assert.deepEqual(e.services, [{ id: 8, name: 'Netflix', logo: '/n.png' }]);
  });

  test('broken or empty entries are skipped; an unknown current id is dropped', () => {
    const empty = search('e', 'nothing');
    empty.session.picks = [];
    const j = historyToJson([search('x', 'ok'), empty], 'gone') as { list: unknown[] };
    j.list.push({ id: 3 }, null);
    const back = historyFromJson(j, films);
    assert.deepEqual(back.list.map((e) => e.id), ['x']);
    assert.equal(back.current, undefined);
    assert.deepEqual(historyFromJson(undefined, films).list, []);
  });

  test('newest first, at most MAX_SEARCHES, no duplicates', () => {
    let list: SavedSearch[] = [];
    for (let i = 0; i < MAX_SEARCHES + 3; i++) list = addSearch(list, search(`s${i}`, `q${i}`));
    assert.equal(list.length, MAX_SEARCHES);
    assert.equal(list[0].id, `s${MAX_SEARCHES + 2}`);
    list = addSearch(list, list[5]);
    assert.equal(list.length, MAX_SEARCHES);
    assert.equal(list.filter((e) => e.id === list[0].id).length, 1);
  });

  test('titles and details read like the user would say them', () => {
    assert.equal(searchTitle(search('x', '  dark and funny ')), 'dark and funny');
    assert.equal(searchTitle({ ...search('y', ''), seedTitle: 'Heat' }), 'More like Heat');
    assert.equal(searchTitle(search('z', '')), 'Anything good tonight');
    assert.deepEqual(searchFilters(search('x', '')), ['Netflix', 'Thriller', '1990–now']);
    const more = search('m', '');
    Object.assign(more.session.request, { obscurity: 0.25, excludeWatchlist: true, langs: ['ko'], personalize: false, recent: true });
    assert.deepEqual(searchFilters(more), ['Netflix', 'Thriller', '1990–now', 'Korean', 'Popular', 'not personal', 'not on watchlist', 'new releases']);
  });

  test('when a search was made, relative to now', () => {
    const now = new Date(2026, 10, 18, 20, 0).getTime();
    assert.equal(whenLabel(new Date(2026, 10, 18, 9, 5).getTime(), now), 'Today, 09:05');
    assert.equal(whenLabel(new Date(2026, 10, 17, 21, 30).getTime(), now), 'Yesterday, 21:30');
    assert.equal(whenLabel(new Date(2026, 10, 14, 18, 0).getTime(), now), 'Sat, 18:00');
    assert.equal(whenLabel(new Date(2026, 9, 2, 18, 0).getTime(), now), 'Fri 2 Oct');
    assert.equal(whenLabel(new Date(2025, 9, 2, 18, 0).getTime(), now), '2 Oct 2025');
  });
});
