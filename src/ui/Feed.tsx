import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { GestureResponderEvent, Linking, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { GestureDetector, ScrollView as GestureScrollView, PanGesture, usePanGesture } from 'react-native-gesture-handler';
import Animated, { Easing, FadeIn, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withSpring, withTiming } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { scheduleOnRN } from 'react-native-worklets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { discover } from '../app/discover';
import { thud, tick } from '../app/platform';
import { app, useStore } from '../app/store';
import { signInFlow, ui } from '../app/ui';
import { Pick, Session } from '../core/engine/recommender';
import { Film, labelOf } from '../core/models';
import { Tmdb } from '../core/tmdb';

import { Blank, Icon, Overlay, Poster, RoundButton, ScoreRing, Stars } from './components';
import { ProviderRow, metaLine } from './FilmSheet';
import { C, caps, display, sans } from './theme';
import { Scouting } from './Wait';

// A native, GPU-drawn shadow under the card (elevation on Android).
const SHADOW = { backgroundColor: '#101013', elevation: 18, shadowColor: '#000', shadowOpacity: 0.55, shadowRadius: 26, shadowOffset: { width: 0, height: 18 } };

/** The swipe between films, so the text on a flipped card can scroll without paging. */
const PagerSwipe = createContext<PanGesture | undefined>(undefined);

/**
 * Tap detection that never becomes the touch responder, so a swipe that
 * starts on the card always belongs to the pager.
 */
function useTap(onTap: () => void) {
  const start = useRef({ x: 0, y: 0, at: 0 });
  return {
    onTouchStart: (e: GestureResponderEvent) => {
      start.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY, at: Date.now() };
    },
    onTouchEnd: (e: GestureResponderEvent) => {
      const s = start.current;
      if (Date.now() - s.at < 400 && Math.abs(e.nativeEvent.pageX - s.x) < 14 && Math.abs(e.nativeEvent.pageY - s.y) < 14) onTap();
    },
    accessibilityActions: [{ name: 'activate' as const }],
    onAccessibilityAction: onTap,
  };
}

/** How many films before and after the one on screen stay drawn; the rest of the list is empty space of the same height. */
const KEPT = 2;

