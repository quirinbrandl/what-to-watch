/**
 * Where the phone is, for streaming availability, without asking for its
 * location and without a network call: the time zone the phone has set for
 * itself (with automatic time zones on, that follows the mobile network, so
 * it changes when you travel), then the region of its language settings.
 */

/** Time zones by country, for the countries TMDB has streaming data for. */
const ZONES: Record<string, string[]> = {
  AT: ['Europe/Vienna'],
  BE: ['Europe/Brussels'],
  BR: [
    'America/Sao_Paulo',
    'America/Bahia',
    'America/Fortaleza',
    'America/Recife',
    'America/Belem',
    'America/Manaus',
    'America/Cuiaba',
    'America/Campo_Grande',
    'America/Porto_Velho',
    'America/Boa_Vista',
    'America/Rio_Branco',
    'America/Araguaina',
    'America/Maceio',
    'America/Santarem',
    'America/Noronha',
    'America/Eirunepe',
    'Brazil/East',
    'Brazil/West',
    'Brazil/Acre',
    'Brazil/DeNoronha',
  ],
  CA: [
    'America/Toronto',
    'America/Vancouver',
    'America/Edmonton',
    'America/Winnipeg',
    'America/Halifax',
    'America/St_Johns',
    'America/Regina',
    'America/Montreal',
    'America/Moncton',
    'America/Glace_Bay',
    'America/Goose_Bay',
    'America/Whitehorse',
    'America/Dawson_Creek',
    'America/Dawson',
    'America/Yellowknife',
    'America/Iqaluit',
    'America/Swift_Current',
    'America/Thunder_Bay',
    'America/Nipigon',
    'America/Rainy_River',
    'America/Rankin_Inlet',
    'America/Resolute',
    'America/Cambridge_Bay',
    'America/Inuvik',
    'America/Creston',
    'America/Fort_Nelson',
    'America/Atikokan',
    'America/Blanc-Sablon',
    'America/Pangnirtung',
  ],
  CL: ['America/Santiago', 'America/Punta_Arenas', 'Pacific/Easter'],
  CO: ['America/Bogota'],
  CZ: ['Europe/Prague'],
  DK: ['Europe/Copenhagen'],
  FI: ['Europe/Helsinki'],
  FR: ['Europe/Paris'],
  DE: ['Europe/Berlin', 'Europe/Busingen'],
  GR: ['Europe/Athens'],
  HK: ['Asia/Hong_Kong', 'Hongkong'],
  HU: ['Europe/Budapest'],
  IN: ['Asia/Kolkata', 'Asia/Calcutta'],
  ID: ['Asia/Jakarta', 'Asia/Pontianak', 'Asia/Makassar', 'Asia/Jayapura'],
  IE: ['Europe/Dublin', 'Eire'],
  IL: ['Asia/Jerusalem', 'Asia/Tel_Aviv', 'Israel'],
  IT: ['Europe/Rome'],
  JP: ['Asia/Tokyo', 'Japan'],
  MX: [
    'America/Mexico_City',
    'America/Cancun',
    'America/Merida',
    'America/Monterrey',
    'America/Matamoros',
    'America/Chihuahua',
    'America/Ciudad_Juarez',
    'America/Ojinaga',
    'America/Mazatlan',
    'America/Bahia_Banderas',
    'America/Hermosillo',
    'America/Tijuana',
  ],
  NL: ['Europe/Amsterdam'],
  NZ: ['Pacific/Auckland', 'Pacific/Chatham', 'NZ'],
  NO: ['Europe/Oslo'],
  PH: ['Asia/Manila'],
  PL: ['Europe/Warsaw', 'Poland'],
  PT: ['Europe/Lisbon', 'Atlantic/Madeira', 'Atlantic/Azores', 'Portugal'],
  RO: ['Europe/Bucharest'],
  SG: ['Asia/Singapore', 'Singapore'],
  ZA: ['Africa/Johannesburg'],
  KR: ['Asia/Seoul', 'ROK'],
  ES: ['Europe/Madrid', 'Africa/Ceuta', 'Atlantic/Canary'],
  SE: ['Europe/Stockholm'],
  CH: ['Europe/Zurich'],
  TW: ['Asia/Taipei', 'ROC'],
  TH: ['Asia/Bangkok'],
  TR: ['Europe/Istanbul', 'Asia/Istanbul', 'Turkey'],
  GB: ['Europe/London', 'Europe/Belfast', 'GB'],
  US: [
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'America/Phoenix',
    'America/Anchorage',
    'America/Juneau',
    'America/Sitka',
    'America/Metlakatla',
    'America/Yakutat',
    'America/Nome',
    'America/Adak',
    'Pacific/Honolulu',
    'America/Detroit',
    'America/Boise',
    'America/Menominee',
    'America/Indianapolis',
    'America/Louisville',
  ],
};

/** Whole families of zones that belong to one country. */
const PREFIXES: [string, string][] = [
  ['America/Argentina/', 'AR'],
  ['Australia/', 'AU'],
  ['America/Indiana/', 'US'],
  ['America/Kentucky/', 'US'],
  ['America/North_Dakota/', 'US'],
  ['US/', 'US'],
  ['Canada/', 'CA'],
  ['Mexico/', 'MX'],
  ['Chile/', 'CL'],
];

const BY_ZONE = new Map<string, string>(Object.entries(ZONES).flatMap(([cc, zones]) => zones.map((z) => [z, cc] as [string, string])));
for (const z of ['America/Buenos_Aires', 'America/Cordoba', 'America/Mendoza', 'America/Catamarca', 'America/Jujuy', 'America/Rosario']) BY_ZONE.set(z, 'AR');

/** The country a time zone belongs to, when it is one with streaming data. */
export function regionFromTimeZone(tz: string | undefined | null): string | undefined {
  if (!tz) return undefined;
  const direct = BY_ZONE.get(tz);
  if (direct) return direct;
  return PREFIXES.find(([p]) => tz.startsWith(p))?.[1];
}

/** Germany when nothing else tells us where the phone is. */
export const FALLBACK_REGION = 'DE';

/** Best guess of the country for streaming availability; `known` lists the supported ones. */
export function guessRegion(o: { timeZone?: string | null; localeRegion?: string | null }, known: Record<string, string>): string {
  const tz = regionFromTimeZone(o.timeZone);
  if (tz && tz in known) return tz;
  const loc = o.localeRegion?.toUpperCase();
  if (loc && loc in known) return loc;
  return FALLBACK_REGION;
}
