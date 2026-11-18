import { getCalendars, getLocales } from 'expo-localization';
import { useSyncExternalStore } from 'react';
import { AppState as NativeAppState } from 'react-native';

import { AuthError, ChatGptAuth } from '../core/auth';
import { Recommender, engineConfig } from '../core/engine/recommender';
import { Request, Services, newRequest, requestFromJson } from '../core/engine/request';
import { Service } from '../core/history';
import { LbExport, LbNotFound, applyExport, applyRss, cleanUsername, dropWatchlistOnly, fetchRss, matchExport, seedMatches } from '../core/letterboxd';
import { Llm, LlmError, LlmModel } from '../core/llm';
import { Film, Library, Prov } from '../core/models';
import { guessRegion } from '../core/region';
import { FilmCache, Tmdb } from '../core/tmdb';

import { AUTH_RETURN_URL, authPlatform, files, secrets } from './platform';

/** Minimal observable store; components subscribe with `useStore`. */
export class Observable {
  private listeners = new Set<() => void>();
  private version = 0;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  snapshot = () => this.version;
  notify(): void {
    this.version++;
    for (const l of this.listeners) l();
  }
}

export function useStore<T extends Observable>(store: T): T {
  useSyncExternalStore(store.subscribe, store.snapshot);
  return store;
}

/** ISO 3166 regions where TMDB has watch-provider data, by display name. */
export const REGIONS: Record<string, string> = {
  AR: 'Argentina', AU: 'Australia', AT: 'Austria', BE: 'Belgium', BR: 'Brazil', CA: 'Canada', CL: 'Chile',
  CO: 'Colombia', CZ: 'Czechia', DK: 'Denmark', FI: 'Finland', FR: 'France', DE: 'Germany', GR: 'Greece',
  HK: 'Hong Kong', HU: 'Hungary', IN: 'India', ID: 'Indonesia', IE: 'Ireland', IL: 'Israel', IT: 'Italy',
  JP: 'Japan', MX: 'Mexico', NL: 'Netherlands', NZ: 'New Zealand', NO: 'Norway', PH: 'Philippines', PL: 'Poland',
  PT: 'Portugal', RO: 'Romania', SG: 'Singapore', ZA: 'South Africa', KR: 'South Korea', ES: 'Spain', SE: 'Sweden',
  CH: 'Switzerland', TW: 'Taiwan', TH: 'Thailand', TR: 'Türkiye', GB: 'United Kingdom', US: 'United States',
};

export interface Settings {
  region: string;
  /** The streaming services picked in the filter for the next search; empty = anywhere. */
  services: Service[];
  model?: string;
  useApiKey: boolean;
  onboarded: boolean;
  welcomeSeen: boolean;
  flipHintSeen: boolean;
  /** How long each stage of a search took lately, in seconds (ratings, proposing, checking, rating). Feeds the progress bar. */
  stageSecs?: number[];
  request: Request;
}

