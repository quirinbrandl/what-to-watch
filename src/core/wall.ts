import { Film } from './models';

/**
 * The poster wall of the wait screen, without the drawing: which poster each
 * tile holds and whether it is lit. Kept apart from the UI so it can be tested.
 */

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

const KEEP = 8; // how many of the judged films stay lit

export interface Tile {
  poster?: string;
  state: 'in' | 'out' | 'keep';
  rev: number; // goes up when the poster is swapped
  pulse: number; // goes up when the tile should light up for a moment
  wait: number; // ms to hold back the next change of state, so tiles don't all move at once
}

/**
 * What the wall shows, driven by what the engine really does:
 * it starts with the user's own films, each newly found candidate takes a
 * tile, the finalists take over when the judge starts, tiles go dark as the
 * judge rates their film below the best eight, and the chosen films light up
 * at the end.
 */
export class Wall {
  tiles: Tile[];
  private queue: string[] = [];
  private known = new Set<string>();
  private seen: string[] = []; // every candidate shown so far
  private fed = 0;
  private cursor = 0;
  private again = 0;
  private beat = 0;
  private stride: number;
  private phase: 'gather' | 'final' | 'reveal' = 'gather';

  constructor(n: number, private visible: number[], mine: string[]) {
    this.tiles = [...Array(n)].map((_, i) => ({ poster: mine[i], state: 'in' as const, rev: 0, pulse: 0, wait: 0 }));
    for (const p of mine.slice(0, n)) this.known.add(p);
    // A step that shares no factor with the number of tiles: every tile gets its turn and neighbours don't change together.
    this.stride = [11, 13, 7, 5, 3, 1].find((s) => gcd(s, n) === 1)!;
  }

  /** Takes in the engine's latest state. */
  sync(scouted: string[], finalists: Film[], verdicts: Map<number, number>, reveal?: Film[]): void {
    for (; this.fed < scouted.length; this.fed++) {
      const p = scouted[this.fed];
      if (!this.known.has(p)) {
        this.known.add(p);
        this.queue.push(p);
      }
    }
    if (reveal) this.showPicks(reveal);
    else if (finalists.length) {
      if (this.phase === 'gather') this.showFinalists(finalists);
      this.dim(finalists, verdicts);
    }
  }

  /**
   * One beat of the clock, so the wall never stands still: the next waiting
   * candidate takes a tile; with none waiting, an earlier one comes back; and
   * while the judge thinks, one finalist after another lights up.
   */
  step(): void {
    this.beat++;
    if (this.phase === 'gather') {
      if (this.queue.length) {
        for (let k = this.queue.length > 30 ? 2 : 1; k > 0 && this.queue.length; k--) {
          const p = this.queue.shift()!;
          this.seen.push(p);
          this.put(this.next(), p);
        }
      } else if (this.beat % 2 === 0 && this.seen.length > this.tiles.length) {
        const on = new Set(this.tiles.map((t) => t.poster));
        for (let tries = this.seen.length; tries > 0; tries--) {
          const p = this.seen[this.again++ % this.seen.length];
          if (!on.has(p)) {
            this.put(this.next(), p);
            break;
          }
        }
      }
    } else if (this.phase === 'final') {
      const lit = this.tiles.filter((t) => t.state === 'in' && t.poster);
      if (lit.length) lit[Math.floor(Math.random() * lit.length)].pulse++;
    }
  }

  private next(): number {
    return (this.cursor++ * this.stride) % this.tiles.length;
  }

  private put(i: number, poster: string): void {
    const t = this.tiles[i];
    t.poster = poster;
    t.state = 'in';
    t.wait = 0;
    t.rev++;
  }

  private showFinalists(finalists: Film[]): void {
    this.phase = 'final';
    const want = finalists.map((f) => f.poster).filter((p): p is string => !!p);
    const wanted = new Set(want);
    const have = new Set(this.tiles.map((t) => t.poster));
    const missing = want.filter((p) => !have.has(p));
    // Fill the tiles in plain view first, so the finalists are where the eye is.
    const slots = [...this.visible, ...this.tiles.map((_, i) => i).filter((i) => !this.visible.includes(i))].filter((i) => !wanted.has(this.tiles[i].poster ?? ''));
    let k = 0;
    for (const i of slots) {
      const p = missing.shift();
      if (p) this.put(i, p);
      else {
        // The rest step back one after another.
        this.tiles[i].state = 'out';
        this.tiles[i].wait = 500 + k++ * 110;
      }
    }
  }

  private dim(finalists: Film[], verdicts: Map<number, number>): void {
    const rated = [...verdicts.values()].sort((a, b) => b - a);
    if (rated.length <= KEEP) return;
    const bar = rated[KEEP - 1];
    const rating = new Map(finalists.map((f) => [f.poster, verdicts.get(f.id)]));
    for (const t of this.tiles) {
      const r = t.poster ? rating.get(t.poster) : undefined;
      if (t.state === 'in' && r !== undefined && r < bar) {
        t.state = 'out';
        t.wait = 0;
      }
    }
    // The best so far belong in plain view: one that is not there takes a tile that has gone dark.
    const inView = new Set(this.visible);
    const shown = new Set(this.visible.filter((i) => this.tiles[i].state === 'in').map((i) => this.tiles[i].poster));
    const dark = this.visible.filter((i) => this.tiles[i].state === 'out');
    for (const f of finalists) {
      const r = verdicts.get(f.id);
      if (!f.poster || r === undefined || r < bar || shown.has(f.poster)) continue;
      const to = dark.shift();
      if (to === undefined) break;
      const from = this.tiles.findIndex((t, k) => t.poster === f.poster && !inView.has(k));
      if (from >= 0) this.tiles[from].state = 'out';
      this.put(to, f.poster);
      shown.add(f.poster);
    }
  }

  private showPicks(picks: Film[]): void {
    if (this.phase === 'reveal') return;
    this.phase = 'reveal';
    const inView = new Set(this.visible);
    const kept = new Set<number>();
    const rest: string[] = [];
    for (const p of picks.map((f) => f.poster).filter((x): x is string => !!x)) {
      const i = this.tiles.findIndex((t, k) => t.poster === p && inView.has(k) && !kept.has(k));
      if (i >= 0) kept.add(i);
      else rest.push(p);
    }
    const free = this.visible.filter((i) => !kept.has(i));
    for (const p of rest) {
      const i = free.shift();
      if (i === undefined) break;
      this.put(i, p);
      kept.add(i);
    }
    this.tiles.forEach((t, i) => {
      t.state = kept.has(i) ? 'keep' : 'out';
      t.wait = 0;
    });
  }
}
