import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useReducer, useRef, useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { discover } from '../app/discover';
import { app } from '../app/store';
import { STAGES, Stage } from '../core/engine/recommender';
import { Tmdb } from '../core/tmdb';
import { Tile, Wall } from '../core/wall';

import { Icon, IconName } from './components';
import { C, display, sans } from './theme';

const COLS = 4;
const GAP = 7;
const STAGGER = 46; // every second column sits this much higher
const WallTile = React.memo(function WallTile({ poster, state, rev, pulse, wait, width, delay }: Tile & { width: number; delay: number }) {
  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.8);
  const ring = useSharedValue(0);
  const first = useRef(true);
  const rest = state === 'keep' ? 1.06 : state === 'out' ? 0.93 : 1;
  useEffect(() => {
    const d = first.current ? delay : wait;
    first.current = false;
    opacity.value = withDelay(d, withTiming(state === 'out' ? 0.12 : 1, { duration: 520 }));
    scale.value = withDelay(d, withTiming(rest, { duration: 520 }));
    ring.value = withTiming(state === 'keep' ? 1 : 0, { duration: 420 });
    // `wait` belongs to the change of state it came with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, delay, opacity, scale, ring, rest]);
  useEffect(() => {
    if (rev > 0) scale.value = withSequence(withTiming(0.78, { duration: 0 }), withTiming(rest, { duration: 460, easing: Easing.out(Easing.back(1.8)) }));
    // Only a swap should replay this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev]);
  useEffect(() => {
    if (pulse > 0 && state === 'in') {
      scale.value = withSequence(withTiming(1.05, { duration: 220 }), withTiming(1, { duration: 520 }));
      ring.value = withSequence(withTiming(0.9, { duration: 220 }), withTiming(0, { duration: 620 }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pulse]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value, transform: [{ scale: scale.value }] }));
  const ringStyle = useAnimatedStyle(() => ({ opacity: ring.value }));
  const keep = state === 'keep';
  return (
    <Animated.View style={[{ width, height: width * 1.5, borderRadius: 10, zIndex: keep ? 1 : 0 }, keep && { boxShadow: `0 0 22px ${C.accent}` }, style]}>
      {poster && <Image source={{ uri: Tmdb.img(poster, 'w342') }} style={{ flex: 1, borderRadius: 10, backgroundColor: C.card }} contentFit="cover" transition={320} />}
      <Animated.View style={[StyleSheet.absoluteFill, { borderRadius: 10, borderWidth: 2.5, borderColor: C.accent }, ringStyle]} />
    </Animated.View>
  );
});

function Column({ index, children }: { index: number; children: React.ReactNode }) {
  const y = useSharedValue(0);
  useEffect(() => {
    y.value = withRepeat(withTiming(1, { duration: 8000, easing: Easing.inOut(Easing.sin) }), -1, true);
  }, [y]);
  const dir = index % 2 ? 1 : -1;
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: dir * (y.value * 24 - 12) }] }));
  return <Animated.View style={[{ gap: GAP, marginTop: index % 2 ? -STAGGER : 0 }, style]}>{children}</Animated.View>;
}

const STEPS: Record<Stage, [IconName, string]> = {
  taste: ['finger-print', 'Reading your taste'],
  scouting: ['compass-outline', 'Scouting films'],
  checking: ['checkmark-done-outline', 'Checking the facts'],
  judging: ['sparkles', 'Choosing for you'],
};

/** The user's own films, the best-liked first, to open the wall with. */
function ownPosters(n: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const entries = app.lib.all().sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  for (const e of entries) {
    const p = app.film(e.id)?.poster;
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push(p);
      if (out.length >= n * 2) break;
    }
  }
  // Not the same wall every time.
  return out.sort(() => Math.random() - 0.5).slice(0, n);
}

/**
 * The wait: a wall of posters that fills the screen and shows the search as
 * it happens, with the stage, a time estimate and a progress bar below.
 */
export function Scouting({ compact = false }: { compact?: boolean }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [height, setHeight] = useState(0);
  const [, redraw] = useReducer((x: number) => x + 1, 0);
  const wall = useRef<Wall | undefined>(undefined);

  const tileW = (width + 16 - GAP * (COLS - 1)) / COLS;
  const pitch = tileW * 1.5 + GAP;
  const rows = height > 0 ? Math.ceil((height + 30 + STAGGER + 30) / pitch) : 0;

  if (!wall.current && rows > 0) {
    // Tiles whose middle lies between the top bar and the status text: the picks end up on these.
    const visible: number[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < COLS; c++) {
        const mid = -30 + r * pitch + (c % 2 ? -STAGGER : 0) + tileW * 0.75;
        if (mid > insets.top + 70 && mid < height * 0.6) visible.push(c * rows + r);
      }
    }
    // The middle columns first: the outer ones are cut by the edge of the screen.
    const outer = (i: number) => Math.abs(Math.floor(i / rows) - (COLS - 1) / 2);
    visible.sort((a, b) => outer(a) - outer(b));
    wall.current = new Wall(COLS * rows, visible, ownPosters(COLS * rows));
  }
  wall.current?.sync(discover.scouted, discover.finalists, discover.verdicts, discover.reveal);

  useEffect(() => {
    const t = setInterval(() => {
      wall.current?.step();
      redraw();
    }, 360);
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
  const tiles = wall.current?.tiles ?? [];

  return (
    <View style={{ flex: 1, overflow: 'hidden' }} onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
      <View style={{ position: 'absolute', left: -8, right: -8, top: -30, flexDirection: 'row', gap: GAP, transform: [{ rotate: '-3deg' }, { scale: 1.05 }] }} importantForAccessibility="no-hide-descendants">
        {rows > 0 &&
          [...Array(COLS)].map((_, c) => (
            <Column key={c} index={c}>
              {[...Array(rows)].map((__, r) => {
                const i = c * rows + r;
                return <WallTile key={r} {...tiles[i]} width={tileW} delay={((i * 7) % (COLS * rows)) * 28} />;
              })}
            </Column>
          ))}
      </View>
      <LinearGradient
        colors={['rgba(10,9,8,0.72)', 'rgba(10,9,8,0)', 'rgba(10,9,8,0)', 'rgba(10,9,8,0.9)', C.bg]}
        locations={[0, 0.16, 0.5, 0.74, 0.93]}
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
