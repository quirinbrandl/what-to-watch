import { Prov } from './models';

/**
 * The services worth offering in the "where to watch" filter, in TMDB's order.
 * Left out: plan variants of a listed service ("Amazon Prime Video with Ads"
 * when "Amazon Prime Video" is there — picking the service covers its
 * variants anyway) and shops that only rent or sell ("Apple TV Store"),
 * which the filter never matches.
 */
export function pickableServices(catalog: Prov[]): Prov[] {
  const names = catalog.map((p) => p.name.toLowerCase());
  return catalog.filter((p) => {
    const n = p.name.toLowerCase();
    if (/\sstore$/.test(n)) return false;
    return !names.some((m) => m !== n && n.startsWith(`${m} `));
  });
}
