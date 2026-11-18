import { Canvas, FilterMode, MipmapMode, PaintStyle, Picture, Skia, type SkImage, TileMode, createPicture } from '@shopify/react-native-skia';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useReducer, useRef, useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useFrameCallback, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { discover } from '../app/discover';
import { app } from '../app/store';
import { MISS, STAGES, Stage } from '../core/engine/recommender';
import { Field, FieldInput, SIZE, newField, sprites, step, wallLook } from '../core/field';
import { Tmdb } from '../core/tmdb';

import { Icon, IconName } from './components';
import { C, display, sans } from './theme';

/* ---- Posters as Skia images ---- */

const OWN = 120; // how many of the user's films fly and make up the far wall
const OWN_PX = [154, 231]; // the user's films are drawn small or pass by quickly
const FOUND_PX = [256, 384]; // found films can come to the front of the cloud

/** The user's films stay decoded between searches. */
const ownCache = new Map<string, SkImage>();

/** Fetches a poster and decodes it here, on the JS thread, at the size it is drawn at: the UI thread only uploads it. */
async function decode(path: string, size: string, [w, h]: number[]): Promise<SkImage | null> {
  const data = await Skia.Data.fromURI(Tmdb.img(path, size));
  const img = Skia.Image.MakeImageFromEncoded(data);
  if (!img) return null;
  const surface = Skia.Surface.Make(w, h);
  if (!surface) return img;
  surface.getCanvas().drawImageRectOptions(img, Skia.XYWHRect(0, 0, img.width(), img.height()), Skia.XYWHRect(0, 0, w, h), FilterMode.Linear, MipmapMode.Linear);
  surface.flush();
  return surface.makeImageSnapshot();
}

/** A few downloads at a time, in the order asked for. */
function useLoader() {
  const queue = useRef<(() => Promise<void>)[]>([]);
  const active = useRef(0);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
      queue.current = [];
    },
    [],
  );
  const pump = () => {
    while (active.current < 6 && queue.current.length) {
      const job = queue.current.shift()!;
      active.current++;
      void job().finally(() => {
        active.current--;
        if (alive.current) pump();
      });
    }
  };
  return (path: string, size: string, px: number[], done: (img: SkImage) => void) => {
    queue.current.push(async () => {
      try {
        const img = await decode(path, size, px);
        if (img && alive.current) done(img);
      } catch {
        // A poster that does not load is left out.
      }
    });
    pump();
  };
}

/** The user's own films, the best-liked first, to fill the flight and the far wall with. */
function ownPosters(n: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p?: string) => {
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  const entries = app.lib.all().sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  for (const e of entries) {
    add(app.film(e.id)?.poster);
    if (out.length >= n * 2) break;
  }
  // Few films of their own yet: any film the app knows will do.
  if (out.length < 30) for (const f of app.films.films.values()) if (out.length < n) add(f.poster);
  // Not the same films every time.
  return out.sort(() => Math.random() - 0.5).slice(0, n);
}

const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** The far wall: tiny posters of the user's films, drawn once on the JS thread. */
function farWall(W: number, H: number, imgs: SkImage[]): SkImage | null {
  const S = 2; // pixels per point: it is drawn faint and small
  const ww = W * 1.2;
  const wh = H * 1.2;
  const surface = Skia.Surface.Make(Math.round(ww * S), Math.round(wh * S));
  if (!surface || !imgs.length) return null;
  const c = surface.getCanvas();
  c.scale(S, S);
  c.drawColor(Skia.Color(C.bg));
  const cols = Math.round(22 / SIZE);
  const tw = ww / cols;
  const th = tw * 1.5;
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row * th < wh; row++) {
      const img = imgs[Math.floor(hash(col * 3.3 + row * 17.9) * imgs.length)];
      c.drawImageRectOptions(img, Skia.XYWHRect(0, 0, img.width(), img.height()), Skia.XYWHRect(col * tw + 0.6, row * th + 0.6, tw - 1.2, th - 1.2), FilterMode.Linear, MipmapMode.Linear);
    }
  }
  surface.flush();
  return surface.makeImageSnapshot();
}

/** What the search has reported so far, for the fly-through. */
function searchInput(): FieldInput {
  const poster = new Map<number, string>();
  for (const f of discover.finalists) if (f.poster) poster.set(f.id, f.poster);
  const verdicts: [string, number][] = [];
  for (const [id, r] of discover.verdicts) {
    const p = poster.get(id);
    if (p) verdicts.push([p, r]);
  }
  return { found: [...discover.scouted], finalists: [...poster.values()], verdicts, done: !!discover.reveal, miss: MISS };
}

/* ---- The fly-through ---- */

/**
 * Hundreds of posters drift towards the viewer off a far wall of the user's films;
 * see core/field.ts for what it shows. Simulated and drawn on the UI thread.
 */