/** Results: one poster per screen, swipe up for the next through everything the search found, tap to flip. */
export function FeedScreen() {
  useStore(discover);
  useStore(app);
  const insets = useSafeAreaInsets();
  const [height, setHeight] = useState(0);
  const [index, setIndex] = useState(0);
  const s = discover.session;
  const generation = discover.generation;
  const picks = s?.picks ?? [];
  const at = Math.min(index, picks.length);

  // One film per screen. `pos` is the page on show, fractional while a finger
  // moves it; on release it springs to the next or previous film, carrying the
  // speed of the flick.
  const pos = useSharedValue(0);
  const from = useSharedValue(0);
  const pageH = useSharedValue(1);
  const last = useSharedValue(0); // index of the page after the last film
  const shown = useRef(0);
  useEffect(() => {
    last.value = picks.length;
  }, [picks.length, last]);
  useEffect(() => {
    shown.current = 0;
    setIndex(0);
    cancelAnimation(pos);
    pos.value = 0;
  }, [generation, pos]);
  useEffect(() => {
    // A film was removed from the end: stay on a page that exists.
    if (index > picks.length) {
      shown.current = picks.length;
      setIndex(picks.length);
      pos.value = withTiming(picks.length, { duration: 260 });
    }
  }, [picks.length, index, pos]);
  const settle = (i: number) => {
    if (i === shown.current) return;
    shown.current = i;
    tick();
    setIndex(i);
  };
  const go = (d: number) => {
    const i = Math.max(0, Math.min(picks.length, shown.current + d));
    pos.value = withTiming(i, { duration: 320, easing: Easing.out(Easing.cubic) });
    settle(i);
  };
  const pager = usePanGesture(
    useMemo(
      () => ({
        activeOffsetY: [-10, 10] as [number, number],
        failOffsetX: [-24, 24] as [number, number],
        onActivate: () => {
          'worklet';
          cancelAnimation(pos);
          from.value = pos.value;
        },
        onUpdate: (e: { translationY: number }) => {
          'worklet';
          let p = from.value - e.translationY / pageH.value;
          // Resist before the first film and after the last page.
          if (p < 0) p *= 0.22;
          if (p > last.value) p = last.value + (p - last.value) * 0.22;
          pos.value = p;
        },
        onDeactivate: (e: { velocityY: number }) => {
          'worklet';
          const start = Math.round(from.value);
          let to = Math.round(pos.value);
          if (e.velocityY < -380) to = Math.ceil(pos.value - 0.02);
          else if (e.velocityY > 380) to = Math.floor(pos.value + 0.02);
          to = Math.max(0, Math.min(last.value, Math.max(start - 1, Math.min(start + 1, to))));
          pos.value = withSpring(to, { damping: 32, stiffness: 260, mass: 1, overshootClamping: true, velocity: -e.velocityY / pageH.value });
          scheduleOnRN(settle, to);
        },
      }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    ),
  );
  const slide = useAnimatedStyle(() => ({ transform: [{ translateY: -pos.value * pageH.value }] }));
  // Reasons and backgrounds are prepared a few films ahead of the one on screen.
  useEffect(() => {
    discover.view(at);
  }, [at, generation, picks.length]);
  const current = s ? (picks[at] ?? picks[picks.length - 1])?.film : undefined;
  // Have the next backgrounds ready before they are swiped to.
  const scenes = picks.map((p) => p.film.scene).filter((x): x is string => !!x).join(' ');
  useEffect(() => {
    if (scenes) void Image.prefetch(scenes.split(' ').map((x) => Tmdb.img(x, 'w780')));
  }, [scenes]);

  let body: React.ReactNode;
  if (!s) {
    body = discover.running ? <Scouting /> : <Problem />;
  } else if (!picks.length && !discover.running) {
    body = <Blank icon="funnel-outline" title="No film fits all of that" action="Change filters" onAction={() => ui.closeFeed()} />;
  } else if (height > 0) {
    // The pages near the one on screen stay mounted and memoised: nothing
    // re-renders while a swipe is in flight; the whole column moves on the UI thread.
    body = (
      <PagerSwipe.Provider value={pager}>
        <GestureDetector gesture={pager}>
          <View
            key={generation}
            style={{ flex: 1, overflow: 'hidden' }}
            accessibilityActions={[
              { name: 'next', label: 'Next film' },
              { name: 'previous', label: 'Previous film' },
            ]}
            onAccessibilityAction={(e) => go(e.nativeEvent.actionName === 'next' ? 1 : -1)}>
            <Animated.View style={[{ height: height * (picks.length + 1) }, slide]}>
              {picks.map((p, i) => (Math.abs(i - at) <= KEPT ? <PickPage key={p.film.id} pick={p} height={height} first={i === 0} /> : <View key={p.film.id} style={{ height }} />))}
              <MorePage session={s} height={height} />
            </Animated.View>
          </View>
        </GestureDetector>
      </PagerSwipe.Provider>
    );
  }

  return (
    <Overlay>
      <View
        style={{ flex: 1 }}
        onLayout={(e) => {
          setHeight(e.nativeEvent.layout.height);
          pageH.value = e.nativeEvent.layout.height;
        }}>
        {current && <Backdrop film={current} />}
        {body}
        <View style={{ position: 'absolute', top: insets.top + 6, left: 10, right: 16, flexDirection: 'row', alignItems: 'center' }} pointerEvents="box-none">
          <RoundButton icon="chevron-down" label="Close" size={46} onPress={() => ui.closeFeed()} />
          <View style={{ flex: 1, alignItems: 'center', paddingHorizontal: 10 }} pointerEvents="none">
            {s?.notice && picks.length > 0 && (
              <View style={{ backgroundColor: C.glass, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderColor: C.line }}>
                <Text style={sans(12, 'semi', C.accent)} numberOfLines={1}>
                  {s.notice}
                </Text>
              </View>
            )}
          </View>
          {picks.length > 0 && at < picks.length && (
            <Text style={sans(13, 'bold', C.dim)} importantForAccessibility="no">
              {at + 1} / {picks.length}
            </Text>
          )}
        </View>
      </View>
    </Overlay>
  );
}

/**
 * Behind the card: a real scene from the film, slowly drifting, once one has
 * been chosen (see engine/scenes.ts). Until then, and for films without one,
 * the poster as a soft glow.
 */
function Backdrop({ film }: { film: Film }) {
  const drift = useSharedValue(0);
  useEffect(() => {
    drift.value = withRepeat(withTiming(1, { duration: 22000, easing: Easing.inOut(Easing.quad) }), -1, true);
  }, [drift]);
  const moving = useAnimatedStyle(() => ({ transform: [{ scale: 1.08 + 0.12 * drift.value }, { translateX: (drift.value - 0.5) * 26 }] }));
  const scene = film.scene || undefined;
  return (
    <View style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]} pointerEvents="none">
      {film.poster && <Image source={{ uri: Tmdb.img(film.poster, 'w185') }} style={StyleSheet.absoluteFill} contentFit="cover" blurRadius={38} transition={500} />}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.58)' }]} />
      <Animated.View style={[StyleSheet.absoluteFill, moving]}>
        <Image source={scene ? { uri: Tmdb.img(scene, 'w780') } : null} style={StyleSheet.absoluteFill} contentFit="cover" transition={700} />
      </Animated.View>
      {scene && <LinearGradient colors={['rgba(0,0,0,0.66)', 'rgba(0,0,0,0.3)', 'rgba(0,0,0,0.3)', 'rgba(0,0,0,0.82)']} locations={[0, 0.3, 0.6, 1]} style={StyleSheet.absoluteFill} />}
    </View>
  );
}

