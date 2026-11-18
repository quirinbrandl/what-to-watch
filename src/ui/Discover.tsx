import React, { useContext, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { ScrollView as GestureScrollView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { discover } from '../app/discover';
import { tick } from '../app/platform';
import { REGIONS, app, useStore } from '../app/store';
import { ui } from '../app/ui';
import { hardFilterCount, newRequest } from '../core/engine/request';
import { LEVELS, levelOf as level } from '../core/history';
import { GENRES, GENRE_IDS, LANGUAGES, Prov } from '../core/models';
import { pickableServices } from '../core/services';

import { BigButton, Chip, Icon, PosterWall, ProviderLogo, RangeSlider, Sheet, StopSlider, TabSwipe, ToggleRow, Wordmark } from './components';
import { C, caps, runtimeLabel, sans } from './theme';

/** Home: your films as a living backdrop, one thumb-reach composer. */
export function DiscoverScreen() {
  useStore(app);
  useStore(discover);
  const insets = useSafeAreaInsets();
  const tabs = useContext(TabSwipe);
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
  const services = app.settings.services;
  const lv = level(r.obscurity);
  return (
    <View style={{ flex: 1 }}>
      <PosterWall posters={wall} />
      <View style={{ flex: 1, paddingTop: insets.top + 10, paddingHorizontal: 16, paddingBottom: insets.bottom + 86 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Wordmark size={24} mark />
        </View>
        <View style={{ flex: 1 }} />
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
          {/* Swiping along the chips scrolls them; it does not switch tabs. */}
          <GestureScrollView horizontal block={tabs} showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 8, gap: 8 }}>
            <Chip label={n === 0 ? 'Filters' : `Filters · ${n}`} icon="options-outline" active={n > 0} onPress={sheet} />
            <Chip
              label={services.length ? services.map((s) => s.name).join(', ') : 'Any service'}
              icon={services.length ? undefined : 'tv-outline'}
              leading={services.length ? <ServiceStack list={services} /> : undefined}
              onPress={sheet}
            />
            {(r.genres.length > 0 || r.notGenres.length > 0) && <Chip label={[...r.genres.map((g) => GENRES[g]), ...r.notGenres.map((g) => `no ${GENRES[g]}`)].join(', ')} onPress={sheet} />}
            {(r.yearMin !== undefined || r.yearMax !== undefined) && <Chip label={`${r.yearMin ?? '…'}–${r.yearMax ?? 'now'}`} onPress={sheet} />}
            {(r.runMin !== undefined || r.runMax !== undefined) && (
              <Chip label={r.runMax !== undefined && r.runMin === undefined ? `≤ ${runtimeLabel(r.runMax)}` : `${r.runMin ?? 0}–${r.runMax ?? '∞'} min`} onPress={sheet} />
            )}
            {r.langs.length > 0 && <Chip label={r.langs.map((l) => LANGUAGES[l] ?? l).join(', ')} onPress={sheet} />}
            {lv !== 2 && <Chip label={LEVELS[lv]} onPress={sheet} />}
            {!r.personalize && <Chip label="Not personal" onPress={sheet} />}
            {!r.excludeWatched && <Chip label="Rewatches" onPress={sheet} />}
            {r.excludeWatchlist && <Chip label="Not on watchlist" onPress={sheet} />}
            {r.recent && <Chip label="New releases" onPress={sheet} />}
          </GestureScrollView>
          <BigButton label="Find films" icon="search" onPress={go} color={C.accent} ink={C.accentInk} style={{ marginTop: 10, marginHorizontal: 2, marginBottom: 2 }} />
        </View>
      </View>
    </View>
  );
}

/** Small overlapping service logos for a chip. */
function ServiceStack({ list }: { list: { logo: string | null; name: string }[] }) {
  return (
    <View style={{ flexDirection: 'row' }}>
      {list.slice(0, 3).map((s, i) => (
        <View key={s.name} style={{ marginLeft: i ? -7 : -4, borderRadius: 7, borderWidth: 1.5, borderColor: C.sheet }}>
          <ProviderLogo logo={s.logo} name={s.name} size={20} />
        </View>
      ))}
    </View>
  );
}

export async function pickRegion(): Promise<void> {
  const items = Object.entries(REGIONS)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([key, label]) => ({ key, label }));
  const r = await ui.choose('Country', items, app.settings.region);
  if (r) app.setRegion(r);
}

/** The country, and the streaming services to limit this search to. */
function WhereToWatch() {
  useStore(app);
  const { width } = useWindowDimensions();
  // Five to a row, each logo with its name under it: several services share a logo.
  const tileW = Math.floor((width - 40 - 4 * 8) / 5);
  const region = app.settings.region;
  const picked = app.settings.services;
  const [catalog, setCatalog] = useState<Prov[] | undefined>();
  const [retry, setRetry] = useState(0);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let alive = true;
    setCatalog(undefined);
    app
      .providerCatalog(region)
      .then((c) => alive && setCatalog(pickableServices(c)))
      .catch(() => alive && setCatalog([]));
    return () => {
      alive = false;
    };
  }, [region, retry]);
  const on = (p: Prov) => picked.some((x) => x.id === p.id);
  let grid: React.ReactNode;
  if (!catalog) grid = <ActivityIndicator color={C.dim} style={{ height: 70 }} />;
  else if (!catalog.length) {
    grid = (
      <Pressable accessibilityRole="button" onPress={() => setRetry(retry + 1)} style={{ height: 60, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 }}>
        <Icon name="refresh" size={16} color={C.dim} />
        <Text style={sans(13.5, 'semi', C.dim)}>Could not load services — retry</Text>
      </Pressable>
    );
  } else {
    // TMDB orders services by how much people use them there; picked ones first.
    const rest = catalog.filter((p) => !on(p));
    const shown = all ? rest : rest.slice(0, Math.max(0, 11 - picked.length));
    grid = (
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 8, rowGap: 12 }}>
        {[...catalog.filter(on), ...shown].map((p) => (
          <Pressable
            key={p.id}
            accessibilityRole="checkbox"
            accessibilityLabel={p.name}
            accessibilityState={{ checked: on(p) }}
            onPress={() => {
              tick();
              app.toggleService(p);
            }}
            style={{ width: tileW, alignItems: 'center' }}>
            <View style={{ padding: 3, borderRadius: 17, borderWidth: 2.4, borderColor: on(p) ? C.accent : 'transparent', opacity: on(p) ? 1 : 0.6 }}>
              <ProviderLogo logo={p.logo} name={p.name} size={48} />
            </View>
            <Text style={[sans(10.5, 'semi', on(p) ? C.ink : C.dim, { lineHeight: 13 }), { marginTop: 4, textAlign: 'center', alignSelf: 'stretch' }]} numberOfLines={2}>
              {p.name}
            </Text>
          </Pressable>
        ))}
        {shown.length < rest.length && (
          <Pressable accessibilityRole="button" accessibilityLabel="Show all services" onPress={() => setAll(true)} style={{ width: tileW, alignItems: 'center' }}>
            <View style={{ width: 58.8, height: 58.8, borderRadius: 17, borderWidth: 1, borderColor: C.line, backgroundColor: C.soft, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="add" size={20} color={C.ink} />
            </View>
            <Text style={[sans(10.5, 'semi', C.dim, { lineHeight: 13 }), { marginTop: 4, textAlign: 'center', alignSelf: 'stretch' }]}>All services</Text>
          </Pressable>
        )}
      </View>
    );
  }
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 24, marginBottom: 10, paddingHorizontal: 2 }}>
        <Text style={[caps(), { flex: 1 }]} accessibilityRole="header">
          WHERE TO WATCH
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel={`Country: ${REGIONS[region] ?? region}. Change`} onPress={() => void pickRegion()} hitSlop={10} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Icon name="globe-outline" size={14} color={C.ink} />
          <Text style={sans(13, 'semi')}>{REGIONS[region] ?? region}</Text>
          <Icon name="chevron-down" size={13} color={C.dim} />
        </Pressable>
      </View>
      {grid}
      <Text style={[sans(12.5, 'medium', C.dim, { lineHeight: 17 }), { marginTop: 10, paddingHorizontal: 2 }]}>
        {picked.length ? `Only films included with ${picked.map((x) => x.name).join(', ')}.` : 'Pick the services you can use tonight to see only films on them. None picked: anywhere.'}
      </Text>
      {picked.length > 0 && (
        <Pressable accessibilityRole="button" onPress={() => app.setServices([])} hitSlop={8} style={{ alignSelf: 'flex-start', marginTop: 6, paddingVertical: 6, paddingHorizontal: 2 }}>
          <Text style={sans(13, 'semi', C.accent)}>Any service</Text>
        </Pressable>
      )}
    </View>
  );
}

