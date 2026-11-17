import React, { useEffect, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';

import { app, useStore } from '../app/store';
import { ui } from '../app/ui';
import { Film, Prov, genreNames, yearOf } from '../core/models';

import { BigButton, Chip, Icon, Poster, ProviderLogo, ScoreRing, Sheet, StarInput } from './components';
import { C, caps, runtimeLabel, sans, serif } from './theme';

export const metaLine = (f: Film): string => [yearOf(f) ? String(yearOf(f)) : '', runtimeLabel(f.runtime), genreNames(f).slice(0, 3).join(', ')].filter(Boolean).join('  ·  ');

/**
 * Where a film can be watched in the user's region, grouped by what it costs:
 * included in a subscription, free, or rent/buy. The user's own services come
 * first and carry a ring. Tapping opens TMDB's "watch" page for the film, which
 * links on to each service (data: JustWatch via TMDB; it has no prices and no
 * direct per-service links).
 */
export function ProviderRow({ film }: { film: Film }) {
  const sv = app.services;
  const p = film.prov;
  if (!p || p.region !== sv.region) return null;
  const used = new Set<string>();
  // TMDB lists plan variants separately ("Netflix Standard with Ads"); show each service once.
  const group = (list: Prov[]): Prov[] =>
    list
      .filter((x) => !list.some((y) => y !== x && x.name.toLowerCase().startsWith(`${y.name.toLowerCase()} `)))
      .filter((x) => !used.has(x.name) && used.add(x.name))
      .sort((a, b) => (sv.has(b) ? 1 : 0) - (sv.has(a) ? 1 : 0))
      .slice(0, 5);
  const groups: [string, Prov[]][] = [
    ['Subscription', group(p.flat)],
    ['Free', group([...p.free, ...p.ads])],
    ['Rent / buy', group([...p.rent, ...p.buy])],
  ];
  const shown = groups.filter(([, l]) => l.length > 0);
  const link = p.link;
  const summary = shown.length ? shown.map(([label, l]) => `${label}: ${l.map((x) => x.name).join(', ')}`).join('. ') : `Not available in ${sv.region}`;
  return (
    <Pressable
      accessibilityRole={link ? 'link' : 'text'}
      accessibilityLabel={`Where to watch. ${summary}.`}
      accessibilityHint={link ? 'Opens the list of offers' : undefined}
      disabled={!link}
      onPress={() => link && void Linking.openURL(link)}
      // Keep this tap from also flipping the card it sits on.
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      style={({ pressed }) => ({ backgroundColor: pressed ? 'rgba(255,255,255,0.12)' : C.soft, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 10, gap: 8 })}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text style={[caps(), { flex: 1 }]}>WHERE TO WATCH</Text>
        {link && <Icon name="open-outline" size={14} color={C.dim} />}
      </View>
      {shown.length === 0 && <Text style={sans(13, 'medium', C.dim)}>Not available to stream, rent or buy in {sv.region}</Text>}
      {shown.map(([label, list]) => (
        <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={[sans(12.5, 'semi', label === 'Rent / buy' ? C.dim : C.ink), { width: 88 }]}>{label}</Text>
          <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {list.map((x) => (
              <View key={x.id} style={{ padding: 2, borderRadius: 10, borderWidth: 1.5, borderColor: sv.has(x) ? C.accent : 'transparent', opacity: label === 'Rent / buy' ? 0.75 : 1 }}>
                <ProviderLogo logo={x.logo} name={x.name} size={28} />
              </View>
            ))}
          </View>
        </View>
      ))}
    </Pressable>
  );
}

/** Everything you can do with one film: rate, watchlist, seen, dismiss. */
export function FilmSheet() {
  useStore(app);
  const open = useStore(ui).film;
  const [full, setFull] = useState<Film | undefined>();
  const id = open?.film.id;
  useEffect(() => {
    setFull(undefined);
    if (id === undefined) return;
    let alive = true;
    app.ensureFilm(id).then((f) => alive && f && setFull(f));
    return () => {
      alive = false;
    };
  }, [id]);
  if (!open) return null;
  const f = full ?? open.film;
  const e = app.lib.get(f.id);
  return (
    <Sheet onClose={() => ui.openFilm(undefined)}>
      <View style={{ flexDirection: 'row', gap: 18, marginTop: 12 }}>
        <Poster path={f.poster} label={f.title} radius={14} style={{ width: 112, height: 168 }} />
        <View style={{ flex: 1 }}>
          <Text style={serif(30)} numberOfLines={3}>
            {f.title}
          </Text>
          <Text style={[sans(13, 'medium', C.dim, { lineHeight: 19 }), { marginTop: 8 }]}>{metaLine(f)}</Text>
          {f.directors.length > 0 && <Text style={[sans(13, 'semi'), { marginTop: 4 }]}>{f.directors.slice(0, 2).join(', ')}</Text>}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 }}>
            <ScoreRing film={f} size={42} />
            <Text style={sans(11, 'medium', C.dim, { lineHeight: 14 })}>{'TMDB\nuser score'}</Text>
          </View>
        </View>
      </View>
      <View style={{ alignItems: 'center', marginTop: 26 }}>
        <StarInput value={e?.rating} onChange={(v) => app.rate(f.id, v)} size={50} />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 18 }}>
        <Chip
          label="Watchlist"
          icon={e?.watchlist ? 'bookmark' : 'bookmark-outline'}
          active={e?.watchlist === true}
          onPress={e?.watched ? undefined : () => app.setWatchlist(f.id, !(e?.watchlist ?? false))}
        />
        <Chip label="Seen" icon={e?.watched ? 'eye' : 'eye-outline'} active={e?.watched === true} onPress={() => app.setWatched(f.id, !(e?.watched ?? false))} />
        <Chip label="Not for me" icon="ban-outline" negative={e?.notInterested === true} onPress={() => app.setNotInterested(f.id, !(e?.notInterested ?? false))} />
      </View>
      <View style={{ marginTop: 24 }}>
        <ProviderRow film={f} />
      </View>
      {f.overview.length > 0 && <Text style={[sans(14.5, 'medium', C.dim, { lineHeight: 22 }), { marginTop: 20 }]}>{f.overview}</Text>}
      {open.moreLike && (
        <BigButton
          label="More like this"
          icon="sparkles"
          color="rgba(255,255,255,0.12)"
          ink={C.ink}
          style={{ marginTop: 26 }}
          onPress={() => {
            if (!app.hasLlm) return ui.toast('Sign in first — Settings → Account');
            ui.openFeed({ seed: f });
          }}
        />
      )}
    </Sheet>
  );
}
