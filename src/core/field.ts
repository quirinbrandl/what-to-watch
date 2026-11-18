/**
 * The wait screen's fly-through, without the drawing. Hundreds of posters drift
 * towards the viewer off a far wall of tiny posters (the user's own films). It
 * shows the search as it happens:
 *
 * - each film the engine finds comes out of the far wall with a thin accent edge;
 * - when the rating starts, every film being rated gathers in a loose cloud in the
 *   middle; as its predicted rating comes in it moves closer the better it is, and
 *   a film predicted below the feed's cutoff drifts back into the wall;
 * - when the search is done the flight stops and the cloud holds until the feed opens.
 *
 * Every function here is a worklet: the screen runs it on the UI thread each frame.
 * The state is one plain object, made and changed only there (and in the tests).
 */

/** Poster size, as a share of the prototype's default: the "large" setting the user chose. */
export const SIZE = 1.3;
export const ZN = 0.6; // nearest depth: a poster closer than this is past the viewer
export const ZF = 6.5; // the far wall
const Z_FRONT = 1.55; // a film predicted at 5 stars
const Z_BACK = 3.6; // a film predicted at the cutoff
const Z_UNRATED = 3.0; // a film whose rating has not come in
const EDGE = 0.55; // how strongly a found film's edge shows

export interface Poster {
  film: string; // poster path of a found film; '' for one of the user's own
  own: number; // which of the user's films, when `film` is ''
  x: number;
  y: number;
  z: number;
  hold: boolean; // in the cloud: moves to (tx, ty, tz) instead of flying
  release: boolean; // leaving the cloud for the wall
  tx: number;
  ty: number;
  tz: number;
  rate: number;
  phase: number;
}

/** What the search has reported so far, as the screen passes it in. */
export interface FieldInput {
  found: string[]; // poster paths of the films found, in order
  finalists: string[]; // poster paths of the films being rated, in the engine's order
  verdicts: [string, number][]; // poster path and predicted rating, in the order they came in
  done: boolean; // the search is over
  miss: number; // a film predicted below this is not in the feed
}

export interface Field {
  W: number;
  H: number;
  F: number; // focal length
  PW: number; // poster width at depth 1
  t: number;
  seed: number;
  ps: Poster[];
  queue: string[]; // found films waiting for the next poster that comes off the wall
  found: number; // how many of input.found have been queued
  verdicts: number; // how many of input.verdicts have been applied
  cloud: Record<string, number>; // poster path -> index in ps
  judgeAt: number; // when the rating started (-1: not yet)
  doneAt: number; // when the search finished (-1: not yet)
}

/** One poster to draw this frame. */
export interface Sprite {
  film: string;
  own: number;
  x: number; // centre
  y: number;
  w: number;
  a: number; // opacity
  edge: number; // opacity of the accent edge
}

export const clamp = (x: number, a = 0, b = 1): number => {
  'worklet';
  return x < a ? a : x > b ? b : x;
};
export const lerp = (a: number, b: number, x: number): number => {
  'worklet';
  return a + (b - a) * x;
};
export const ramp = (t: number, a: number, b: number): number => {
  'worklet';
  return clamp((t - a) / (b - a));
};
const out2 = (x: number): number => {
  'worklet';
  return 1 - (1 - x) * (1 - x);
};

