import { Image } from 'expo-image';
import React, { useEffect, useRef, useState } from 'react';
import { GestureResponderEvent, Linking, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { discover } from '../app/discover';
import { thud, tick } from '../app/platform';
import { app, useStore } from '../app/store';
import { signInFlow, ui } from '../app/ui';
import { Pick, STAGES, Session, Stage } from '../core/engine/recommender';
import { labelOf } from '../core/models';
import { Tmdb } from '../core/tmdb';

import { Blank, Icon, IconName, Overlay, Poster, PosterRibbon, RoundButton, ScoreRing, Stars } from './components';
import { ProviderRow, metaLine } from './FilmSheet';
import { C, caps, sans, display } from './theme';

// A native, GPU-drawn shadow under the card (elevation on Android).
const SHADOW = { backgroundColor: '#101013', elevation: 18, shadowColor: '#000', shadowOpacity: 0.55, shadowRadius: 26, shadowOffset: { width: 0, height: 18 } };

/**
 * Tap detection that never becomes the touch responder, so a swipe that
 * starts on the card always belongs to the list (paging stays native).
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

/** Results: one poster per screen, swipe up for the next, tap to flip. */
export function FeedScreen() {
  useStore(discover);
  useStore(app);
  const insets = useSafeAreaInsets();
  const [height, setHeight] = useState(0);
  const [index, setIndex] = useState(0);
  const s = discover.session;
  const generation = discover.generation;
  useEffect(() => setIndex(0), [generation]);
  const picks = s?.picks ?? [];
  const at = Math.min(index, picks.length);
  const backdrop = s ? (picks[at] ?? picks[picks.length - 1])?.film.poster : undefined;

  let body: React.ReactNode;
  if (!s) {
    body = discover.running ? <Scouting /> : <Problem />;
  } else if (!picks.length && !discover.running) {
    body = <Blank icon="funnel-outline" title="No film fits all of that" action="Change filters" onAction={() => ui.closeFeed()} />;
  } else if (height > 0) {
    // All pages stay mounted and memoised: paging is then purely native and
    // nothing re-renders while a swipe is in flight.
    const settle = (y: number) => {
      const i = Math.round(y / height);
      if (i !== index) {
        tick();
        setIndex(i);
      }
    };
    body = (
      <ScrollView
        key={generation}
        pagingEnabled
        showsVerticalScrollIndicator={false}
        overScrollMode="never"
        onMomentumScrollEnd={(e) => settle(e.nativeEvent.contentOffset.y)}
        onScrollEndDrag={(e) => settle(e.nativeEvent.targetContentOffset?.y ?? e.nativeEvent.contentOffset.y)}>
        {picks.map((p, i) => (
          <PickPage key={p.film.id} pick={p} height={height} first={i === 0} />
        ))}
        <MorePage session={s} height={height} />
      </ScrollView>
    );
  }

  return (
    <Overlay>
      <View style={{ flex: 1 }} onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
        {backdrop && (
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <Image source={{ uri: Tmdb.img(backdrop, 'w185') }} style={StyleSheet.absoluteFill} contentFit="cover" blurRadius={38} transition={500} />
            <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.58)' }]} />
          </View>
        )}
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

/** Back of the card: the facts, and why this film fits this user. */
function Back({ pick: p, onFlip }: { pick: Pick; onFlip: () => void }) {
  const f = p.film;
  // Scroll inside the card only when the text does not fit; otherwise a
  // swipe on the card should move on to the next film.
  const tap = useTap(onFlip);
  const [box, setBox] = useState(0);
  const [content, setContent] = useState(0);
  return (
    <>
      {f.poster && <Image source={{ uri: Tmdb.img(f.poster, 'w185') }} style={[StyleSheet.absoluteFill, { opacity: 0.3 }]} contentFit="cover" blurRadius={50} />}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(14,14,17,0.72)' }]} />
      <ScrollView
        nestedScrollEnabled
        scrollEnabled={content > box + 1}
        onLayout={(e) => setBox(e.nativeEvent.layout.height)}
        onContentSizeChange={(_, h) => setContent(h)}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: 22, paddingBottom: 26 }}>
        <View {...tap} accessible accessibilityRole="button" accessibilityHint="Flips back to the poster">
          <Text style={display(28)}>{f.title}</Text>
          <Text style={[sans(13, 'medium', C.dim, { lineHeight: 19 }), { marginTop: 10 }]}>{metaLine(f)}</Text>
          {f.directors.length > 0 && <Text style={[sans(13, 'semi'), { marginTop: 4 }]}>Directed by {f.directors.slice(0, 2).join(', ')}</Text>}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18 }}>
            <ScoreRing film={f} />
            <Text style={sans(11, 'medium', C.dim, { lineHeight: 14 })}>{'TMDB\nuser score'}</Text>
            <View style={{ flex: 1 }} />
            {p.personal && (
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
            <ProviderRow film={f} />
          </View>
          <Text style={[caps(C.accent), { marginTop: 22, marginBottom: 8 }]}>WHY IT FITS</Text>
          <Text style={sans(16, 'medium', C.ink, { lineHeight: 24 })}>{p.why}</Text>
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
      </ScrollView>
    </>
  );
}

