import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import React, { ReactNode, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { discover } from '../app/discover';
import { files, tick } from '../app/platform';
import { PRIVACY_TEXT } from '../app/privacy';
import { REGIONS, app, useStore } from '../app/store';
import { apiKeyFlow, signInFlow, ui } from '../app/ui';
import { LbFormatError, cleanUsername } from '../core/letterboxd';
import { Prov, nowSec } from '../core/models';

import { BigButton, Icon, IconName, PosterRibbon, ProviderLogo } from './components';
import { C, caps, sans, display } from './theme';

export const VERSION = '1.0.0';

const ZIP_TYPES = ['application/zip', 'application/x-zip-compressed', 'application/x-zip', 'application/octet-stream'];

/** Letterboxd offers its data download only on the website, under Settings → Data. Its apps have no export. */
export const LB_EXPORT_URL = 'https://letterboxd.com/settings/data/';
export const LB_EXPORT_STEPS = [
  'Open letterboxd.com in your browser and sign in. The Letterboxd app has no export.',
  'Go to Settings, then Data, and tap Export your data.',
  'Come back here and choose the ZIP file it downloaded.',
];
export const openLetterboxdExport = () => void Linking.openURL(LB_EXPORT_URL).catch(() => ui.toast('Could not open the browser'));

/** The numbered how-to for getting your data out of Letterboxd. */
export function ExportSteps() {
  return (
    <View style={{ gap: 9 }} accessible accessibilityLabel={`How to get your Letterboxd data. ${LB_EXPORT_STEPS.map((t, i) => `Step ${i + 1}: ${t}`).join(' ')}`}>
      {LB_EXPORT_STEPS.map((t, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 10 }}>
          <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.16)', alignItems: 'center', justifyContent: 'center' }}>
            <Text style={sans(11.5, 'bold', C.ink)}>{i + 1}</Text>
          </View>
          <Text style={[sans(13.5, 'medium', C.dim, { lineHeight: 19 }), { flex: 1 }]}>{t}</Text>
        </View>
      ))}
    </View>
  );
}

/** Picks the ZIP file downloaded from Letterboxd and imports it. Progress shows in <ImportOverlay/>. */
export async function importZipFlow(): Promise<boolean> {
  let picked: DocumentPicker.DocumentPickerResult;
  try {
    picked = await DocumentPicker.getDocumentAsync({ type: ZIP_TYPES, copyToCacheDirectory: true });
  } catch {
    ui.toast('Could not open the file picker');
    return false;
  }
  if (picked.canceled) return false;
  try {
    await app.importZip(await files.bytes(picked.assets[0].uri));
    ui.toast(`${app.lib.rated.length} ratings · ${app.lib.watchlist.length} on your watchlist`);
    return true;
  } catch (e) {
    ui.toast(e instanceof LbFormatError ? e.message : 'The import did not finish. Check your connection and try again.');
    return false;
  }
}

/** Full-screen progress while a Letterboxd export is matched to TMDB. */
export function ImportOverlay() {
  const p = useStore(app).importing;
  if (!p) return null;
  const even = p.posters.filter((_, i) => i % 2 === 0);
  const odd = p.posters.filter((_, i) => i % 2 === 1);
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.95)', justifyContent: 'center' }]} accessibilityViewIsModal>
      <View style={{ height: 310, justifyContent: 'center', gap: 10 }}>
        {p.posters.length >= 4 && (
          <>
            <PosterRibbon posters={even} height={150} speed={34} />
            <PosterRibbon posters={odd} height={150} speed={26} reverse />
          </>
        )}
      </View>
      <View style={{ alignItems: 'center', marginTop: 40 }} accessible accessibilityLiveRegion="polite" accessibilityLabel={`${p.label}, ${p.done} of ${p.total}`}>
        <Text style={display(27)}>{p.label}</Text>
        <View style={{ width: 220, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.14)', marginTop: 16, overflow: 'hidden' }}>
          <View style={{ width: `${p.total ? (p.done / p.total) * 100 : 0}%`, height: 4, backgroundColor: C.accent }} />
        </View>
        <Text style={[sans(13, 'medium', C.dim), { marginTop: 10 }]}>
          {p.done} / {p.total}
        </Text>
      </View>
    </View>
  );
}

