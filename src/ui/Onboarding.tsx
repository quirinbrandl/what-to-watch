import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import Animated, { FadeIn, FadeInDown, ZoomIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { app, useStore } from '../app/store';
import { apiKeyFlow, signInFlow, ui } from '../app/ui';
import { cleanUsername } from '../core/letterboxd';
import { Film, labelOf, yearOf } from '../core/models';
import { STARTER_QUERIES, mixStarters } from '../core/starters';

import { BigButton, Chip, Icon, IconName, Poster, PosterWall, RoundButton, Sheet, StarInput, Stars, Wordmark } from './components';
import { ExportSteps, importZipFlow, openLetterboxdExport } from './Settings';
import { C, sans, display } from './theme';

/**
 * Sign in → welcome → "Got a Letterboxd account?" → import it, or rate ten
 * films here. Ends on Discover; the first search is the user's to start.
 * Streaming services are picked per search, in the filters.
 */
type Step = 'signin' | 'welcome' | 'question' | 'import' | 'rate';
const DOT: Record<Step, number> = {
  signin: 0,
  welcome: 0,
  question: 1,
  import: 2,
  rate: 2,
};

/** How many rated films the rating step asks for. */
const GOAL = 10;

export function Onboarding() {
  useStore(app);
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>(app.hasLlm ? 'question' : 'signin');
  const [busy, setBusy] = useState(false);
  const [wall, setWall] = useState<string[]>([]);
  const [user, setUser] = useState('');
  const finish = () => {
    app.settings.onboarded = true;
    app.changed();
  };

  useEffect(() => {
    let alive = true;
    Promise.all([app.tmdb.topRated(), app.tmdb.topRated(2), app.tmdb.trending()])
      .then((lists) => {
        const posters = lists
          .flat()
          .map((f) => f.poster)
          .filter((p): p is string => !!p)
          .sort(() => Math.random() - 0.5);
        if (alive) setWall(posters.slice(0, 40));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Android back steps back from the import to the question. The rating step handles its own.
  const stepNow = useRef(step);
  stepNow.current = step;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (ui.dialog || stepNow.current !== 'import') return false;
      setStep('question');
      return true;
    });
    return () => sub.remove();
  }, []);

  const signIn = async () => {
    setBusy(true);
    const ok = await signInFlow(false);
    setBusy(false);
    if (!ok) return;
    if (!app.settings.welcomeSeen && !app.settings.useApiKey) {
      app.settings.welcomeSeen = true;
      app.changed();
      setStep('welcome');
    } else setStep('question');
  };
  const useUsername = () => {
    if (!cleanUsername(user)) return ui.toast('That does not look like a username');
    app.setUsername(user);
    finish();
  };

  const lib = app.lib;
  const imported = lib.lbImportAt !== undefined;
  const link = (label: string, onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={8}
      style={{
        alignSelf: 'center',
        minHeight: 44,
        justifyContent: 'center',
        paddingHorizontal: 16,
        marginTop: 4,
      }}>
      <Text style={sans(14, 'semi', C.dim)}>{label}</Text>
    </Pressable>
  );
  const sub = (text: string) => <Text style={[sans(15, 'medium', C.dim, { lineHeight: 21 }), { marginTop: 12 }]}>{text}</Text>;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <PosterWall posters={step === 'rate' ? [] : wall} dim={step === 'signin' ? 0.2 : 0.82} />
      <View
        style={{
          flex: 1,
          paddingTop: insets.top + 16,
          paddingHorizontal: 24,
          paddingBottom: insets.bottom + 20,
        }}>
        {step === 'import' ? <TopBar onBack={() => setStep('question')} at={DOT.import} /> : <Dots at={DOT[step]} />}
        <View style={{ flex: 1 }} />
        {step === 'signin' && (
          <Animated.View key="signin" entering={FadeInDown.duration(320)}>
            <Wordmark size={50} mark />
            <BigButton label="Continue with ChatGPT" onPress={signIn} busy={busy} style={{ marginTop: 34 }} />
            {busy ? link('Cancel', () => app.auth.cancelSignIn()) : link('Use an OpenAI API key', async () => (await apiKeyFlow()) && setStep('question'))}
          </Animated.View>
        )}
        {step === 'welcome' && (
          <Animated.View key="welcome" entering={FadeInDown.duration(320)}>
            <Text style={display(56)} accessibilityRole="header">
              You’re in
            </Text>
            {sub('Welcome to WhatToWatch.')}
            <View style={{ gap: 16, marginTop: 26, marginBottom: 30 }}>
              <HelloRow icon="checkmark-circle-outline" color={C.good} title="Signed in with ChatGPT" body="No extra account needed." />
              <HelloRow icon="sparkles" color={C.accent} title="Runs on your ChatGPT plan" body="Check your usage anytime in your ChatGPT settings." />
            </View>
            <BigButton label="Next" onPress={() => setStep('question')} />
          </Animated.View>
        )}
        {step === 'question' && (
          <Animated.View key="question" entering={FadeInDown.duration(320)}>
            <Text style={display(42)} accessibilityRole="header">
              {'Got a\nLetterboxd\naccount?'}
            </Text>
            {sub('If you do, your ratings come with you. If not, you rate a few films here.')}
            <BigButton label="Yes, import my films" onPress={() => setStep('import')} style={{ marginTop: 28 }} />
            <BigButton label="No, I don’t use it" color="rgba(255,255,255,0.1)" ink={C.ink} onPress={() => setStep('rate')} style={{ marginTop: 12, borderWidth: 1, borderColor: C.line }} />
          </Animated.View>
        )}
        {step === 'import' && (
          <Animated.View key="import" entering={FadeInDown.duration(320)}>
            <Text style={display(40)} accessibilityRole="header">
              {imported ? 'Got your films' : 'Bring your\nLetterboxd'}
            </Text>
            {imported ? (
              <Text style={[sans(15, 'medium', C.dim), { marginTop: 12 }]}>{`${lib.rated.length} ratings  ·  ${lib.watched.length} seen  ·  ${lib.watchlist.length} watchlist`}</Text>
            ) : (
              <View
                style={{
                  marginTop: 16,
                  gap: 12,
                  backgroundColor: 'rgba(8,8,10,0.78)',
                  borderRadius: 20,
                  padding: 14,
                }}>
                <ExportSteps />
                <View style={{ alignSelf: 'flex-start', marginLeft: 30 }}>
                  <Chip label="Open letterboxd.com" icon="open-outline" onPress={openLetterboxdExport} />
                </View>
              </View>
            )}
            {imported ? (
              <BigButton label="Let’s go" icon="sparkles" color={C.accent} ink={C.accentInk} onPress={finish} style={{ marginTop: 28 }} />
            ) : (
              <>
                <BigButton label="Choose the ZIP file" icon="archive-outline" onPress={() => void importZipFlow()} style={{ marginTop: 22 }} />
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    backgroundColor: 'rgba(255,255,255,0.1)',
                    borderRadius: 29,
                    height: 58,
                    paddingLeft: 22,
                    paddingRight: 6,
                    marginTop: 12,
                  }}>
                  <TextInput
                    value={user}
                    onChangeText={setUser}
                    placeholder="or just your username"
                    placeholderTextColor={C.faint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="done"
                    onSubmitEditing={useUsername}
                    selectionColor={C.accent}
                    accessibilityLabel="Letterboxd username"
                    style={[sans(16), { flex: 1, paddingVertical: 0 }]}
                  />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Use username"
                    onPress={useUsername}
                    style={{
                      width: 46,
                      height: 46,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}>
                    <Icon name="arrow-forward" size={20} color={C.ink} />
                  </Pressable>
                </View>
                {link('No ZIP at hand? Rate films instead', () => setStep('rate'))}
              </>
            )}
          </Animated.View>
        )}
      </View>
      {step === 'rate' && <RateFilms onBack={() => setStep('question')} onDone={finish} />}
    </View>
  );
}

