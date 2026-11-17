import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { discover } from '../app/discover';
import { tick } from '../app/platform';
import { app, useStore } from '../app/store';
import { ui } from '../app/ui';
import { hardFilterCount, newRequest } from '../core/engine/request';
import { GENRES, GENRE_IDS, LANGUAGES } from '../core/models';

import { BigButton, Chip, Icon, Poster, PosterWall, RangeSlider, Sheet, ToggleRow, Wordmark } from './components';
import { C, caps, runtimeLabel, sans, display } from './theme';

/** Home: your films as a living backdrop, one thumb-reach composer. */
export function DiscoverScreen() {
  useStore(app);
  useStore(discover);
  const insets = useSafeAreaInsets();
  const r = app.settings.request;
  const [text, setText] = useState(r.prompt);
  const [wall, setWall] = useState<string[]>([]);
  const size = app.lib.entries.size;
  const built = useRef(-1);

  // The backdrop is the user's own films; trending fills in for new users.
  useEffect(() => {
    if (built.current === size) return;
    built.current = size;
    const own = app.lib
      .all()
      .filter((e) => !e.notInterested && (e.watchlist || (e.rating ?? 0) >= 3.5))
      .map((e) => app.film(e.id)?.poster)
      .filter((p): p is string => !!p)
      .sort(() => Math.random() - 0.5)
      .slice(0, 40);
    if (own.length >= 16) return setWall(own);
    let alive = true;
    app.tmdb
      .trending()
      .then((t) => alive && setWall([...own, ...t.map((f) => f.poster).filter((p): p is string => !!p)]))
      .catch(() => alive && setWall(own));
    return () => {
      alive = false;
    };
  }, [size]);

  const go = () => {
    r.prompt = text.trim();
    app.changed();
    if (!app.hasLlm) return ui.toast('Sign in first — Settings → Account');
    ui.openFeed({ start: true });
  };

  const n = hardFilterCount(r);
  const sheet = () => ui.openFilters();
  const picks = discover.session?.picks ?? [];
  return (
    <View style={{ flex: 1 }}>
      <PosterWall posters={wall} />
      <View style={{ flex: 1, paddingTop: insets.top + 10, paddingHorizontal: 16, paddingBottom: insets.bottom + 86 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Wordmark size={24} mark />
        </View>
        <View style={{ flex: 1 }} />
        {picks.length > 0 && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open your last picks"
            onPress={() => {
              tick();
              ui.openFeed();
            }}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            {picks.slice(0, 5).map((p) => (
              <Poster key={p.film.id} path={p.film.poster} radius={8} size="w185" style={{ width: 56, height: 84 }} />
            ))}
            <View style={{ flex: 1 }} />
            <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="arrow-forward" size={20} color={C.ink} />
            </View>
          </Pressable>
        )}
        <View style={{ backgroundColor: C.glass, borderRadius: 28, borderWidth: 1, borderColor: C.line, padding: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="In the mood for…"
              placeholderTextColor={C.faint}
              multiline
              maxLength={300}
              submitBehavior="blurAndSubmit"
              returnKeyType="search"
              onSubmitEditing={go}
              selectionColor={C.accent}
              accessibilityLabel="Describe what you are in the mood for"
              style={[sans(17, 'medium', C.ink, { lineHeight: 23 }), { flex: 1, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10, maxHeight: 96 }]}
            />
            {text.length > 0 && (
              <Pressable accessibilityRole="button" accessibilityLabel="Clear" hitSlop={8} onPress={() => setText('')} style={{ width: 44, height: 48, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="close" size={19} color={C.dim} />
              </Pressable>
            )}
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 8, gap: 8 }}>
            <Chip label={n === 0 ? 'Filters' : `Filters · ${n}`} icon="options-outline" active={n > 0} onPress={sheet} />
            <Chip
              label="My services"
              icon="tv-outline"
              active={r.streamingOnly}
              onPress={() => {
                if (!Object.keys(app.settings.providers).length) return ui.toast('Pick your services in Settings first');
                r.streamingOnly = !r.streamingOnly;
                app.changed();
              }}
            />
            {(r.genres.length > 0 || r.notGenres.length > 0) && <Chip label={[...r.genres.map((g) => GENRES[g]), ...r.notGenres.map((g) => `no ${GENRES[g]}`)].join(', ')} onPress={sheet} />}
            {(r.yearMin !== undefined || r.yearMax !== undefined) && <Chip label={`${r.yearMin ?? '…'}–${r.yearMax ?? 'now'}`} onPress={sheet} />}
            {(r.runMin !== undefined || r.runMax !== undefined) && (
              <Chip label={r.runMax !== undefined && r.runMin === undefined ? `≤ ${runtimeLabel(r.runMax)}` : `${r.runMin ?? 0}–${r.runMax ?? '∞'} min`} onPress={sheet} />
            )}
            {r.langs.length > 0 && <Chip label={r.langs.map((l) => LANGUAGES[l] ?? l).join(', ')} onPress={sheet} />}
            {Math.abs(r.obscurity - 0.5) > 0.15 && <Chip label={r.obscurity < 0.5 ? 'Familiar' : 'Obscure'} onPress={sheet} />}
            {!r.personalize && <Chip label="Not personal" onPress={sheet} />}
            {!r.excludeWatched && <Chip label="Rewatches" onPress={sheet} />}
          </ScrollView>
          <BigButton label="Find films" icon="sparkles" onPress={go} color={C.accent} ink={C.accentInk} style={{ marginTop: 10, marginHorizontal: 2, marginBottom: 2 }} />
        </View>
      </View>
    </View>
  );
}

const Y0 = 1920;
const R0 = 60;
const R1 = 240;
const dialLabel = (o: number) => (o < 0.35 ? 'Familiar' : o > 0.65 ? 'Obscure' : 'Balanced');

/** Every discovery control in one sheet; changes apply immediately. */
export function FilterSheet() {
  useStore(app);
  const [allLangs, setAllLangs] = useState(false);
  const r = app.settings.request;
  const y1 = new Date().getFullYear();
  const set = (f: () => void) => {
    f();
    app.changed();
  };
  const toggle = <T,>(list: T[], v: T) => {
    const i = list.indexOf(v);
    if (i >= 0) list.splice(i, 1);
    else list.push(v);
  };
  const common = Object.keys(LANGUAGES).slice(0, 8);
  const langs = allLangs || r.langs.some((l) => !common.includes(l)) ? Object.keys(LANGUAGES) : common;
  const head = (title: string, value?: string) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 24, marginBottom: 10, paddingHorizontal: 2 }}>
      <Text style={[caps(), { flex: 1 }]} accessibilityRole="header">
        {title}
      </Text>
      {value && <Text style={sans(13, 'semi')}>{value}</Text>}
    </View>
  );
  const services = Object.values(app.settings.providers);
  return (
    <Sheet onClose={() => ui.openFilters(false)}>
      {head('GENRES', 'tap twice to exclude')}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {GENRE_IDS.map((g) => (
          <Chip
            key={g}
            label={GENRES[g]}
            active={r.genres.includes(g)}
            negative={r.notGenres.includes(g)}
            onPress={() =>
              set(() => {
                if (r.genres.includes(g)) {
                  toggle(r.genres, g);
                  r.notGenres.push(g);
                } else if (r.notGenres.includes(g)) toggle(r.notGenres, g);
                else r.genres.push(g);
              })
            }
          />
        ))}
      </View>
      {head('YEAR', r.yearMin === undefined && r.yearMax === undefined ? 'Any' : `${r.yearMin ?? Y0} – ${r.yearMax ?? 'now'}`)}
      <RangeSlider
        label="Release year"
        min={Y0}
        max={y1}
        low={r.yearMin ?? Y0}
        high={r.yearMax ?? y1}
        onChange={(lo, hi) =>
          set(() => {
            r.yearMin = lo <= Y0 ? undefined : lo;
            r.yearMax = hi >= y1 ? undefined : hi;
          })
        }
      />
      {head('LENGTH', r.runMin === undefined && r.runMax === undefined ? 'Any' : `${r.runMin === undefined ? '' : runtimeLabel(r.runMin)} – ${r.runMax === undefined ? '' : runtimeLabel(r.runMax)}`)}
      <RangeSlider
        label="Runtime"
        min={R0}
        max={R1}
        step={5}
        low={r.runMin ?? R0}
        high={r.runMax ?? R1}
        format={(v) => `${v} minutes`}
        onChange={(lo, hi) =>
          set(() => {
            r.runMin = lo <= R0 ? undefined : lo;
            r.runMax = hi >= R1 ? undefined : hi;
          })
        }
      />
      {head('ORIGINAL LANGUAGE')}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {langs.map((l) => (
          <Chip key={l} label={LANGUAGES[l]} active={r.langs.includes(l)} onPress={() => set(() => toggle(r.langs, l))} />
        ))}
        {langs.length < Object.keys(LANGUAGES).length && <Chip label="More" icon="add" onPress={() => setAllLangs(true)} />}
      </View>
      {head('FAMILIAR ↔ OBSCURE', dialLabel(r.obscurity))}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Icon name="flame-outline" size={19} color={C.dim} />
        <View style={{ flex: 1 }}>
          <RangeSlider label="Familiar to obscure" min={0} max={4} high={Math.round(r.obscurity * 4)} format={(v) => dialLabel(v / 4)} onChange={(_, hi) => set(() => (r.obscurity = hi / 4))} />
        </View>
        <Icon name="diamond-outline" size={19} color={C.dim} />
      </View>
      <View style={{ marginTop: 14 }}>
        <ToggleRow
          icon="tv-outline"
          label="Only on my services"
          sub={services.length ? services.slice(0, 4).join(' · ') : 'Pick services in Settings'}
          value={r.streamingOnly}
          onChange={services.length ? (v) => set(() => (r.streamingOnly = v)) : undefined}
        />
        <ToggleRow icon="finger-print" label="Personalize with my taste" value={r.personalize} onChange={(v) => set(() => (r.personalize = v))} />
        <ToggleRow icon="eye-off-outline" label="Hide films I have seen" value={r.excludeWatched} onChange={(v) => set(() => (r.excludeWatched = v))} />
      </View>
      <View style={{ flexDirection: 'row', gap: 12, marginTop: 18 }}>
        <BigButton label="Reset" color="rgba(255,255,255,0.12)" ink={C.ink} style={{ flex: 1 }} onPress={() => set(() => (app.settings.request = newRequest({ prompt: r.prompt })))} />
        <BigButton label="Done" style={{ flex: 1 }} onPress={() => ui.openFilters(false)} />
      </View>
    </Sheet>
  );
}
