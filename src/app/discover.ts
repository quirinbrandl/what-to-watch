import { Pick, Progress, Session, Stage } from '../core/engine/recommender';
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
  error?: string;
  llmError?: LlmError;
  generation = 0; // bumped for every new session (resets the feed)
  private run = 0;

  async restore(): Promise<void> {
    try {
      const j = await app.readSession();
      if (j && !this.session && !this.running) {
        const s = Session.fromJson(j, app.films);
        if (s.picks.length) this.session = s;
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
      if (run === this.run) this.session = s;
    });
  }

  async more(): Promise<void> {
    const s = this.session;
    if (!s || this.running) return;
    this.loadingMore = true;
    await this.go((run) => app.rec.more(s, (p) => this.progress(run, p)).then(() => {}));
    this.loadingMore = false;
    this.notify();
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
    this.stage = p.stage;
    this.pool = p.pool;
    for (const f of p.posters) if (f.poster && this.scouted.length < 150) this.scouted.push(f.poster);
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
        this.notify();
        this.persist();
        app.saveFilms();
      }
    }
  }

  private persist(): void {
    app.writeSession(this.session?.toJson());
  }
}

export const discover = new Discover();

// The films of the current session must not be pruned from the film cache.
app.pinned = () => {
  const s = discover.session;
  return s ? [...s.picks, ...s.reserve].flatMap((p) => [p.film.id, ...p.anchors.map((a) => a.id)]) : [];
};