function MorePage({ session: s, height }: { session: Session; height: number }) {
  let body: React.ReactNode;
  if (discover.loadingMore) body = <Scouting compact />;
  else if (discover.error) body = <Blank icon="cloud-offline-outline" title={discover.error} action="Try again" onAction={() => void discover.more()} />;
  else if (s.exhausted && !s.reserve.length) body = <Blank icon="checkmark-done-outline" title="That was everything" action="New search" onAction={() => ui.closeFeed()} />;
  else {
    body = (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <RoundButton icon="chevron-down" label="More films" size={92} onPress={() => void discover.more()} />
        <Text style={[display(26), { marginTop: 16 }]}>More</Text>
      </View>
    );
  }
  return <View style={{ height }}>{body}</View>;
}

const STEPS: Record<Stage, [IconName, string]> = {
  taste: ['finger-print', 'Reading your taste'],
  scouting: ['compass-outline', 'Scouting'],
  checking: ['checkmark-done-outline', 'Checking the facts'],
  judging: ['sparkles', 'Choosing for you'],
};

/** The wait, made of the real candidates as they are found. */
export function Scouting({ compact = false }: { compact?: boolean }) {
  const fallback = useRef<string[] | undefined>(undefined);
  if (!fallback.current) {
    fallback.current = app.lib
      .all()
      .slice(0, 60)
      .map((e) => app.film(e.id)?.poster)
      .filter((p): p is string => !!p);
  }
  const posters = discover.scouted.length >= 9 ? discover.scouted : [...discover.scouted, ...fallback.current];
  const stage = discover.stage ?? 'taste';
  const at = STAGES.indexOf(stage);
  const h = compact ? 118 : 156;
  const row = (r: number) => posters.filter((_, i) => i % 3 === r);
  return (
    <View style={{ flex: 1, justifyContent: 'center' }}>
      {posters.length > 0 && (
        <View style={{ transform: [{ rotate: '-3deg' }, { scale: 1.08 }], gap: 10 }}>
          <PosterRibbon posters={row(0)} height={h} speed={30} />
          <PosterRibbon posters={row(1)} height={h} speed={22} reverse />
          {!compact && <PosterRibbon posters={row(2)} height={h} speed={36} />}
        </View>
      )}
      <View style={{ alignItems: 'center', marginTop: compact ? 30 : 44 }} accessible accessibilityLiveRegion="polite" accessibilityLabel={STEPS[stage][1]}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {STAGES.map((st, i) => (
            <React.Fragment key={st}>
              <View
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 21,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: i === at ? C.accent : i < at ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.07)',
                }}>
                <Icon name={STEPS[st][0]} size={19} color={i === at ? C.accentInk : i < at ? C.ink : C.faint} />
              </View>
              {i < STAGES.length - 1 && <View style={{ width: 22, height: 2, backgroundColor: i < at ? 'rgba(255,255,255,0.33)' : 'rgba(255,255,255,0.08)' }} />}
            </React.Fragment>
          ))}
        </View>
        <Text style={[display(compact ? 22 : 27), { marginTop: 22 }]}>{STEPS[stage][1]}</Text>
        <Text style={[sans(13, 'medium', C.dim), { marginTop: 8 }]}>
          {stage === 'judging' ? `${discover.pool} finalists` : discover.pool > 0 ? `${discover.pool} films in play` : 'This takes about a minute'}
        </Text>
      </View>
    </View>
  );
}