/** Where the phone is, from its time zone and language settings; no location access, no network. */
function deviceRegion(): string {
  let timeZone: string | null | undefined;
  let localeRegion: string | null | undefined;
  try {
    timeZone = getCalendars()[0]?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {}
  try {
    localeRegion = getLocales()[0]?.regionCode;
  } catch {}
  return guessRegion({ timeZone, localeRegion }, REGIONS);
}

/** Services as the recommender wants them: id → name. */
export const servicesOf = (region: string, list: Service[]): Services => new Services(region, Object.fromEntries(list.map((x) => [x.id, x.name])));

const newSettings = (): Settings => ({
  region: deviceRegion(),
  services: [],
  useApiKey: false,
  onboarded: false,
  welcomeSeen: false,
  flipHintSeen: false,
  request: newRequest(),
});

function settingsFromJson(j: any): Settings {
  const s = newSettings();
  if (typeof j?.region === 'string') s.region = j.region;
  if (Array.isArray(j?.services)) {
    s.services = j.services.filter((x: any) => x && typeof x.id === 'number' && typeof x.name === 'string').map((x: any) => ({ id: x.id, name: x.name, logo: x.logo ?? null }));
  } else if (j?.request?.streamingOnly === true && j?.providers) {
    // Older versions kept "my services" in Settings and switched them on per search.
    s.services = Object.entries(j.providers as Record<string, string>).map(([id, name]) => ({ id: Number(id), name: String(name), logo: j.providerLogos?.[id] ?? null }));
  }
  s.model = j?.model ?? undefined;
  s.useApiKey = j?.useApiKey === true;
  s.onboarded = j?.onboarded === true;
  s.welcomeSeen = j?.welcomeSeen === true;
  s.flipHintSeen = j?.flipHintSeen === true;
  if (Array.isArray(j?.stageSecs) && j.stageSecs.length === 4 && j.stageSecs.every((x: unknown) => typeof x === 'number' && x > 0 && x < 600)) s.stageSecs = j.stageSecs;
  if (j?.request) s.request = requestFromJson(j.request);
  s.request.streamingOnly = s.services.length > 0;
  return s;
}

export interface ImportProgress {
  label: string;
  done: number;
  total: number;
  posters: string[];
}

const API_KEY = 'openai_api_key';

/**
 * App-wide state: library, settings, accounts and the services built on
 * them. Everything is stored on the device.
 */
export class AppState extends Observable {
  readonly films = new FilmCache();
  readonly lib = new Library();
  settings = newSettings();
  readonly tmdb = new Tmdb(this.films);
  readonly auth = new ChatGptAuth(authPlatform);
  readonly llm = new Llm(() => this.token());
  readonly rec = new Recommender(this.tmdb, this.llm, this.lib, this.services, engineConfig(''));
  ready = false;
  apiKey?: string;
  models: LlmModel[] = [];
  importing?: ImportProgress;
  syncing = false;
  syncError?: string;
  lastSyncAdded = 0;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private filmTimer?: ReturnType<typeof setTimeout>;

  /** The streaming services of the filter, for the next search. */
  get services(): Services {
    return servicesOf(this.settings.region, this.settings.services);
  }
  get hasLlm(): boolean {
    return this.settings.useApiKey ? !!this.apiKey : this.auth.signedIn;
  }

  async init(): Promise<void> {
    try {
      const [s, l, f] = await Promise.all([files.read('settings'), files.read('library'), files.read('films')]);
      if (s) this.settings = settingsFromJson(s);
      if (l) this.lib.replaceWith(Library.fromJson(l));
      if (f) this.films.load(f);
      await this.auth.load();
      this.apiKey = (await secrets.read(API_KEY)) ?? undefined;
    } catch {}
    this.rec.sv = this.services;
    this.ready = true;
    this.notify();
    void this.syncLetterboxd();
    if (this.hasLlm) void this.loadModels();
  }

  /** Something changed: repaint and persist soon. */
  changed(filmsToo = false): void {
    this.notify();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      files.write('library', this.lib.toJson()).catch(() => {});
      files.write('settings', this.settings).catch(() => {});
    }, 600);
    if (filmsToo) this.saveFilms();
  }

  /** Extra film ids that must survive cache pruning (the current session's picks). */
  pinned: () => Iterable<number> = () => [];

  saveFilms(): void {
    clearTimeout(this.filmTimer);
    this.filmTimer = setTimeout(() => {
      this.films.prune(new Set([...this.lib.entries.keys(), ...this.pinned()]));
      files.write('films', this.films.toJson()).catch(() => {});
    }, 3000);
  }

  /** Only for moving the single saved session of older versions into the search history. */
  readSession = () => files.read('session');
  removeSession = () => files.remove('session');

  readSearches = () => files.read('searches');
  writeSearches(j: unknown | undefined): void {
    if (j === undefined) files.remove('searches');
    else files.write('searches', j).catch(() => {});
  }

  // ------------------------------------------------------------ LLM access

  private async token(): Promise<string> {
    if (this.settings.useApiKey) {
      if (!this.apiKey) throw new LlmError('signed_out', 'no key');
      return this.apiKey;
    }
    try {
      return await this.auth.accessToken();
    } catch (e) {
      if (e instanceof AuthError) {
        if (e.code === 'session_expired') this.notify();
        throw new LlmError(e.code === 'network' || e.code === 'refresh' ? 'network' : 'signed_out', e.message);
      }
      throw e;
    }
  }

  async signIn(): Promise<void> {
    // Coming back from the browser without having finished counts as
    // cancelling. A callback that is already in wins; cancelling then does nothing.
    let left = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = NativeAppState.addEventListener('change', (state) => {
      clearTimeout(timer);
      if (state !== 'active') left = true;
      else if (left) timer = setTimeout(() => this.auth.cancelSignIn(), 4000);
    });
    const done = this.auth.signIn({ returnUrl: AUTH_RETURN_URL });
    this.notify();
    try {
      await done;
      this.settings.useApiKey = false;
      void this.loadModels();
    } finally {
      clearTimeout(timer);
      sub.remove();
      this.changed();
    }
  }

  /** Returns false when ChatGPT could not confirm the revocation. */
  async signOut(): Promise<boolean> {
    const ok = await this.auth.signOut();
    this.models = [];
    this.changed();
    return ok;
  }

  /** Stores (or with undefined removes) an OpenAI API key; verifies it first. */
  async setApiKey(key: string | undefined): Promise<void> {
    if (key === undefined) {
      this.apiKey = undefined;
      await secrets.write(API_KEY, null);
      this.settings.useApiKey = false;
      this.models = [];
      this.changed();
      if (this.hasLlm) void this.loadModels();
      return;
    }
    const list = await new Llm(async () => key).models(); // throws when the key is bad
    this.apiKey = key;
    await secrets.write(API_KEY, key);
    this.settings.useApiKey = true;
    this.settings.model = undefined;
    this.models = list;
    this.changed();
  }

  async loadModels(): Promise<void> {
    try {
      this.models = await this.llm.models();
      if (this.settings.model && !this.models.some((m) => m.slug === this.settings.model)) this.settings.model = undefined;
      this.notify();
    } catch {}
  }

  /** The model to use: the user's choice, else the account's first listed. */
  async model(): Promise<string> {
    if (this.settings.model) return this.settings.model;
    if (!this.models.length) this.models = await this.llm.models();
    if (!this.models.length) throw new LlmError('model_not_found', 'no models');
    return this.models[0].slug;
  }

  // ------------------------------------------------------------ library

  film = (id: number): Film | undefined => this.films.get(id);

  rate(id: number, stars: number | undefined): void {
    this.lib.rate(id, stars);
    this.changed();
  }
  setWatched(id: number, v: boolean): void {
    this.lib.setWatched(id, v);
    this.changed();
  }
  setWatchlist(id: number, v: boolean): void {
    this.lib.setWatchlist(id, v);
    this.changed();
  }
  setNotInterested(id: number, v: boolean): void {
    this.lib.setNotInterested(id, v);
    this.changed();
  }

  /** Makes sure a film has full details (needed before it enters the library). */
  async ensureFilm(id: number): Promise<Film | undefined> {
    try {
      const f = await this.tmdb.details(id, this.settings.region);
      this.saveFilms();
      return f;
    } catch {
      return this.films.get(id);
    }
  }

  // ------------------------------------------------------------ Letterboxd

  /** Imports a parsed export. Without `watchlist`, films that are only on the Letterboxd watchlist stay out. */
  async importExport(ex: LbExport, opts: { watchlist: boolean }): Promise<void> {
    if (!opts.watchlist) dropWatchlistOnly(ex);
    const posters: string[] = [];
    const progress = (label: string, done: number, total: number) => {
      this.importing = { label, done, total, posters: [...posters] };
      this.notify();
    };
    try {
      progress('Matching', 0, ex.films.size);
      // Recent diary entries come with exact TMDB ids in the RSS feed.
      const user = ex.username ?? this.lib.lbUsername;
      if (user) {
        try {
          seedMatches(ex, await fetchRss(user));
        } catch {}
      }
      await matchExport(ex, this.tmdb, (done, total, f) => {
        if (f?.poster && posters.length < 60) posters.push(f.poster);
        if (done % 4 === 0 || done === total) progress('Matching', done, total);
      });
      applyExport(this.lib, ex);
      this.rec.sv = this.services;
      await this.rec.ensureLibraryDetails((d, t) => {
        if (d % 6 === 0 || d === t) progress('Reading your taste', d, t);
      });
    } finally {
      this.importing = undefined;
      this.changed(true);
    }
    void this.syncLetterboxd();
  }

  setUsername(name: string | undefined): void {
    this.lib.lbUsername = name === undefined ? undefined : cleanUsername(name);
    this.syncError = undefined;
    this.changed();
    if (this.lib.lbUsername) void this.syncLetterboxd();
  }

  /**
   * Checks the Letterboxd RSS feed and merges anything new. Runs on every
   * app start, whenever the app returns to the front, and on pull-to-refresh.
   */
  async syncLetterboxd(): Promise<void> {
    const user = this.lib.lbUsername;
    if (!user || this.syncing) return;
    this.syncing = true;
    this.syncError = undefined;
    this.notify();
    try {
      const res = applyRss(this.lib, await fetchRss(user));
      this.lastSyncAdded = res.added + res.updated;
      if (res.ids.length) await this.tmdb.detailsAll(res.ids, this.settings.region, { providerMaxAgeDays: 36500 });
      await this.rec.ensureLibraryDetails();
    } catch (e) {
      this.syncError = e instanceof LbNotFound ? `No Letterboxd profile named "${user}".` : 'Letterboxd could not be reached.';
    } finally {
      this.syncing = false;
      this.changed(true);
    }
  }

  // ------------------------------------------------------------ region

  providerCatalog = (region = this.settings.region): Promise<Prov[]> => this.tmdb.providerCatalog(region);

  /** A new country: keeps the picked services that are offered there too. */
  setRegion(region: string): void {
    if (region === this.settings.region) return;
    this.settings.region = region;
    this.rec.sv = this.services;
    this.changed();
    void this.providerCatalog(region)
      .then((c) => {
        if (this.settings.region !== region) return;
        const offered = new Set(c.map((p) => p.id));
        this.setServices(this.settings.services.filter((x) => offered.has(x.id)));
      })
      .catch(() => {});
  }

  toggleService(p: Prov): void {
    const on = this.settings.services.some((x) => x.id === p.id);
    this.setServices(on ? this.settings.services.filter((x) => x.id !== p.id) : [...this.settings.services, { id: p.id, name: p.name, logo: p.logo }]);
  }

  setServices(list: Service[]): void {
    this.settings.services = list;
    this.settings.request.streamingOnly = list.length > 0;
    this.rec.sv = this.services;
    this.changed();
  }

  // ------------------------------------------------------------ data

  /** Backup of library and settings. Contains no credentials. */
  backupJson(): string {
    return JSON.stringify({ app: 'what-to-watch', version: 1, exportedAt: new Date().toISOString(), library: this.lib.toJson(), settings: this.settings });
  }

  async restore(text: string): Promise<void> {
    let j: any;
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error('Not a backup file.');
    }
    if (j?.app !== 'what-to-watch' || typeof j.library !== 'object') throw new Error('Not a WhatToWatch backup.');
    this.lib.replaceWith(Library.fromJson(j.library));
    if (j.settings) {
      const keep = this.settings;
      this.settings = { ...settingsFromJson(j.settings), onboarded: true, useApiKey: keep.useApiKey, welcomeSeen: keep.welcomeSeen };
    }
    this.rec.sv = this.services;
    this.changed();
    await this.rec.ensureLibraryDetails();
    this.changed(true);
    void this.syncLetterboxd();
  }

  async deleteAll(): Promise<void> {
    clearTimeout(this.saveTimer);
    clearTimeout(this.filmTimer);
    try {
      await this.auth.signOut();
    } catch {}
    await this.auth.wipe().catch(() => {});
    await secrets.write(API_KEY, null).catch(() => {});
    this.apiKey = undefined;
    this.models = [];
    this.lib.replaceWith(new Library());
    this.films.films.clear();
    this.settings = newSettings();
    this.rec.sv = this.services;
    for (const n of ['library', 'settings', 'films', 'session', 'searches']) files.remove(n);
    this.notify();
  }
}

export const app = new AppState();
