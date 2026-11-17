import { Pick, Progress, STAGES, Session, Stage } from '../core/engine/recommender';
import { pickScenes } from '../core/engine/scenes';
import { copyRequest } from '../core/engine/request';
import { LlmError } from '../core/llm';
import { Film } from '../core/models';
import { TmdbError } from '../core/tmdb';

import { Observable, app } from './store';

/** Drives one discovery session for the UI. */
export class Discover extends Observable {
  session?: Session;
  running = false;
  loadingMore = false;
  stage?: Stage;
  pool = 0;
  scouted: string[] = []; // poster paths for the wait screen
  finalists: Film[] = []; // the films the judge is looking at
  verdicts = new Map<number, number>(); // film id -> the judge's predicted rating, as it comes in
  reveal?: Film[]; // the chosen films, shown on the wait screen for a moment before the feed opens
  private stageAt: number[] = []; // when each stage of this run began
  error?: string;
  llmError?: LlmError;
  generation = 0; // bumped for every new session (resets the feed)
  private run = 0;

  async restore(): Promise<void> {
    try {
      const j = await app.readSession();
      if (j && !this.session && !this.running) {
        const s = Session.fromJson(j, app.films);
        if (s.picks.length) {
          this.session = s;
          void this.scenes();
        }
        // A restored pick must show complete details; refresh any that the
        // film cache only holds in list form.
        for (const p of s.picks) {
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
    } catch {}
    this.notify();
  }

  /** Starts a fresh session from the current request, or "more like" `seed`. */
  async start(seed?: Film): Promise<void> {
    const r = copyRequest(app.settings.request);
    if (seed) {
      r.seedId = seed.id;
      r.prompt = '';
    }
    if (this.running) this.cancel();
    this.session = undefined;
    this.generation++;
    await this.go(async (run) => {
      const s = await app.rec.start(r, (p) => this.progress(run, p));
      if (run !== this.run) return;
      this.learnTimings();
      if (s.picks.length) {
        // Let the wait screen land on the chosen films before the feed takes over.
        this.reveal = s.picks.map((p) => p.film);
        this.notify();
        await sleep(REVEAL_MS);
        if (run !== this.run) return;
      }
      this.session = s;
    });
    void this.scenes();
  }

  async more(): Promise<void> {
    const s = this.session;
    if (!s || this.running) return;
    this.loadingMore = true;
    await this.go((run) => app.rec.more(s, (p) => this.progress(run, p)).then(() => {}));
    this.loadingMore = false;
    this.notify();
    void this.scenes();
  }

  cancel(): void {
    this.run++;
    this.running = false;
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

  clear(): void {
    this.session = undefined;
    app.writeSession(undefined);
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
    if (p.verdict) this.verdicts.set(p.verdict.id, p.verdict.r);
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
   * long each stage took in recent searches, and from the judge's real
   * progress once its verdicts arrive. It slows down instead of finishing
   * early when a stage runs long.
   */
  progressNow(now = Date.now()): { fraction: number; secondsLeft: number } {
    if (this.reveal) return { fraction: 1, secondsLeft: 0 };
    const b = app.settings.stageSecs ?? STAGE_SECS;
    const i = Math.max(0, STAGES.indexOf(this.stage ?? 'taste'));
    const total = b.reduce((a, x) => a + x, 0);
    const before = b.slice(0, i).reduce((a, x) => a + x, 0);
    const after = b.slice(i + 1).reduce((a, x) => a + x, 0);
    const el = Math.max(0, (now - (this.stageAt[i] ?? now)) / 1000);
    const f = el / b[i];
    let within = f < 0.8 ? f : 0.8 + 0.19 * (1 - Math.exp(-(f - 0.8) * 2.5));
    let left = Math.max(b[i] - el, 3) + after;
    if (this.stage === 'judging' && this.finalists.length && this.verdicts.size) {
      const judged = Math.min(1, this.verdicts.size / this.finalists.length);
      within = Math.max(within, 0.6 + 0.39 * judged);
      left = Math.min(left, 2 + (1 - judged) * 8);
    }
    return { fraction: Math.min(0.99, (before + within * b[i]) / total), secondsLeft: left };
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
  private async scenes(): Promise<void> {
    const s = this.session;
    if (!s || !app.hasLlm) return;
    const films = s.picks.map((p) => p.film).filter((f) => f.scene === undefined);
    if (!films.length) return;
    try {
      if ((await pickScenes(app.tmdb, app.llm, await app.model(), films)) > 0) {
        this.notify();
        app.saveFilms();
      }
    } catch {}
  }

  private persist(): void {
    app.writeSession(this.session?.toJson());
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** How long the wait screen shows the chosen films before the feed opens. */
const REVEAL_MS = 1500;
/** Typical stage lengths in seconds before any search has been timed on this device. */
const STAGE_SECS = [2, 22, 6, 30];

export const discover = new Discover();

// The films of the current session must not be pruned from the film cache.
app.pinned = () => {
  const s = discover.session;
  return s ? [...s.picks, ...s.reserve].flatMap((p) => [p.film.id, ...p.anchors.map((a) => a.id)]) : [];
};
