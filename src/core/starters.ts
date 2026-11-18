import { Film } from './models';

/**
 * The films offered for rating during onboarding: the most-rated films
 * across eras and kinds, so most people have seen several of them.
 * Each entry is a TMDB /discover query, sorted by vote count.
 */
export const STARTER_QUERIES: Record<string, string>[] = (
  [
    {},
    { 'primary_release_date.lte': '1999-12-31' },
    {
      'primary_release_date.gte': '2000-01-01',
      'primary_release_date.lte': '2009-12-31',
    },
    {
      'primary_release_date.gte': '2010-01-01',
      'primary_release_date.lte': '2019-12-31',
    },
    { 'primary_release_date.gte': '2020-01-01' },
    { with_genres: '16' }, // animation
    { with_genres: '10749' }, // romance
    { with_genres: '35' }, // comedy
    { with_genres: '27' }, // horror
    { with_genres: '18' }, // drama
  ] as Record<string, string>[]
).map((q) => ({ sort_by: 'vote_count.desc', ...q }));

/** "Iron Man 3" and "Iron Man" share a key, so a series shows up once. */
export const seriesKey = (title: string): string =>
  title
    .toLowerCase()
    .split(':')[0]
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 2)
    .join(' ');

/** Takes from each list in turn, so the first rows already mix eras and genres. Films without a poster are left out. */
export function mixStarters(lists: Film[][], max = 60): Film[] {
  const ids = new Set<number>();
  const series = new Set<string>();
  const out: Film[] = [];
  for (let i = 0; out.length < max && lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      const f = l[i];
      if (!f?.poster || ids.has(f.id) || out.length >= max) continue;
      ids.add(f.id);
      const key = seriesKey(f.title);
      if (series.has(key)) continue;
      series.add(key);
      out.push(f);
    }
  }
  return out;
}