const Y0 = 1920;
const R0 = 60;
const R1 = 240;

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
      <WhereToWatch />
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
      <StopSlider title="MAINSTREAM ↔ NICHE" names={LEVELS} ends={['Big, well-known films', 'Films few have seen']} value={level(r.obscurity)} onChange={(i) => set(() => (r.obscurity = i / 4))} />
      {head('ORIGINAL LANGUAGE')}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {langs.map((l) => (
          <Chip key={l} label={LANGUAGES[l]} active={r.langs.includes(l)} onPress={() => set(() => toggle(r.langs, l))} />
        ))}
        {langs.length < Object.keys(LANGUAGES).length && <Chip label="More" icon="add" onPress={() => setAllLangs(true)} />}
      </View>
      <View style={{ marginTop: 14 }}>
        <ToggleRow icon="finger-print" label="Personalize with my taste" value={r.personalize} onChange={(v) => set(() => (r.personalize = v))} />
        <ToggleRow icon="eye-off-outline" label="Hide films I have seen" value={r.excludeWatched} onChange={(v) => set(() => (r.excludeWatched = v))} />
        <ToggleRow icon="bookmark-outline" label="Hide films on my watchlist" sub="For something you had not thought of yet" value={r.excludeWatchlist} onChange={(v) => set(() => (r.excludeWatchlist = v))} />
        <ToggleRow icon="calendar-outline" label="Include new releases" sub="Since mid-2024, too new for ChatGPT" value={r.recent} onChange={(v) => set(() => (r.recent = v))} />
      </View>
      <View style={{ flexDirection: 'row', gap: 12, marginTop: 18 }}>
        <BigButton
          label="Reset"
          color="rgba(255,255,255,0.12)"
          ink={C.ink}
          style={{ flex: 1 }}
          onPress={() => {
            app.settings.request = newRequest({ prompt: r.prompt });
            app.setServices([]);
          }}
        />
        <BigButton label="Done" style={{ flex: 1 }} onPress={() => ui.openFilters(false)} />
      </View>
    </Sheet>
  );
}
