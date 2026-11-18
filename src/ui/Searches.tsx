import React from 'react';
import { FlatList, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { discover } from '../app/discover';
import { tick } from '../app/platform';
import { useStore } from '../app/store';
import { ui } from '../app/ui';
import { SavedSearch, searchFilters, whenLabel } from '../core/history';

import { Blank, Icon, Poster } from './components';
import { C, display, sans } from './theme';

/** The Searches tab: earlier searches, newest first. Tap one to see its films again, without waiting. */
export function SearchesScreen() {
  useStore(discover);
  const insets = useSafeAreaInsets();
  const list = discover.searches;
  return (
    <FlatList
      data={list}
      keyExtractor={(e) => e.id}
      renderItem={({ item }) => <SearchCard e={item} current={item.id === discover.currentId} />}
      contentContainerStyle={{
        paddingTop: insets.top + 8,
        paddingHorizontal: 14,
        // Clear of the tab bar.
        paddingBottom: insets.bottom + 110,
        gap: 12,
        flexGrow: 1,
      }}
      ListHeaderComponent={
        // Same height and inset as the Library title, so the two line up when swiping.
        <View style={{ minHeight: 46, justifyContent: 'center', paddingHorizontal: 2, marginBottom: 6 }}>
          <Text style={display(34)} accessibilityRole="header">
            Searches
          </Text>
        </View>
      }
      ListEmptyComponent={<Blank icon="library-outline" title="Your searches will be kept here" action="Start a search" onAction={() => ui.setTab('discover')} />}
    />
  );
}

function SearchCard({ e, current }: { e: SavedSearch; current: boolean }) {
  const { width } = useWindowDimensions();
  const picks = e.session.picks;
  const n = 5;
  const posterW = (width - 28 - 24 - 6 * (n - 1)) / n;
  // A search has no name: when it was made and what it was filtered by tell it apart.
  const when = whenLabel(e.at);
  const filters = searchFilters(e);
  const count = picks.length === 1 ? '1 film' : `${picks.length} films`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${when}. ${filters.length ? filters.join(', ') : 'No filters'}. ${count}.`}
      accessibilityHint="Shows these films again"
      onPress={() => {
        tick();
        ui.openSaved(e.id);
      }}
      style={({ pressed }) => ({
        backgroundColor: pressed ? '#1E1C1B' : C.card,
        borderRadius: 22,
        borderWidth: 1,
        borderColor: current ? C.accentLine : C.line,
        padding: 12,
      })}>
      <View style={{ flexDirection: 'row', gap: 6 }} importantForAccessibility="no-hide-descendants">
        {picks.slice(0, n).map((p) => (
          <Poster key={p.film.id} path={p.film.poster} radius={8} size="w185" style={{ width: posterW, height: posterW * 1.5 }} />
        ))}
      </View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          marginTop: 12,
          gap: 8,
        }}>
        <View style={{ flex: 1, paddingLeft: 2 }}>
          <Text style={sans(15.5, 'bold', C.ink, { lineHeight: 21 })} numberOfLines={1}>
            {when}
            <Text style={sans(15.5, 'medium', C.dim)}>{`  ·  ${count}`}</Text>
          </Text>
          <Text style={[sans(13.5, 'semi', filters.length ? C.ink : C.dim, { lineHeight: 19 }), { marginTop: 4 }]} numberOfLines={3}>
            {filters.length ? upFirst(filters.join('  ·  ')) : 'No filters'}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Delete the search from ${when}`}
          hitSlop={8}
          onPress={async () => {
            if (await ui.confirm('Delete this search?', `The search from ${when} and its ${count} are removed from this list. Your library stays as it is.`, 'Delete', true)) discover.forget(e.id);
          }}
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            alignItems: 'center',
            justifyContent: 'center',
          }}>
          <Icon name="trash-outline" size={18} color={C.faint} />
        </Pressable>
      </View>
    </Pressable>
  );
}

/** "new releases · Thriller" → "New releases · Thriller": the line starts like a title. */
const upFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