function FlyThrough({ width, height }: { width: number; height: number }) {
  const load = useLoader();
  const input = useSharedValue<FieldInput>(searchInput());
  const own = useSharedValue<(SkImage | null)[]>([]);
  const films = useSharedValue<Record<string, SkImage>>({});
  const wall = useSharedValue<SkImage | null>(null);
  const field = useSharedValue<Field | null>(null);
  const picture = useSharedValue(createPicture(() => {}));
  const seed = useRef(Math.floor(Math.random() * 1e9)).current;
  const paths = useRef<string[]>([]);
  const loaded = useRef<Record<string, SkImage>>({});
  const asked = useRef(new Set<string>());

  // The user's films first; whatever is cached shows at once.
  useEffect(() => {
    const list = ownPosters(OWN);
    paths.current = list;
    let walled = -1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      const imgs = list.map((p) => ownCache.get(p) ?? null);
      own.value = imgs;
      const ready = imgs.filter((i): i is SkImage => !!i);
      // The far wall is redrawn a few times while the posters come in, then once more when all are there.
      if (ready.length && (ready.length === list.length ? walled !== ready.length : ready.length - walled >= 30 || walled < 0)) {
        walled = ready.length;
        wall.value = farWall(width, height, ready);
      }
    };
    const later = () => {
      timer ??= setTimeout(flush, 250);
    };
    flush();
    for (const p of list) {
      if (ownCache.has(p)) continue;
      load(p, 'w185', OWN_PX, (img) => {
        if (ownCache.size > 240) ownCache.delete(ownCache.keys().next().value!);
        ownCache.set(p, img);
        later();
      });
    }
    return () => {
      if (timer) clearTimeout(timer);
    };
    // Made once per wait screen, for its size.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height]);

  // What the search reports, and the posters of the films it finds.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      timer ??= setTimeout(() => {
        timer = undefined;
        films.value = { ...loaded.current };
      }, 200);
    };
    const tick = () => {
      const next = searchInput();
      const cur = input.value;
      if (next.found.length !== cur.found.length || next.finalists.length !== cur.finalists.length || next.verdicts.length !== cur.verdicts.length || next.done !== cur.done) input.value = next;
      for (const p of [...next.finalists, ...next.found]) {
        if (asked.current.has(p)) continue;
        asked.current.add(p);
        load(p, 'w342', FOUND_PX, (img) => {
          loaded.current[p] = img;
          later();
        });
      }
    };
    tick();
    const t = setInterval(tick, 200);
    return () => {
      clearInterval(t);
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFrameCallback((info) => {
    'worklet';
    let f = field.value;
    if (!f || f.W !== width || f.H !== height) {
      field.value = newField(width, height, seed);
      f = field.value!;
    }
    const dt = Math.min(0.05, (info.timeSincePreviousFrame ?? 0) / 1000);
    step(f, input.value, dt);
    const ownImgs = own.value;
    const filmImgs = films.value;
    const far = wall.value;
    const W = width;
    const H = height;
    // Plain rects: no native object per poster per frame.
    const rect = (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h });
    picture.value = createPicture(
      (c) => {
        c.drawColor(Skia.Color(C.bg));
        const paint = Skia.Paint();
        if (far) {
          const look = wallLook(f);
          paint.setAlphaf(look.a);
          const w = W * 1.2 * look.scale;
          const h = H * 1.2 * look.scale;
          c.drawImageRectOptions(far, rect(0, 0, far.width(), far.height()), rect(W / 2 - w / 2, H * 0.42 - h / 2, w, h), FilterMode.Linear, MipmapMode.None, paint);
        }
        const glow = Skia.Paint();
        glow.setShader(Skia.Shader.MakeRadialGradient({ x: W / 2, y: H * 0.42 }, W * 0.7, [Skia.Color('rgba(255,77,46,0.14)'), Skia.Color('rgba(255,77,46,0)')], null, TileMode.Clamp));
        c.drawRect(rect(0, 0, W, H), glow);
        const edge = Skia.Paint();
        edge.setStyle(PaintStyle.Stroke);
        const accent = Skia.Color(C.accent);
        const n = ownImgs.length;
        for (const s of sprites(f)) {
          const img = s.film ? filmImgs[s.film] : n ? ownImgs[s.own % n] : null;
          if (!img) continue;
          const h = s.w * 1.5;
          paint.setAlphaf(s.a);
          c.drawImageRectOptions(img, rect(0, 0, img.width(), img.height()), rect(s.x - s.w / 2, s.y - h / 2, s.w, h), FilterMode.Linear, MipmapMode.Linear, paint);
          if (s.edge > 0.01) {
            // A thin accent frame with a soft glow.
            edge.setColor(accent);
            edge.setAlphaf(s.edge * 0.35);
            edge.setStrokeWidth(6);
            c.drawRect(rect(s.x - s.w / 2 - 1, s.y - h / 2 - 1, s.w + 2, h + 2), edge);
            edge.setAlphaf(s.edge);
            edge.setStrokeWidth(1.8);
            c.drawRect(rect(s.x - s.w / 2, s.y - h / 2, s.w, h), edge);
          }
        }
        const r = Math.hypot(W, H) / 2;
        const shade = Skia.Paint();
        shade.setShader(Skia.Shader.MakeRadialGradient({ x: W / 2, y: H / 2 }, r, [Skia.Color('rgba(0,0,0,0)'), Skia.Color('rgba(0,0,0,0.5)')], [0.4, 1], TileMode.Clamp));
        c.drawRect(rect(0, 0, W, H), shade);
      },
      { width: W, height: H },
    );
  });

  return (
    <Canvas style={StyleSheet.absoluteFill}>
      <Picture picture={picture} />
    </Canvas>
  );
}