function Problem() {
  const e = discover.llmError;
  if (!discover.error) return <Blank icon="film-outline" title="Nothing here yet" action="Back" onAction={() => ui.closeFeed()} />;
  if (e?.needsSignIn) {
    return (
      <Blank
        icon="lock-closed-outline"
        title="Please sign in again"
        action="Continue with ChatGPT"
        onAction={async () => {
          if (await signInFlow()) void discover.start();
        }}
      />
    );
  }
  if (e?.usageLimit) {
    return <Blank icon="hourglass-outline" title="ChatGPT usage limit reached" action="Manage usage" onAction={() => Linking.openURL('https://chatgpt.com/settings/usage')} />;
  }
  return <Blank icon="cloud-offline-outline" title={discover.error} action="Try again" onAction={() => void discover.start()} />;
}

const PickPage = React.memo(function PickPage({ pick, height, first }: { pick: Pick; height: number; first: boolean }) {
  useStore(app);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [flipped, setFlipped] = useState(false);
  const flip = useSharedValue(0);
  const f = pick.film;
  const e = app.lib.get(f.id);
  const top = insets.top + 60;
  const bottom = insets.bottom + 110;
  const cardW = Math.min(width - 36, (height - top - bottom - 8) / 1.5);
  const cardH = cardW * 1.5;

  const toggle = () => {
    thud();
    flip.value = withTiming(flipped ? 0 : 1, { duration: 560, easing: Easing.inOut(Easing.cubic) });
    setFlipped(!flipped);
    if (!app.settings.flipHintSeen) {
      app.settings.flipHintSeen = true;
      app.changed();
    }
  };
  const front = useAnimatedStyle(() => ({
    opacity: flip.value < 0.5 ? 1 : 0,
    transform: [{ perspective: 1400 }, { rotateY: `${flip.value * 180}deg` }, { scale: 1 - 0.07 * Math.sin(flip.value * Math.PI) }],
  }));
  const back = useAnimatedStyle(() => ({
    opacity: flip.value >= 0.5 ? 1 : 0,
    transform: [{ perspective: 1400 }, { rotateY: `${flip.value * 180 + 180}deg` }, { scale: 1 - 0.07 * Math.sin(flip.value * Math.PI) }],
  }));
  const tap = useTap(toggle);
  const card = { position: 'absolute' as const, width: cardW, height: cardH, borderRadius: 28 };

  return (
    <View style={{ height, paddingTop: top, paddingBottom: insets.bottom + 14 }}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: cardW, height: cardH }}>
          <Animated.View style={[card, SHADOW, front]} pointerEvents={flipped ? 'none' : 'auto'}>
            <View {...tap} accessible accessibilityRole="button" accessibilityLabel={`${labelOf(f)}. Tap to flip for details.`} style={{ flex: 1 }}>
              <Poster path={f.poster} radius={28} size="w780" style={{ flex: 1 }} />
              {first && !app.settings.flipHintSeen && (
                <View style={{ position: 'absolute', bottom: 22, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.glass, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 9, borderWidth: 1, borderColor: C.line }}>
                  <Icon name="swap-horizontal" size={15} color={C.ink} />
                  <Text style={sans(12.5, 'bold')}>Tap to flip</Text>
                </View>
              )}
            </View>
          </Animated.View>
          <Animated.View style={[card, { overflow: 'hidden', backgroundColor: '#121215', borderWidth: 1, borderColor: C.line }, back]} pointerEvents={flipped ? 'auto' : 'none'}>
            {flipped && <Back pick={pick} onFlip={toggle} />}
          </Animated.View>
        </View>
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-evenly', marginTop: 14 }}>
        <RoundButton
          icon="close"
          label="Not for me"
          showLabel
          onPress={() => {
            app.setNotInterested(f.id, true);
            discover.remove(pick);
          }}
        />
        <RoundButton
          icon={e?.watchlist ? 'bookmark' : 'bookmark-outline'}
          label="Watchlist"
          showLabel
          active={e?.watchlist === true}
          onPress={e?.watched ? undefined : () => app.setWatchlist(f.id, !(e?.watchlist ?? false))}
        />
        <RoundButton
          icon={e?.rating !== undefined ? 'star' : 'star-outline'}
          label={e?.rating !== undefined ? `Rated ${e.rating} stars` : 'Seen it'}
          caption={e?.rating !== undefined ? `${e.rating}★` : 'Seen it'}
          showLabel
          active={e?.watched === true}
          onPress={() => ui.openFilm(f, false)}
        />
        <RoundButton icon="sparkles-outline" label="More like it" showLabel onPress={() => void discover.start(f)} />
      </View>
    </View>
  );
});