function Dots({ at }: { at: number }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 6 }} accessible accessibilityLabel={`Step ${at + 1} of 3`}>
      {[0, 1, 2].map((i) => (
        <View
          key={i}
          style={{
            width: i === at ? 22 : 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: i <= at ? C.ink : 'rgba(255,255,255,0.27)',
          }}
        />
      ))}
    </View>
  );
}

/** Back on the left, the step dots in the middle, an optional action on the right. */
function TopBar({ onBack, at, right }: { onBack: () => void; at: number; right?: React.ReactNode }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: -8,
      }}>
      <View style={{ width: 96, alignItems: 'flex-start' }}>
        <RoundButton icon="arrow-back" label="Back" size={44} onPress={onBack} />
      </View>
      <Dots at={at} />
      <View style={{ width: 96, alignItems: 'flex-end' }}>{right}</View>
    </View>
  );
}

function HelloRow({ icon, color, title, body }: { icon: IconName; color: string; title: string; body: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 14, alignItems: 'flex-start' }}>
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 14,
          backgroundColor: C.soft,
          alignItems: 'center',
          justifyContent: 'center',
        }}>
        <Icon name={icon} size={21} color={color} />
      </View>
      <View style={{ flex: 1, paddingTop: 2 }}>
        <Text style={sans(16, 'black')}>{title}</Text>
        <Text style={[sans(13.5, 'medium', C.dim, { lineHeight: 19 }), { marginTop: 3 }]}>{body}</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- rating step

