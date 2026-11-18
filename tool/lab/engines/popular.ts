// Baseline without any LLM and without any personal taste: the same list for everyone.
//   --set sort=votes    the films with the most TMDB votes (best known)   [default]
//   --set sort=rating   the best-rated films with at least `minVotes` votes (default 2000)
import { Engine } from '../lab';

const engine: Engine = async (_input, io) => {
  const sort = io.param('sort', 'votes');
  const minVotes = io.param('minVotes', '2000');
  const base = { 'primary_release_date.lte': '2023-10-12' };
  const films =
    sort === 'rating'
      ? await io.data.list(`rating-${minVotes}`, { ...base, sort_by: 'vote_average.desc', 'vote_count.gte': minVotes }, 25)
      : await io.data.list('votes', { ...base, sort_by: 'vote_count.desc' }, 25);
  return films.map((f) => f.id);
};

export default engine;