const SPARK = 'M12 2c.6 5.5 4.5 9.4 10 10-5.5.6-9.4 4.5-10 10-.6-5.5-4.5-9.4-10-10 5.5-.6 9.4-4.5 10-10z';
const LINES = [1, 0.93, 0.58]; // widths of the placeholder lines, like a short paragraph

/**
 * Stands where the reason goes while the AI writes it (when the feed is scrolled faster than
 * the reasons come): a turning sparkle, "Writing…", and grey lines with a light passing over.
 */
function Writing() {
  const w = useSharedValue(0);
  const sweep = useSharedValue(0);
  const turn = useSharedValue(0);
  useEffect(() => {
    sweep.value = withRepeat(withTiming(1, { duration: 1500, easing: Easing.inOut(Easing.quad) }), -1, false);
    turn.value = withRepeat(withTiming(1, { duration: 2400, easing: Easing.linear }), -1, false);
    return () => {
      cancelAnimation(sweep);
      cancelAnimation(turn);
    };
  }, []);
  // One band of light, as wide as the paragraph, crosses all three lines at once.
  const band = useAnimatedStyle(() => ({ width: w.value, transform: [{ translateX: (sweep.value * 2 - 1) * w.value }] }));
  const spin = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 360}deg` }] }));
  return (
    <View accessible accessibilityLabel="Why it fits is being written">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 10 }}>
        <Animated.View style={spin}>
          <Svg width={14} height={14} viewBox="0 0 24 24">
            <Path d={SPARK} fill={C.accent} />
          </Svg>
        </Animated.View>
        <Text style={sans(12.5, 'bold', C.accent)}>Writing…</Text>
      </View>
      <View onLayout={(e) => (w.value = e.nativeEvent.layout.width)} style={{ gap: 9, paddingTop: 2 }}>
        {LINES.map((f) => (
          <View key={f} style={{ width: `${f * 100}%`, height: 13, borderRadius: 7, backgroundColor: 'rgba(255,255,255,0.09)', overflow: 'hidden' }}>
            <Animated.View style={[{ position: 'absolute', top: 0, bottom: 0, left: 0 }, band]}>
              <LinearGradient colors={['transparent', 'rgba(255,255,255,0.16)', 'transparent']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
            </Animated.View>
          </View>
        ))}
      </View>
    </View>
  );
}

/** Back of the card: the facts, and why this film fits this user. */
function Back({ pick: p, onFlip }: { pick: Pick; onFlip: () => void }) {
  useStore(discover); // the reason is written after the film is on screen
  const f = p.film;
  // A swipe that starts on the flipped card scrolls its text and never moves
  // on to another film, even at the end of the text; a swipe beside the card
  // does.
  const tap = useTap(onFlip);
  const pager = useContext(PagerSwipe);
  return (
    <>
      {f.poster && <Image source={{ uri: Tmdb.img(f.poster, 'w185') }} style={[StyleSheet.absoluteFill, { opacity: 0.3 }]} contentFit="cover" blurRadius={50} />}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(14,14,17,0.72)' }]} />
      <GestureScrollView block={pager} overScrollMode="never" showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 22, paddingBottom: 26, flexGrow: 1 }}>
        <View {...tap} accessible accessibilityRole="button" accessibilityHint="Flips back to the poster">
          <Text style={display(28)}>{f.title}</Text>
          <Text style={[sans(13, 'medium', C.dim, { lineHeight: 19 }), { marginTop: 10 }]}>{metaLine(f)}</Text>
          {f.directors.length > 0 && <Text style={[sans(13, 'semi'), { marginTop: 4 }]}>Directed by {f.directors.slice(0, 2).join(', ')}</Text>}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18 }}>
            <ScoreRing film={f} />
            <Text style={sans(11, 'medium', C.dim, { lineHeight: 14 })}>{'TMDB\nuser score'}</Text>
            <View style={{ flex: 1 }} />
            {p.personal && p.predicted !== undefined && (
              <View style={{ alignItems: 'flex-end' }} accessible accessibilityLabel={`Predicted for you: ${p.predicted.toFixed(1)} stars`}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Icon name="star" size={18} color={C.accent} />
                  <Text style={sans(22, 'black')}>{p.predicted.toFixed(1)}</Text>
                </View>
                <Text style={sans(11, 'medium', C.dim)}>predicted for you</Text>
              </View>
            )}
          </View>
          <View style={{ marginTop: 16 }}>
            <ProviderRow film={f} sv={discover.services} />
          </View>
          {(p.why !== undefined || app.hasLlm) && <Text style={[caps(C.accent), { marginTop: 22, marginBottom: 8 }]}>WHY IT FITS</Text>}
          {p.why !== undefined ? (
            <Animated.Text entering={FadeIn.duration(350)} style={sans(16, 'medium', C.ink, { lineHeight: 24 })}>
              {p.why}
            </Animated.Text>
          ) : (
            app.hasLlm && <Writing />
          )}
          {p.anchors.length > 0 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 }}>
              {p.anchors.map((a) => {
                const mine = app.lib.get(a.id)?.rating;
                return (
                  <View key={a.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.soft, borderRadius: 12, padding: 5, paddingRight: 12 }}>
                    <Poster path={a.poster} radius={6} size="w92" style={{ width: 30, height: 45 }} />
                    <View>
                      <Text style={[sans(12.5, 'bold'), { maxWidth: 150 }]} numberOfLines={1}>
                        {a.title}
                      </Text>
                      {mine !== undefined && (
                        <View style={{ marginTop: 3 }}>
                          <Stars value={mine} size={12} />
                        </View>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          )}
          {p.facts.map((fact) => (
            <View key={fact} style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
              <Icon name="checkmark-circle-outline" size={16} color={C.dim} style={{ marginTop: 1 }} />
              <Text style={[sans(13.5, 'medium', C.dim, { lineHeight: 19 }), { flex: 1 }]}>{fact}</Text>
            </View>
          ))}
          {f.overview.length > 0 && (
            <>
              <Text style={[caps(), { marginTop: 22, marginBottom: 8 }]}>STORY</Text>
              <Text style={sans(14, 'medium', C.dim, { lineHeight: 21 })}>{f.overview}</Text>
            </>
          )}
        </View>
      </GestureScrollView>
    </>
  );
}

/** After the last film: the only place where going on means waiting, because new films have to be found first. */
function MorePage({ session: s, height }: { session: Session; height: number }) {
  let body: React.ReactNode;
  if (discover.loadingMore) body = <Scouting compact />;
  else if (discover.error) body = <Blank icon="cloud-offline-outline" title={discover.error} action="Try again" onAction={() => void discover.more()} />;
  else if (s.exhausted) body = <Blank icon="checkmark-done-outline" title="That was everything" action="New search" onAction={() => ui.closeFeed()} />;
  else {
    body = (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <RoundButton icon="chevron-down" label="Find more films" size={92} onPress={() => void discover.more()} />
        <Text style={[display(26), { marginTop: 16 }]}>More</Text>
      </View>
    );
  }
  return <View style={{ height }}>{body}</View>;
}