export async function pickRegion(): Promise<void> {
  const items = Object.entries(REGIONS)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([key, label]) => ({ key, label }));
  const r = await ui.choose('Region', items, app.settings.region);
  if (r) app.setRegion(r);
}

/** Logos of the region's streaming services; tap to mark the ones you have. */
export function ServicesGrid() {
  useStore(app);
  const region = app.settings.region;
  const [catalog, setCatalog] = useState<Prov[] | undefined>();
  const [failed, setFailed] = useState(0);
  useEffect(() => {
    let alive = true;
    setCatalog(undefined);
    app
      .providerCatalog()
      .then((c) => alive && setCatalog(c))
      .catch(() => alive && setCatalog([]));
    return () => {
      alive = false;
    };
  }, [region, failed]);
  if (!catalog) return <ActivityIndicator color={C.dim} style={{ height: 120 }} />;
  if (!catalog.length) {
    return (
      <Pressable accessibilityRole="button" onPress={() => setFailed(failed + 1)} style={{ height: 80, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 }}>
        <Icon name="refresh" size={16} color={C.dim} />
        <Text style={sans(13.5, 'semi', C.dim)}>Could not load services — retry</Text>
      </Pressable>
    );
  }
  const mine = app.settings.providers;
  const list = [...catalog.filter((p) => p.id in mine), ...catalog.filter((p) => !(p.id in mine)).slice(0, 28)];
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
      {list.map((p) => {
        const on = p.id in mine;
        return (
          <Pressable
            key={p.id}
            accessibilityRole="checkbox"
            accessibilityLabel={p.name}
            accessibilityState={{ checked: on }}
            onPress={() => {
              tick();
              app.toggleProvider(p);
            }}
            style={{ padding: 3, borderRadius: 17, borderWidth: 2.4, borderColor: on ? C.accent : 'transparent', opacity: on ? 1 : 0.55 }}>
            <ProviderLogo logo={p.logo} name={p.name} size={52} />
          </Pressable>
        );
      })}
    </View>
  );
}

function ago(sec?: number): string {
  if (sec === undefined) return 'never';
  const d = nowSec() - sec;
  if (d < 90) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86400)} d ago`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View>
      <Text style={[caps(), { marginTop: 26, marginBottom: 10, marginHorizontal: 6 }]} accessibilityRole="header">
        {title}
      </Text>
      <View style={{ backgroundColor: C.card, borderRadius: 22, borderWidth: 1, borderColor: C.line, overflow: 'hidden' }}>{children}</View>
    </View>
  );
}

function Item(props: { icon: IconName; title: string; sub?: string; onPress?: () => void; danger?: boolean; warn?: boolean; busy?: boolean; external?: boolean }) {
  const { icon, title, sub, onPress, danger, warn, busy, external } = props;
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={sub ? `${title}, ${sub}` : title}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => ({ minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: pressed ? C.soft : 'transparent' })}>
      <Icon name={icon} size={21} color={warn ? C.accent : danger ? C.danger : C.dim} />
      <View style={{ flex: 1 }}>
        <Text style={sans(15.5, 'semi', danger ? C.danger : C.ink)}>{title}</Text>
        {sub && <Text style={[sans(12.5, 'medium', warn ? C.accent : C.dim, { lineHeight: 17 }), { marginTop: 2 }]}>{sub}</Text>}
      </View>
      {busy ? <ActivityIndicator color={C.dim} size="small" /> : onPress ? <Icon name={external ? 'open-outline' : 'chevron-forward'} size={17} color={C.faint} /> : null}
    </Pressable>
  );
}

const LICENSES = `WhatToWatch is open source under the MIT License.