/* ---- The wait screen ---- */

const STEPS: Record<Stage, [IconName, string]> = {
  taste: ['finger-print', 'Reading your taste'],
  scouting: ['compass-outline', 'Scouting films'],
  checking: ['checkmark-done-outline', 'Checking the facts'],
  judging: ['sparkles', 'Choosing for you'],
};

/**
 * The wait: posters fly at the viewer and show the search as it happens,
 * with the stage, a time estimate and a progress bar below.
 */
export function Scouting({ compact = false }: { compact?: boolean }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [height, setHeight] = useState(0);
  const [, redraw] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    const t = setInterval(redraw, 360);
    return () => clearInterval(t);
  }, []);

  const stage = discover.stage ?? 'taste';
  const at = STAGES.indexOf(stage);
  const done = !!discover.reveal;
  const { fraction, secondsLeft, late } = discover.progressNow();
  const bar = useSharedValue(0);
  useEffect(() => {
    bar.value = withTiming(fraction, { duration: 420, easing: Easing.linear });
  }, [fraction, bar]);
  const barStyle = useAnimatedStyle(() => ({ width: `${bar.value * 100}%` }));

  const rated = app.lib.rated.length;
  const finalists = discover.finalists.length;
  const detail: Record<Stage, string> = {
    taste: rated > 0 ? `Your ${rated} ratings` : 'Getting started',
    scouting: discover.pool > 0 ? `${discover.pool} candidates so far` : 'Looking for films you have not seen',
    checking: 'Year, length, genre and streaming',
    judging: finalists > 0 ? (rated > 0 ? `Predicting your rating for ${finalists} films` : `Putting ${finalists} films in order`) : 'Putting the films in order',
  };
  const title = done ? 'Your picks' : STEPS[stage][1];
  const eta = late ? 'taking a little longer' : secondsLeft >= 50 ? `about ${Math.max(1, Math.round(secondsLeft / 60))} min left` : secondsLeft >= 8 ? `about ${Math.max(10, Math.round(secondsLeft / 10) * 10)} s left` : 'almost there';
  const sub = done ? `${discover.found} films for tonight` : `${detail[stage]} · ${eta}`;

  return (
    <View style={{ flex: 1, overflow: 'hidden', backgroundColor: C.bg }} onLayout={(e) => setHeight(Math.round(e.nativeEvent.layout.height))}>
      <View style={StyleSheet.absoluteFill} importantForAccessibility="no-hide-descendants">
        {height > 0 && <FlyThrough width={width} height={height} />}
      </View>
      <LinearGradient
        colors={['rgba(10,9,8,0.72)', 'rgba(10,9,8,0)', 'rgba(10,9,8,0)', 'rgba(10,9,8,0.9)', C.bg]}
        locations={[0, 0.12, 0.6, 0.8, 0.95]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={{ position: 'absolute', left: 24, right: 24, bottom: insets.bottom + (compact ? 26 : 34), alignItems: 'center' }} accessible accessibilityLiveRegion="polite" accessibilityLabel={`${title}. ${sub}`}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {STAGES.map((st, i) => {
            const on = !done && i === at;
            const past = done || i < at;
            return (
              <React.Fragment key={st}>
                <View style={{ width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? C.accent : past ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.08)' }}>
                  <Icon name={STEPS[st][0]} size={17} color={on ? C.accentInk : past ? C.ink : C.faint} />
                </View>
                {i < STAGES.length - 1 && <View style={{ width: 20, height: 2, backgroundColor: past ? 'rgba(255,255,255,0.33)' : 'rgba(255,255,255,0.1)' }} />}
              </React.Fragment>
            );
          })}
        </View>
        <Text style={[display(compact ? 26 : 30), { marginTop: 18, textAlign: 'center' }]}>{title}</Text>
        <Text style={[sans(13, 'medium', C.dim), { marginTop: 6, textAlign: 'center' }]}>{sub}</Text>
        <View style={{ alignSelf: 'stretch', marginHorizontal: 36, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.14)', marginTop: 16, overflow: 'hidden' }}>
          <Animated.View style={[{ height: 4, borderRadius: 2, backgroundColor: C.accent }, barStyle]} />
        </View>
      </View>
    </View>
  );
}
