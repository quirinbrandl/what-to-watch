import { Pick, Progress, STAGES, Session, Stage } from '../core/engine/recommender';
import { pickScenes } from '../core/engine/scenes';
import { Services, copyRequest } from '../core/engine/request';
import { SavedSearch, addSearch, historyFromJson, historyToJson } from '../core/history';
import { LlmError } from '../core/llm';
import { Film } from '../core/models';
import { TmdbError } from '../core/tmdb';

import { Observable, app, servicesOf } from './store';

/** Drives discovery for the UI: the search on screen, and the searches kept on the device. */
export class Discover extends Observable {
  session?: Session;
  searches: SavedSearch[] = []; // newest first
  currentId?: string; // the saved search that `session` belongs to
  running = false;
  loadingMore = false;
  stage?: Stage;
  pool = 0;
  scouted: string[] = []; // poster paths for the wait screen
  finalists: Film[] = []; // the films the judge is looking at
  verdicts = new Map<number, number>(); // film id -> the judge's predicted rating, as it comes in
  reveal?: Film[]; // the chosen films, shown on the wait screen for a moment before the feed opens
  private stageAt: number[] = []; // when each stage of this run began
  private choosing = new Set<number>(); // films whose background scene is being chosen right now
  private verdictAt = [0, 0]; // when the judge's first and latest verdict came in
  private verdictFrom = 0; // how far through the judging stage the bar was at the first verdict
  error?: string;
  llmError?: LlmError;
  generation = 0; // bumped for every new session (resets the feed)
  private run = 0;

  /** The saved search on screen. */
  get current(): SavedSearch | undefined {
    return this.searches.find((e) => e.id === this.currentId);
  }

  /** The streaming services the search on screen was limited to (they get a ring on the cards). */
  get services(): Services {
    const c = this.current;
    return c ? servicesOf(c.region, c.services) : app.services;
  }

  async restore(): Promise<void> {
    try {
      let { list, current } = historyFromJson(await app.readSearches(), app.films);
      let moved = false;
      if (!list.length) {
        // Versions before the search history kept only the last session.
        const old = await app.readSession();
        if (old) {
          const s = Session.fromJson(old, app.films);
          if (s.picks.length) {
            const e: SavedSearch = {
              id: newId(),
              at: Date.now(),
              region: app.settings.region,
              services: s.request.streamingOnly ? [...app.settings.services] : [],
              session: s,
            };
            list = [e];
            current = e.id;
            moved = true;
          }
        }
      }
      // A search that finished while this was loading stays on top.
      this.searches = [...this.searches, ...list.filter((e) => !this.searches.some((x) => x.id === e.id))];
      if (!this.session && !this.running && current) this.show(current);
      if (moved) {
        this.persist();
        app.removeSession();
      }
    } catch {}
    this.notify();
  }

  /** Opens a saved search: its films are back on screen at once, no new search needed. */
  open(id: string): void {
    if (!this.searches.some((e) => e.id === id)) return;
    if (this.running) this.cancel();
    this.error = undefined;
    this.llmError = undefined;
    this.show(id);
    this.generation++;
    this.persist();
    this.notify();
  }

  /** Deletes a saved search. */
  forget(id: string): void {
    this.searches = this.searches.filter((e) => e.id !== id);
    if (this.currentId === id) {
      this.currentId = undefined;
      if (!this.running) this.session = undefined;
    }
    this.persist();
    this.notify();
  }

  private show(id: string): void {
    const e = this.searches.find((x) => x.id === id)!;
    this.currentId = id;
    this.session = e.session;
    void this.scenes();
    // A saved pick must show complete details; refresh any that the film
    // cache only holds in list form.
    for (const p of e.session.picks) {
      if (!p.film.full) {
        void app.ensureFilm(p.film.id).then((f) => {
          if (f?.full) {
            p.film = f;
            this.notify();
            app.notify();
          }
        });
      }
    }
  }

