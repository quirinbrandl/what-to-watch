import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { app, useStore } from '../app/store';
import { ui } from '../app/ui';
import { Film, genreNames, streamable, yearOf } from '../core/models';

import { BigButton, Chip, Icon, Poster, ProviderLogo, ScoreRing, Sheet, StarInput } from './components';
import { C, runtimeLabel, sans, serif } from './theme';

export const metaLine = (f: Film): string => [yearOf(f) ? String(yearOf(f)) : '', runtimeLabel(f.runtime), genreNames(f).slice(0, 3).join(', ')].filter(Boolean).join('  ·  ');

/** Where a film can be streamed in the user's region; their own services first. */
export function ProviderRow({ film }: { film: Film }) {
  const sv = app.services;
  const p = film.prov;
  if (!p || p.region !== sv.region) return null;
  // TMDB lists plan variants separately ("Netflix Standard with Ads"); show each service once.
  const all = streamable(p);
  const list = all
    .filter((x) => !all.some((y) => y !== x && x.name.toLowerCase().startsWith(`${y.name.toLowerCase()} `)))
    .sort((a, b) => (sv.has(b) ? 1 : 0) - (sv.has(a) ? 1 : 0));
  if (!list.length) {
    const paid = [...new Map([...p.rent, ...p.buy].map((x) => [x.id, x])).values()];
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="tv-outline" size={15} color={C.faint} />
        <Text style={sans(12.5, 'medium', C.dim)}>{paid.length ? 'Rent or buy' : `Not streaming in ${sv.region}`}</Text>
        {paid.slice(0, 4).map((x) => (
          <View key={x.id} style={{ opacity: 0.7 }}>
            <ProviderLogo logo={x.logo} name={x.name} size={24} />
          </View>
        ))}
      </View>
    );
  }
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {list.slice(0, 6).map((x) => (
        <View key={x.id} style={{ padding: 2, borderRadius: 11, borderWidth: 1.5, borderColor: sv.has(x) ? C.accent : 'transparent' }}>
          <ProviderLogo logo={x.logo} name={x.name} size={32} />
        </View>
      ))}
    </View>
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