async function starterFilms(): Promise<Film[]> {
  const lists = await Promise.all(STARTER_QUERIES.map((q) => app.tmdb.discover(q).catch(() => [] as Film[])));
  return mixStarters(lists);
}

const GAP = 8;

function RateFilms({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  useStore(app);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [films, setFilms] = useState<Film[] | undefined>();
  const [text, setText] = useState('');
  const [results, setResults] = useState<Film[] | undefined>();
  const [searching, setSearching] = useState(false);
  const [sheet, setSheet] = useState<Film | undefined>();
  // Films rated here, oldest first; anything rated before counts too.
  const [picked, setPicked] = useState<number[]>(() =>
    app.lib.rated
      .filter((e) => e.rating !== undefined)
      .sort((a, b) => (a.ratingAt ?? 0) - (b.ratingAt ?? 0))
      .map((e) => e.id),
  );
  const query = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sheetOpen = useRef(false);
  sheetOpen.current = !!sheet;

  useEffect(() => {
    let alive = true;
    starterFilms()
      .then((f) => alive && setFilms(f))
      .catch(() => alive && setFilms([]));
    return () => {
      alive = false;
      clearTimeout(timer.current);
      clearTimeout(closer.current);
    };
  }, []);

  const back = useRef(onBack);
  back.current = onBack;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (ui.dialog) return false;
      if (sheetOpen.current) setSheet(undefined);
      else back.current();
      return true;
    });
    return () => sub.remove();
  }, []);

  const search = (t: string) => {
    setText(t);
    const q = (query.current = t.trim());
    clearTimeout(timer.current);
    if (q.length < 2) {
      setResults(undefined);
      setSearching(false);
      return;
    }
    timer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await app.tmdb.search(q);
        if (query.current === q) setResults(r.filter((f) => f.poster).slice(0, 30));
      } catch {
        if (query.current === q) setResults([]);
      } finally {
        if (query.current === q) setSearching(false);
      }
    }, 350);
  };

  const rate = (f: Film, v: number | undefined) => {
    app.rate(f.id, v);
    if (v !== undefined) void app.ensureFilm(f.id);
    setPicked((p) => (v === undefined ? p.filter((x) => x !== f.id) : p.includes(f.id) ? p : [...p, f.id]));
  };
  const open = (f: Film) => {
    clearTimeout(closer.current);
    setSheet(f);
  };
  const closeSoon = () => {
    clearTimeout(closer.current);
    closer.current = setTimeout(() => setSheet(undefined), 420);
  };

  const n = picked.length;
  const ready = n >= GOAL;
  const skip = async () => {
    const start = await ui.confirm(
      n === 0 ? 'Start without rating?' : `Start with ${n} film${n === 1 ? '' : 's'}?`,
      n === 0
        ? 'Without a few films you like, the first picks are a guess. You can rate films later in your Library.'
        : 'Every film you rate makes the picks better. You can rate more later in your Library.',
      'Start anyway',
      false,
      { cancel: n === 0 ? 'Rate films' : 'Keep rating', quiet: true },
    );
    if (start) onDone();
  };

  const tile = Math.floor((width - 48 - GAP * 2) / 3);
  const shown = results ?? films;
  const slots = picked.slice(-GOAL);
  const slotW = (width - 48 - 5 * (GOAL - 1)) / GOAL;
  const sheetRating = sheet ? app.lib.get(sheet.id)?.rating : undefined;

  return (
    <Animated.View entering={FadeIn.duration(260)} style={[StyleSheet.absoluteFill, { backgroundColor: C.bg }]}>
      <View style={{ paddingTop: insets.top + 16, paddingHorizontal: 20 }}>
        <TopBar
          onBack={onBack}
          at={DOT.rate}
          right={
            !ready && (
              <Pressable
                accessibilityRole="button"
                onPress={skip}
                hitSlop={8}
                style={{
                  minHeight: 44,
                  justifyContent: 'center',
                  paddingHorizontal: 4,
                }}>
                <Text style={sans(14, 'bold', C.dim)}>{n === 0 ? 'Skip' : 'Start now'}</Text>
              </Pressable>
            )
          }
        />
      </View>
      <ScrollView
        stickyHeaderIndices={[1]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: 24,
          paddingBottom: insets.bottom + 230,
        }}>
        <View style={{ paddingTop: 14 }}>
          <Text style={display(38)} accessibilityRole="header">
            {`Rate ${GOAL} films\nyou liked`}
          </Text>
          <Text style={[sans(15, 'medium', C.dim, { lineHeight: 21 }), { marginTop: 12 }]}>Only films you’ve seen. Tap a poster to give it stars. Your first picks start from these.</Text>
        </View>
        <View style={{ backgroundColor: C.bg, paddingTop: 18, paddingBottom: 14 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              height: 48,
              borderRadius: 24,
              backgroundColor: '#1E1C1B',
              paddingLeft: 16,
              paddingRight: 6,
            }}>
            <Icon name="search" size={18} color={C.dim} />
            <TextInput
              value={text}
              onChangeText={search}
              placeholder="Search a film you love"
              placeholderTextColor={C.faint}
              returnKeyType="search"
              autoCorrect={false}
              selectionColor={C.accent}
              accessibilityLabel="Search films"
              style={[sans(15.5), { flex: 1, paddingVertical: 0 }]}
            />
            {searching ? (
              <ActivityIndicator color={C.dim} size="small" style={{ width: 36 }} />
            ) : text ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear search"
                onPress={() => search('')}
                hitSlop={6}
                style={{
                  width: 36,
                  height: 36,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                <Icon name="close" size={18} color={C.dim} />
              </Pressable>
            ) : null}
          </View>
        </View>
        {shown === undefined ? (
          <ActivityIndicator color={C.dim} style={{ marginTop: 40 }} />
        ) : shown.length === 0 ? (
          <Text style={[sans(14.5, 'medium', C.dim, { lineHeight: 21 }), { marginTop: 12 }]}>
            {results ? `No film called “${text.trim()}” found.` : 'Could not load films. Search for one you love instead.'}
          </Text>
        ) : (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: GAP }}>
            {shown.map((f) => (
              <RateTile key={f.id} film={f} rating={app.lib.get(f.id)?.rating} size={tile} onPress={() => open(f)} />
            ))}
          </View>
        )}
      </ScrollView>

      <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
        <LinearGradient pointerEvents="none" colors={['rgba(10,9,8,0)', C.bg]} locations={[0, 0.34]} style={StyleSheet.absoluteFill} />
        <View
          pointerEvents="box-none"
          style={{
            paddingHorizontal: 24,
            paddingTop: 64,
            paddingBottom: insets.bottom + 20,
            gap: 12,
          }}>
          {ready && (
            <Animated.View entering={FadeInDown.duration(300)}>
              <BigButton label="Let’s go" icon="sparkles" color={C.accent} ink={C.accentInk} onPress={onDone} />
            </Animated.View>
          )}
          <View accessible accessibilityLabel={ready ? `${n} films rated, ready` : `${n} of ${GOAL} films rated`} pointerEvents="none">
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}>
              <Text style={[sans(14, 'black'), { fontVariant: ['tabular-nums'] }]}>{ready ? `${n} films` : `${n} of ${GOAL}`}</Text>
              {ready ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Icon name="checkmark" size={15} color={C.good} />
                  <Text style={sans(13, 'bold', C.good)}>Ready</Text>
                </View>
              ) : (
                <Text style={sans(13, 'bold', C.dim)}>{`${GOAL - n} to go`}</Text>
              )}
            </View>
            {/* The film strip: the posters you rated fill ten slots. */}
            <View style={{ flexDirection: 'row', gap: 5, marginTop: 8 }}>
              {Array.from({ length: GOAL }, (_, i) => {
                const id = slots[i];
                return id !== undefined ? (
                  <Animated.View key={id} entering={ZoomIn.duration(260)}>
                    <Poster path={app.film(id)?.poster} radius={5} size="w92" style={{ width: slotW, height: slotW * 1.5 }} />
                  </Animated.View>
                ) : (
                  <View
                    key={`slot${i}`}
                    style={{
                      width: slotW,
                      height: slotW * 1.5,
                      borderRadius: 5,
                      borderWidth: 1.5,
                      borderColor: 'rgba(255,255,255,0.16)',
                      backgroundColor: 'rgba(255,255,255,0.04)',
                    }}
                  />
                );
              })}
            </View>
          </View>
        </View>
      </View>

      {sheet && (
        <Sheet onClose={() => setSheet(undefined)} maxHeight={0.7}>
          <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
            <Poster path={sheet.poster} radius={8} size="w185" style={{ width: 62, height: 93 }} />
            <View style={{ flex: 1 }}>
              <Text style={display(24)} numberOfLines={3}>
                {sheet.title}
              </Text>
              {yearOf(sheet) !== undefined && <Text style={[sans(13.5, 'medium', C.dim), { marginTop: 2 }]}>{yearOf(sheet)}</Text>}
            </View>
          </View>
          <View style={{ alignItems: 'center', marginTop: 18 }}>
            <StarInput value={sheetRating} onChange={(v) => rate(sheet, v)} onRelease={closeSoon} size={50} />
            <Text style={sans(12.5, 'medium', C.dim)}>Tap or slide across the stars</Text>
          </View>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              marginTop: 14,
            }}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setSheet(undefined)}
              hitSlop={6}
              style={{
                minHeight: 44,
                justifyContent: 'center',
                paddingHorizontal: 4,
              }}>
              <Text style={sans(14.5, 'bold', C.dim)}>Haven’t seen it</Text>
            </Pressable>
            {sheetRating !== undefined && (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  rate(sheet, undefined);
                  setSheet(undefined);
                }}
                hitSlop={6}
                style={{
                  minHeight: 44,
                  justifyContent: 'center',
                  paddingHorizontal: 4,
                }}>
                <Text style={sans(14.5, 'bold', C.accent)}>Remove rating</Text>
              </Pressable>
            )}
          </View>
        </Sheet>
      )}
    </Animated.View>
  );
}

/** A poster to tap; once rated it gets an accent edge and its stars. */
function RateTile({ film, rating, size, onPress }: { film: Film; rating?: number; size: number; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={rating === undefined ? labelOf(film) : `${labelOf(film)}, rated ${rating} stars`}
      onPress={onPress}
      style={({ pressed }) => ({
        width: size,
        height: size * 1.5,
        transform: [{ scale: pressed ? 0.96 : 1 }],
      })}>
      <Poster path={film.poster} radius={10} size="w342" style={{ width: size, height: size * 1.5 }} />
      {rating !== undefined && (
        <Animated.View
          entering={ZoomIn.duration(220)}
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              borderRadius: 10,
              borderWidth: 2.5,
              borderColor: C.accent,
              overflow: 'hidden',
              justifyContent: 'flex-end',
            },
          ]}>
          <LinearGradient colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.88)']} style={{ paddingTop: 22, paddingBottom: 6, alignItems: 'center' }}>
            <Stars value={rating} size={12} />
          </LinearGradient>
        </Animated.View>
      )}
    </Pressable>
  );
}