  /** Starts a fresh session from the current request, or "more like" `seed`. */
  async start(seed?: Film): Promise<void> {
    const r = copyRequest(app.settings.request);
    const region = app.settings.region;
    const services = [...app.settings.services];
    r.streamingOnly = services.length > 0;
    if (seed) {
      r.seedId = seed.id;
      r.prompt = '';
    }
    if (this.running) this.cancel();
    this.session = undefined;
    this.currentId = undefined;
    this.generation++;
    app.rec.sv = servicesOf(region, services);
    await this.go(async (run) => {
      const s = await app.rec.start(r, (p) => this.progress(run, p));
      if (run !== this.run) return;
      this.learnTimings();
      if (s.picks.length) {
        // Let the wait screen land on the chosen films before the feed takes over.
        this.reveal = s.picks.map((p) => p.film);
        this.notify();
        void this.scenes(this.reveal);
        await sleep(REVEAL_MS);
        if (run !== this.run) return;
      }
      this.session = s;
      if (s.picks.length) {
        const e: SavedSearch = {
          id: newId(),
          at: Date.now(),
          region,
          services,
          seedTitle: seed?.title,
          session: s,
        };
        this.searches = addSearch(this.searches, e);
        this.currentId = e.id;
      }
    });
  }

  async more(): Promise<void> {
    const s = this.session;
    if (!s || this.running) return;
    // "More" keeps to the streaming services of the search it continues.
    const c = this.current;
    app.rec.sv = c ? servicesOf(c.region, c.services) : app.services;
    this.loadingMore = true;
    await this.go((run) => app.rec.more(s, (p) => this.progress(run, p)).then(() => {}));
    this.loadingMore = false;
    this.notify();
    void this.scenes();
  }

  cancel(): void {
    this.run++;
    this.running = false;
    this.reveal = undefined;
    this.loadingMore = false;
    this.stage = undefined;
    this.notify();
  }

  remove(p: Pick): void {
    const s = this.session;
    if (!s) return;
    s.picks = s.picks.filter((x) => x !== p);
    this.notify();
    this.persist();
  }

  /** Forgets everything: used by "Delete everything" and when a backup replaces the library. */
  clear(): void {
    this.session = undefined;
    this.searches = [];
    this.currentId = undefined;
    app.writeSearches(undefined);
    this.notify();
  }

  private progress(run: number, p: Progress): void {
    if (run !== this.run) return;
    const i = STAGES.indexOf(p.stage);
    if (this.stage !== undefined && i < STAGES.indexOf(this.stage)) {
      // A second round started (the first found too little): the wait begins again.
      this.stageAt = [];
      this.finalists = [];
      this.verdicts = new Map();
    }
    this.stageAt[i] ??= Date.now();
    this.stage = p.stage;
    this.pool = p.pool;
    for (const f of p.posters) if (f.poster && this.scouted.length < 150) this.scouted.push(f.poster);
    if (p.finalists) this.finalists = p.finalists;
    if (p.verdict) {
      const now = Date.now();
      if (!this.verdicts.size) {
        this.verdictAt = [now, now];
        this.verdictFrom = timeShare((now - (this.stageAt[i] ?? now)) / 1000 / (app.settings.stageSecs ?? STAGE_SECS)[i]);
      } else this.verdictAt[1] = now;
      this.verdicts.set(p.verdict.id, p.verdict.r);
    }
    this.notify();
  }

  private async go(job: (run: number) => Promise<void>): Promise<void> {
    if (this.running) return;
    const run = ++this.run;
    this.running = true;
    this.error = undefined;
    this.llmError = undefined;
    this.stage = 'taste';
    this.pool = 0;
    this.scouted = [];
    this.finalists = [];
    this.verdicts = new Map();
    this.reveal = undefined;
    this.stageAt = [Date.now()];
    this.notify();
    try {
      app.rec.cfg.model = await app.model();
      await job(run);
    } catch (e) {
      if (run === this.run) {
        if (e instanceof LlmError) {
          this.llmError = e;
          this.error = e.friendly;
        } else {
          this.error = e instanceof TmdbError ? 'Film data could not be loaded.' : 'Something went wrong.';
        }
      }
    } finally {
      if (run === this.run) {
        this.running = false;
        this.stage = undefined;
        this.reveal = undefined;
        this.notify();
        this.persist();
        app.saveFilms();
      }
    }
  }