Fonts: Anton and Manrope, SIL Open Font License 1.1.

Built with React Native, Expo, Reanimated, react-native-svg, fflate and noble-hashes (MIT License), and Ionicons (MIT License).

Film data and images: TMDB. Streaming availability: JustWatch.`;

export function SettingsScreen() {
  useStore(app);
  const insets = useSafeAreaInsets();
  const lib = app.lib;
  const s = app.settings;
  const modelName = s.model ? app.models.find((m) => m.slug === s.model)?.name ?? s.model : 'Automatic';

  const editUsername = async () => {
    const v = await ui.ask('Letterboxd username', { initial: lib.lbUsername ?? '', hint: 'username' });
    if (v === undefined) return;
    if (!v.trim()) app.setUsername(undefined);
    else if (!cleanUsername(v)) ui.toast('That does not look like a username');
    else app.setUsername(v);
  };
  const pickModel = async () => {
    if (!app.models.length) await app.loadModels();
    const key = await ui.choose('Model', [{ key: '', label: 'Automatic', sub: "Your account's default model" }, ...app.models.map((m) => ({ key: m.slug, label: m.name }))], s.model ?? '');
    if (key === undefined) return;
    s.model = key || undefined;
    app.changed();
  };
  const exportBackup = async () => {
    try {
      const uri = await files.temp(`what-to-watch-${new Date().toISOString().slice(0, 10)}.json`, app.backupJson());
      await Sharing.shareAsync(uri, { mimeType: 'application/json', dialogTitle: 'Save backup' });
    } catch {
      ui.toast('Backup could not be created');
    }
  };
  const restoreBackup = async () => {
    try {
      const picked = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'text/plain', 'application/octet-stream'], copyToCacheDirectory: true });
      if (picked.canceled) return;
      if (!(await ui.confirm('Restore backup?', 'This replaces the library on this device.', 'Restore'))) return;
      await app.restore(await files.text(picked.assets[0].uri));
      discover.clear();
      ui.toast('Backup restored');
    } catch (e) {
      ui.toast(e instanceof Error && e.message.includes('backup') ? e.message : 'Restore failed');
    }
  };

  return (
    <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 16, paddingBottom: insets.bottom + 110 }} showsVerticalScrollIndicator={false}>
      <Text style={display(34)} accessibilityRole="header">
        Settings
      </Text>
      <Section title="ACCOUNT">
        {s.useApiKey && app.apiKey ? (
          <Item icon="key-outline" title="OpenAI API key" sub="Billed to your API account" />
        ) : app.auth.signedIn ? (
          <>
            <Item icon="person-circle-outline" title={app.auth.email ?? 'ChatGPT'} sub="Using ChatGPT plan" />
            <Item icon="pie-chart-outline" title="Manage usage" external onPress={() => Linking.openURL('https://chatgpt.com/settings/usage')} />
            <Item
              icon="log-out-outline"
              title="Sign out"
              onPress={async () => {
                if (!(await ui.confirm('Sign out?', 'Your library stays on this device.', 'Sign out'))) return;
                if (!(await app.signOut())) ui.toast('Signed out here. To be sure, also disconnect the app in ChatGPT settings.');
              }}
            />
          </>
        ) : (
          <View style={{ padding: 12 }}>
            <BigButton label="Continue with ChatGPT" busy={app.auth.signingIn} onPress={() => void signInFlow()} />
          </View>
        )}
        {app.hasLlm && <Item icon="hardware-chip-outline" title="Model" sub={modelName} onPress={pickModel} />}
      </Section>
      <Section title="LETTERBOXD">
        <Item icon="at-outline" title={lib.lbUsername ?? 'Add your username'} sub={lib.lbUsername ? 'Username' : 'Keeps new diary entries in sync'} onPress={editUsername} />
        {lib.lbUsername && (
          <Item
            icon="sync-outline"
            title="Sync now"
            sub={app.syncing ? 'Checking your diary…' : app.syncError ?? `Synced ${ago(lib.lbLastSync)}${app.lastSyncAdded > 0 ? ` · ${app.lastSyncAdded} new` : ''}`}
            warn={!!app.syncError}
            busy={app.syncing}
            onPress={() => void app.syncLetterboxd()}
          />
        )}
        <Item
          icon="archive-outline"
          title="Import your Letterboxd data"
          sub={lib.lbImportAt === undefined ? 'Choose the ZIP file from letterboxd.com' : 'Ratings, watched, watchlist, likes, lists'}
          onPress={() => void importZipFlow()}
        />
        <Item
          icon="help-circle-outline"
          title="How to get your data"
          sub="On the Letterboxd website, not in its app"
          onPress={async () => {
            if (await ui.confirm('Get your data from Letterboxd', LB_EXPORT_STEPS.map((t, i) => `${i + 1}. ${t}`).join('\n\n'), 'Open letterboxd.com')) openLetterboxdExport();
          }}
        />
        {lib.lbGap && <Item icon="warning-outline" title="Some diary entries may be missing" sub="More than 50 were logged since the last sync. Import a fresh ZIP to fill the gap." warn />}
        {lib.unmatched.length > 0 && (
          <Item icon="help-circle-outline" title={`${lib.unmatched.length} not matched`} sub="Mostly series, which are not films on TMDB" onPress={() => void ui.info('Not matched', lib.unmatched.join('\n'))} />
        )}
      </Section>
      <Section title="WHERE YOU WATCH">
        <Item icon="globe-outline" title="Region" sub={REGIONS[s.region] ?? s.region} onPress={() => void pickRegion()} />
        <View style={{ paddingHorizontal: 12, paddingTop: 6, paddingBottom: 14 }}>
          <ServicesGrid />
        </View>
      </Section>
      <Section title="ADVANCED">
        <Item
          icon="key-outline"
          title="OpenAI API key"
          sub={!app.apiKey ? 'Use your own key instead of ChatGPT' : s.useApiKey ? 'In use' : 'Saved'}
          onPress={async () => {
            if (!app.apiKey) return void apiKeyFlow();
            if (await ui.confirm('Remove API key?', 'The key is deleted from this device.', 'Remove', true)) void app.setApiKey(undefined);
          }}
        />
      </Section>
      <Section title="YOUR DATA">
        <Item icon="share-outline" title="Export backup" sub="Library and settings, no credentials" onPress={exportBackup} />
        <Item icon="refresh-circle-outline" title="Restore backup" onPress={restoreBackup} />
        <Item
          icon="trash-outline"
          title="Delete everything"
          danger
          onPress={async () => {
            if (!(await ui.confirm('Delete everything?', 'Library, settings, sign-in and caches are erased from this device. This cannot be undone.', 'Delete', true))) return;
            discover.clear();
            await app.deleteAll();
          }}
        />
      </Section>
      <Section title="ABOUT">
        <View style={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 }}>
          <View style={{ alignSelf: 'flex-start', backgroundColor: '#01B4E4', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 }}>
            <Text style={sans(13, 'black', '#0D253F', { letterSpacing: 1 })}>TMDB</Text>
          </View>
          <Text style={[sans(12.5, 'medium', C.dim, { lineHeight: 18 }), { marginTop: 10 }]}>
            This product uses the TMDB API but is not endorsed or certified by TMDB. Film data and images come from TMDB.
          </Text>
          <Text style={[sans(12.5, 'medium', C.dim, { lineHeight: 18 }), { marginTop: 8 }]}>Streaming availability is provided by JustWatch.</Text>
        </View>
        <Item icon="shield-checkmark-outline" title="Privacy" sub="Everything stays on this device" onPress={() => void ui.info('Privacy', PRIVACY_TEXT)} />
        <Item icon="document-text-outline" title="Open-source licenses" sub={`WhatToWatch ${VERSION} · MIT`} onPress={() => void ui.info('Licenses', LICENSES)} />
      </Section>
    </ScrollView>
  );
}
