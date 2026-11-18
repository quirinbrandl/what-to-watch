import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Film, makeFilm } from '../models';
import { mixStarters, seriesKey } from '../starters';

const film = (id: number, title: string, poster = true): Film => makeFilm({ id, title, poster: poster ? `/p${id}.jpg` : undefined });

describe('films to rate during onboarding', () => {
  test('a series counts once', () => {
    assert.equal(seriesKey('Iron Man 3'), seriesKey('Iron Man'));
    assert.equal(seriesKey('The Lord of the Rings: The Two Towers'), seriesKey('The Lord of the Rings: The Return of the King'));
    assert.equal(seriesKey('Harry Potter and the Chamber of Secrets'), seriesKey("Harry Potter and the Philosopher's Stone"));
    assert.equal(seriesKey('Spider-Man: No Way Home'), seriesKey('Spider-Man'));
    assert.notEqual(seriesKey('Up'), seriesKey('Inside Out'));
  });

  test('takes from each list in turn, without repeats, series twins or posterless films', () => {
    const all = [film(1, 'Interstellar'), film(2, 'Iron Man'), film(3, 'Iron Man 2'), film(4, 'Heat')];
    const old = [film(5, 'Pulp Fiction'), film(1, 'Interstellar'), film(6, 'Alien', false), film(7, 'Goodfellas')];
    const anim = [film(8, 'Up'), film(9, 'Toy Story'), film(10, 'Toy Story 3')];
    assert.deepEqual(
      mixStarters([all, old, anim]).map((f) => f.id),
      [1, 5, 8, 2, 9, 4, 7],
    );
    assert.equal(mixStarters([all, old, anim], 3).length, 3);
  });
});