  /**
   * How far the current search is, for the progress bar. Time-based, from how
   * long each stage took in recent searches; once the judge starts writing its
   * verdicts, their count is the clock. It slows down instead of finishing
   * early when a stage runs long.
   */
  progressNow(now = Date.now()): {
    fraction: number;
    secondsLeft: number;
    late: boolean;
  } {
    if (this.reveal) return { fraction: 1, secondsLeft: 0, late: false };
    const b = app.settings.stageSecs ?? STAGE_SECS;
    const i = Math.max(0, STAGES.indexOf(this.stage ?? 'taste'));
    const total = b.reduce((a, x) => a + x, 0);
    const before = b.slice(0, i).reduce((a, x) => a + x, 0);
    const after = b.slice(i + 1).reduce((a, x) => a + x, 0);
    const el = Math.max(0, (now - (this.stageAt[i] ?? now)) / 1000);
    let within = timeShare(el / b[i]);
    let left = Math.max(b[i] - el, 3) + after;
    let late = el > b[i] * 1.25; // well past the usual time for this stage: no point in naming a number
    const n = this.verdicts.size;
    const all = this.finalists.length;
    if (this.stage === 'judging' && n > 0 && all > 0) {
      within = this.verdictFrom + (0.99 - this.verdictFrom) * Math.min(1, n / all);
      const each = n > 1 ? (this.verdictAt[1] - this.verdictAt[0]) / 1000 / (n - 1) : 1;
      left = Math.max(1, (all - n) * each - (now - this.verdictAt[1]) / 1000);
      late = false;
    }
    return {
      fraction: Math.min(0.99, (before + within * b[i]) / total),
      secondsLeft: left,
      late,
    };
  }

  /** Remembers how long the stages took, so the next progress bar is closer to the truth. */
  private learnTimings(): void {
    const at = this.stageAt;
    if (STAGES.some((_, i) => at[i] === undefined)) return;
    const took = STAGES.map((_, i) => Math.min(300, Math.max(0.5, ((at[i + 1] ?? Date.now()) - at[i]) / 1000)));
    const old = app.settings.stageSecs ?? STAGE_SECS;
    app.settings.stageSecs = took.map((t, i) => Math.round((old[i] * 0.5 + t * 0.5) * 10) / 10);
    app.changed();
  }

  /** Picks a real scene as the background for each film on show. Runs after the films are already visible. */
  private async scenes(of?: Film[]): Promise<void> {
    if (!app.hasLlm) return;
    const films = (of ?? this.session?.picks.map((p) => p.film) ?? []).filter((f) => f.scene === undefined && !this.choosing.has(f.id));
    if (!films.length) return;
    for (const f of films) this.choosing.add(f.id);
    try {
      if ((await pickScenes(app.tmdb, app.llm, await app.model(), films, () => this.notify())) > 0) app.saveFilms();
    } catch {
    } finally {
      for (const f of films) this.choosing.delete(f.id);
    }
  }

  private persist(): void {
    app.writeSearches(historyToJson(this.searches, this.currentId));
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const newId = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
/** How long the wait screen shows the chosen films before the feed opens. */
const REVEAL_MS = 1500;
/** Typical stage lengths in seconds before any search has been timed on this device. */
const STAGE_SECS = [1, 45, 3, 55];
/** The share of a stage that counts as done after `f` times its usual length: steady up to 80 %, then ever slower, never full. */
const timeShare = (f: number) => (f < 0.8 ? f : 0.8 + 0.19 * (1 - Math.exp(-(f - 0.8) * 2.5)));

export const discover = new Discover();

// The films of the saved searches must not be pruned from the film cache.
// Films held in reserve for "more" are kept for the three newest searches.
app.pinned = () => {
  const ids: number[] = [];
  const add = (s: Session, reserve: boolean) => {
    for (const p of reserve ? [...s.picks, ...s.reserve] : s.picks) ids.push(p.film.id, ...p.anchors.map((a) => a.id));
  };
  if (discover.session) add(discover.session, true);
  discover.searches.forEach((e, i) => add(e.session, i < 3));
  return ids;
};
