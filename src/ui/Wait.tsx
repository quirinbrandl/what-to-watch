import { Canvas, RoundedRect } from '@shopify/react-native-skia';
import { LinearGradient } from 'expo-linear-gradient';
import React, { memo, useEffect, useReducer, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Easing, useDerivedValue, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import NativeFlyThrough from '../../modules/fly-through/src/FlyThrough';
import { discover } from '../app/discover';
import { app } from '../app/store';
import { MISS, STAGES, Stage } from '../core/engine/recommender';

import { Icon, IconName } from './components';
import { C, display, sans } from './theme';

/* ---- The fly-through ---- */

const OWN = 120; // how many of the user's films fly and make up the far wall

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

interface SearchInput {
  found: string[];
  finalists: string[];
  verdictFilms: string[];
  verdictStars: number[];
  done: boolean;
}

/** What the search has reported so far, for the fly-through. */
function searchInput(): SearchInput {
  const poster = new Map<number, string>();
  for (const f of discover.finalists) if (f.poster) poster.set(f.id, f.poster);
  const verdictFilms: string[] = [];
  const verdictStars: number[] = [];
  for (const [id, r] of discover.verdicts) {
    const p = poster.get(id);
    if (p) {
      verdictFilms.push(p);
      verdictStars.push(r);
    }
  }
  return { found: [...discover.scouted], finalists: [...poster.values()], verdictFilms, verdictStars, done: !!discover.reveal };
}

const same = (a: SearchInput, b: SearchInput) => a.found.length === b.found.length && a.finalists.length === b.finalists.length && a.verdictFilms.length === b.verdictFilms.length && a.done === b.done;

/**
 * Hundreds of posters drift towards the viewer off a far wall of the user's films and show the
 * search as it happens (see modules/fly-through). Simulated and drawn natively: from JavaScript,
 * handing every poster to the drawing code every frame took longer than a frame on a phone.
 * Memoised, so the wait screen's text, redrawn several times a second, leaves it alone.
 */
const FlyThrough = memo(function FlyThrough() {
  const [own] = useState(() => ownPosters(OWN));
  const [seed] = useState(() => Math.floor(Math.random() * 1e9));
  const [input, setInput] = useState(searchInput);
  useEffect(() => {
    const t = setInterval(() => {
      const next = searchInput();
      setInput((cur) => (same(cur, next) ? cur : next));
    }, 200);
    return () => clearInterval(t);
  }, []);
  return <NativeFlyThrough style={StyleSheet.absoluteFill} own={own} {...input} miss={MISS} seed={seed} />;
});

/* ---- The wait screen ---- */

/**
 * The progress bar, drawn by Skia: an animated width in a React Native style would make
 * Reanimated commit and lay out the whole view tree on the UI thread every frame.
 */
function ProgressBar({ fraction }: { fraction: number }) {
  const bar = useSharedValue(0);
  useEffect(() => {
    bar.value = withTiming(fraction, { duration: 420, easing: Easing.linear });
  }, [fraction, bar]);
  const size = useSharedValue({ width: 0, height: 0 });
  const track = useDerivedValue(() => size.value.width);
  const fill = useDerivedValue(() => size.value.width * bar.value);
  return (
    <Canvas style={{ alignSelf: 'stretch', marginHorizontal: 36, height: 4, marginTop: 16 }} onSize={size}>
      <RoundedRect x={0} y={0} width={track} height={4} r={2} color="rgba(255,255,255,0.14)" />
      <RoundedRect x={0} y={0} width={fill} height={4} r={2} color={C.accent} />
    </Canvas>
  );
}

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
  const [, redraw] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    const t = setInterval(redraw, 360);
    return () => clearInterval(t);
  }, []);

  const stage = discover.stage ?? 'taste';
  const at = STAGES.indexOf(stage);
  const done = !!discover.reveal;
  const { fraction, secondsLeft, late } = discover.progressNow();

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
    <View style={{ flex: 1, overflow: 'hidden', backgroundColor: C.bg }}>
      <View style={StyleSheet.absoluteFill} importantForAccessibility="no-hide-descendants">
        <FlyThrough />
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
        <ProgressBar fraction={fraction} />
      </View>
    </View>
  );
}
