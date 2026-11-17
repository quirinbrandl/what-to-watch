import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { tick } from '../app/platform';
import { app, useStore } from '../app/store';
import { ui } from '../app/ui';
import { Entry, Film, labelOf } from '../core/models';

import { Blank, Chip, Icon, IconName, Overlay, Poster, RoundButton, Stars } from './components';
import { importZipFlow } from './Settings';
import { C, sans, serif } from './theme';

const GAP = 8;

export function FilmTile({ film, entry, width }: { film: Film; entry?: Entry; width: number }) {
  const rating = entry?.rating;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${labelOf(film)}${rating !== undefined ? `, rated ${rating} stars` : ''}`}
      onPress={() => {
        tick();
        ui.openFilm(film);
      }}
      style={{ width, height: width * 1.5 }}>
      <Poster path={film.poster} radius={12} style={{ flex: 1 }} />
      {film.poster == null && (
        <View style={{ position: 'absolute', left: 6, right: 6, top: 0, bottom: 0, justifyContent: 'center' }}>
          <Text style={[serif(15, C.dim), { textAlign: 'center' }]} numberOfLines={4}>
            {film.title}
          </Text>
        </View>
      )}
      {(rating !== undefined || entry?.liked) && (
        <LinearGradient
          colors={['transparent', 'rgba(0,0,0,0.85)']}
          style={{ position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 8, paddingTop: 18, paddingBottom: 7, borderBottomLeftRadius: 12, borderBottomRightRadius: 12, flexDirection: 'row', alignItems: 'center' }}>
          {rating !== undefined && <Stars value={rating} size={12} />}
          <View style={{ flex: 1 }} />
          {entry?.liked && <Icon name="heart" size={11} color="#FF7A6B" />}
        </LinearGradient>
      )}
    </Pressable>
  );
}

const TABS: [IconName, string][] = [
  ['star', 'Rated'],
  ['bookmark', 'Watchlist'],
  ['eye', 'Seen'],
];

/** The user's films as a poster grid: rated, watchlist, seen. */
export function LibraryScreen() {
  useStore(app);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [tab, setTab] = useState(0);
  const [byRating, setByRating] = useState(false);
  const lib = app.lib;
  const rev = lib.rev;
  const lists = useMemo(
    () => [
      lib.rated.sort((a, b) => (byRating && b.rating! !== a.rating! ? b.rating! - a.rating! : (b.ratingAt ?? 0) - (a.ratingAt ?? 0))),
      lib.watchlist.sort((a, b) => (b.watchlistAt ?? 0) - (a.watchlistAt ?? 0)),
      lib.watched.sort((a, b) => (b.watchedAt ?? 0) - (a.watchedAt ?? 0)),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rev, byRating, lib.entries.size],
  );
  const items = lists[tab].filter((e) => app.film(e.id));
  const tile = (width - 24 - GAP * 2) / 3;
  return (
    <FlatList
      data={items}
      key={tab}
      numColumns={3}
      keyExtractor={(e) => String(e.id)}
      renderItem={({ item }) => <FilmTile film={app.film(item.id)!} entry={item} width={tile} />}
      columnWrapperStyle={{ gap: GAP, paddingHorizontal: 12 }}
      contentContainerStyle={{ gap: GAP, paddingBottom: insets.bottom + 110, flexGrow: 1 }}
      initialNumToRender={15}
      windowSize={7}
      refreshControl={<RefreshControl refreshing={app.syncing} onRefresh={() => void app.syncLetterboxd()} tintColor={C.ink} colors={[C.bg]} progressBackgroundColor={C.ink} progressViewOffset={insets.top} />}
      ListHeaderComponent={
        <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 16, paddingBottom: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={[serif(40), { flex: 1 }]} accessibilityRole="header">
              Library
            </Text>
            {tab === 0 && <RoundButton icon={byRating ? 'star' : 'time-outline'} label={byRating ? 'Sorted by rating' : 'Sorted by date'} size={46} onPress={() => setByRating(!byRating)} />}
            <RoundButton icon="search" label="Find a film" size={46} onPress={() => ui.openSearch()} />
          </View>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
            {TABS.map(([icon, label], i) => (
              <Chip key={label} label={`${label}  ${lists[i].length}`} icon={icon} active={tab === i} onPress={() => setTab(i)} />
            ))}
          </View>
        </View>
      }
      ListEmptyComponent={
        lib.entries.size === 0 ? (
          <Blank icon="film-outline" title="Your films will live here" action="Import Letterboxd" onAction={() => void importZipFlow()} />
        ) : (
          <Blank icon="file-tray-outline" title="Nothing here yet" />
        )
      }
    />
  );
}

/** Find any film on TMDB to rate it or put it on the watchlist. */
export function SearchScreen() {
  useStore(app);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [results, setResults] = useState<Film[] | undefined>();
  const [busy, setBusy] = useState(false);
  const query = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const search = (text: string) => {
    const q = (query.current = text.trim());
    clearTimeout(timer.current);
    if (q.length < 2) return setResults(undefined);
    timer.current = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await app.tmdb.search(q);
        if (query.current === q) setResults(r.filter((f) => f.poster));
      } catch {
        if (query.current === q) setResults([]);
      } finally {
        setBusy(false);
      }
    }, 350);
  };

  const tile = (width - 24 - GAP * 2) / 3;
  return (
    <Overlay>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: insets.top + 8, paddingLeft: 10, paddingRight: 16, paddingBottom: 10 }}>
        <RoundButton icon="arrow-back" label="Back" size={46} onPress={() => ui.openSearch(false)} />
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: C.soft, borderRadius: 24, paddingHorizontal: 18, height: 48 }}>
          <TextInput
            autoFocus
            onChangeText={search}
            placeholder="Film title"
            placeholderTextColor={C.faint}
            returnKeyType="search"
            selectionColor={C.accent}
            accessibilityLabel="Film title"
            style={[sans(17), { flex: 1, paddingVertical: 0 }]}
          />
          {busy && <ActivityIndicator color={C.dim} size="small" />}
        </View>
      </View>
      {results === undefined ? (
        <Blank icon="search" title="Rate or save any film" />
      ) : results.length === 0 ? (
        <Blank icon="sad-outline" title="No film found" />
      ) : (
        <FlatList
          data={results}
          numColumns={3}
          keyExtractor={(f) => String(f.id)}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          renderItem={({ item }) => <FilmTile film={item} entry={app.lib.get(item.id)} width={tile} />}
          columnWrapperStyle={{ gap: GAP, paddingHorizontal: 12 }}
          contentContainerStyle={{ gap: GAP, paddingBottom: insets.bottom + 24 }}
        />
      )}
    </Overlay>
  );
}