/** mulberry32, kept in the state so a run can be replayed. */
function rnd(f: Field): number {
  'worklet';
  f.seed = (f.seed + 0x6d2b79f5) | 0;
  let t = f.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Puts a poster at depth z where it shows at screen point (sx, sy). */
function at(f: Field, p: Poster, z: number, sx: number, sy: number): void {
  'worklet';
  p.z = z;
  p.x = ((sx - f.W / 2) * z) / f.F;
  p.y = ((sy - f.H * 0.42) * z) / f.F;
}

/** Puts a poster at depth z anywhere on screen, or (plain) where it is in plain view. */
function place(f: Field, p: Poster, z: number, plain: boolean): void {
  'worklet';
  const u = plain ? 0.14 + rnd(f) * 0.72 : rnd(f) * 1.1 - 0.05;
  const v = plain ? 0.14 + rnd(f) * 0.48 : rnd(f) * 1.1 - 0.05;
  at(f, p, z, u * f.W, v * f.H);
}

function poster(f: Field, film: string): Poster {
  'worklet';
  return { film, own: Math.floor(rnd(f) * 1e6), x: 0, y: 0, z: ZF, hold: false, release: false, tx: 0, ty: 0, tz: 0, rate: 1, phase: rnd(f) * 6.28 };
}

export function newField(W: number, H: number, seed = 13): Field {
  'worklet';
  const f: Field = { W, H, F: W * 0.55, PW: 0.46 * SIZE, t: 0, seed, ps: [], queue: [], found: 0, verdicts: 0, cloud: {}, judgeAt: -1, doneAt: -1 };
  const n = Math.round(520 / (SIZE * SIZE));
  for (let i = 0; i < n; i++) {
    const p = poster(f, '');
    place(f, p, ZN + rnd(f) * (ZF - ZN), false);
    f.ps.push(p);
  }
  return f;
}

function project(f: Field, p: Poster): { x: number; y: number; w: number } {
  'worklet';
  const k = f.F / p.z;
  return { x: f.W / 2 + p.x * k, y: f.H * 0.42 + p.y * k, w: f.PW * k };
}

function gone(f: Field, p: Poster): boolean {
  'worklet';
  const q = project(f, p);
  return q.x < -q.w || q.x > f.W + q.w || q.y < -q.w * 1.5 || q.y > f.H + q.w * 1.5;
}

/** How fast the flight goes: speeds up at the start, slows while rating, stops at the end. */
export function speed(f: Field): number {
  'worklet';
  let v = lerp(0.45, 0.85, ramp(f.t, 0, 3));
  if (f.judgeAt >= 0) v = lerp(v, 0.22, out2(ramp(f.t, f.judgeAt, f.judgeAt + 1.8)));
  if (f.doneAt >= 0) v = lerp(v, 0, ramp(f.t, f.doneAt, f.doneAt + 0.4));
  return v;
}

/** A poster that has passed the viewer or left the screen comes off the far wall again: a found film if one is waiting. */
function respawn(f: Field, p: Poster): void {
  'worklet';
  const i = f.ps.indexOf(p);
  if (p.film && f.cloud[p.film] === i) delete f.cloud[p.film];
  p.hold = false;
  p.release = false;
  if (f.queue.length && f.judgeAt < 0) {
    p.film = f.queue.shift()!;
    place(f, p, ZF, true);
  } else {
    p.film = '';
    p.own = Math.floor(rnd(f) * 1e6);
    place(f, p, ZF, false);
  }
}

/** Where a film sits in the cloud: its own spot on a spiral, closer to the viewer the better its rating. */
function aim(f: Field, p: Poster, n: number, count: number, r: number | undefined, miss: number, rate: number): void {
  'worklet';
  const back = r === undefined ? 0.7 : clamp((5 - r) / (5 - miss));
  const tz = r === undefined ? Z_UNRATED : lerp(Z_FRONT, Z_BACK, back);
  const a = n * 2.39996;
  // The spots stay where they are: many films get 4.5 or 5 stars, and pulling them all to the middle piles them up.
  const rr = Math.sqrt((n + 0.5) / Math.max(1, count)) * lerp(0.85, 1, back);
  const sx = f.W / 2 + Math.cos(a) * rr * f.W * 0.46;
  const sy = f.H * 0.37 + Math.sin(a) * rr * f.H * 0.28;
  const q = { ...p };
  at(f, q, tz, sx, sy);
  p.tx = q.x;
  p.ty = q.y;
  p.tz = tz;
  p.rate = rate;
}

/** A film joins the cloud: the poster of it that is flying in view, or a new one out of the wall. */
function join(f: Field, film: string, n: number, count: number, r: number | undefined, miss: number): void {
  'worklet';
  let i = f.ps.findIndex((q) => q.film === film && !q.hold && q.z > 1 && !gone(f, q));
  if (i < 0) {
    const p = poster(f, film);
    place(f, p, ZF, true);
    f.ps.push(p);
    i = f.ps.length - 1;
  }
  const p = f.ps[i];
  p.hold = true;
  p.release = false;
  f.cloud[film] = i;
  aim(f, p, n, count, r, miss, 0.8);
}

/** Not in the feed: back into the wall, straight behind where it is. */
function release(p: Poster): void {
  'worklet';
  p.release = true;
  const k = (ZF + 0.6) / p.z;
  p.tx = p.x * k;
  p.ty = p.y * k;
  p.tz = ZF + 0.6;
  p.rate = 0.75;
}

/** Moves everything on by dt seconds, taking in what the search reported. */
export function step(f: Field, input: FieldInput, dt: number): void {
  'worklet';
  f.t += dt;
  // The engine started over: the cloud goes back into the wall.
  if (f.judgeAt >= 0 && !input.finalists.length) {
    for (const k of Object.keys(f.cloud)) release(f.ps[f.cloud[k]]);
    f.cloud = {};
    f.judgeAt = -1;
    f.verdicts = 0;
  }
  if (input.verdicts.length < f.verdicts) f.verdicts = 0;
  for (; f.found < input.found.length; f.found++) f.queue.push(input.found[f.found]);
  const count = input.finalists.length;
  if (f.judgeAt < 0 && count) {
    f.judgeAt = f.t;
    f.queue = [];
    const rated: Record<string, number> = {};
    for (const [film, r] of input.verdicts) rated[film] = r;
    input.finalists.forEach((film, n) => {
      if (rated[film] === undefined || rated[film] >= input.miss) join(f, film, n, count, rated[film], input.miss);
    });
    f.verdicts = input.verdicts.length;
  }
  for (; f.verdicts < input.verdicts.length; f.verdicts++) {
    const [film, r] = input.verdicts[f.verdicts];
    const n = input.finalists.indexOf(film);
    if (n < 0) continue;
    const i = f.cloud[film];
    if (r < input.miss) {
      if (i !== undefined) {
        release(f.ps[i]);
        delete f.cloud[film];
      }
    } else if (i !== undefined) aim(f, f.ps[i], n, count, r, input.miss, 1.1);
    else join(f, film, n, count, r, input.miss);
  }
  if (input.done && f.doneAt < 0) f.doneAt = f.t;

  const v = speed(f);
  for (const p of f.ps) {
    if (p.hold || p.release) {
      const k = 1 - Math.exp(-dt * p.rate);
      p.x += (p.tx - p.x) * k;
      p.y += (p.ty - p.y) * k;
      p.z += (p.tz - p.z) * k;
      if (p.release && p.z > ZF - 0.25) respawn(f, p);
      continue;
    }
    p.z -= v * dt;
    if (p.z < ZN || gone(f, p)) respawn(f, p);
  }
}

/** The posters to draw this frame, back to front. */
export function sprites(f: Field): Sprite[] {
  'worklet';
  const out: Sprite[] = [];
  const intro = ramp(f.t, 0, 0.8);
  // Once the search is done the flight steps back a little; the cloud stays as it is.
  const dim = f.doneAt >= 0 ? 1 - 0.5 * ramp(f.t, f.doneAt, f.doneAt + 0.5) : 1;
  // While the cloud hovers in front, flying posters that come too close dissolve before they cover it.
  const clear = f.judgeAt >= 0 ? ramp(f.t, f.judgeAt, f.judgeAt + 1.5) : 0;
  const order = f.ps.map((p, i) => i).sort((a, b) => f.ps[b].z - f.ps[a].z);
  for (const i of order) {
    const p = f.ps[i];
    const q = project(f, p);
    let { x, y } = q;
    const w = q.w;
    const h = w * 1.5;
    if (p.hold) {
      x += Math.sin(f.t * 0.7 + p.phase) * 3;
      y += Math.cos(f.t * 0.55 + p.phase) * 3;
    }
    if (x + w < 0 || x - w > f.W || y + h < 0 || y - h > f.H) continue;
    const near = p.hold ? ZN + 0.45 : lerp(ZN + 0.45, 2.3, clear);
    const fog = ramp(p.z, ZN, near) * (1 - ramp(p.z, ZF - 1.4, ZF));
    const a = fog * intro * (p.hold && !p.release ? 1 : dim);
    if (a <= 0.01) continue;
    out.push({ film: p.film, own: p.own, x, y, w, a, edge: p.film ? EDGE * a : 0 });
  }
  return out;
}

/** The far wall: how strongly it shows and how far it has come closer. */
export function wallLook(f: Field): { a: number; scale: number } {
  'worklet';
  const dim = f.doneAt >= 0 ? 1 - 0.5 * ramp(f.t, f.doneAt, f.doneAt + 0.5) : 1;
  return { a: ramp(f.t, 0, 0.8) * 0.4 * dim, scale: 1 + 0.003 * Math.min(f.t, 60) };
}
