import { InstrumentSerif_400Regular, InstrumentSerif_400Regular_Italic } from '@expo-google-fonts/instrument-serif';
import { Manrope_500Medium, Manrope_600SemiBold, Manrope_700Bold, Manrope_800ExtraBold } from '@expo-google-fonts/manrope';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import { AppState as NativeAppState, BackHandler, Pressable, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { discover } from './src/app/discover';
import { tick } from './src/app/platform';
import { app, useStore } from './src/app/store';
import { ui } from './src/app/ui';
import { Icon, IconName } from './src/ui/components';
import { DiscoverScreen, FilterSheet } from './src/ui/Discover';
import { FeedScreen } from './src/ui/Feed';
import { FilmSheet } from './src/ui/FilmSheet';
import { Layers } from './src/ui/Layers';
import { LibraryScreen, SearchScreen } from './src/ui/Library';
import { Onboarding } from './src/ui/Onboarding';
import { ImportOverlay, SettingsScreen } from './src/ui/Settings';
import { C, sans } from './src/ui/theme';

void SplashScreen.preventAutoHideAsync().catch(() => {});
void app.init();

const TABS: [typeof ui.tab, IconName, string][] = [
  ['discover', 'sparkles', 'Discover'],
  ['library', 'grid', 'Library'],
  ['settings', 'options', 'Settings'],
];

/** Three places, one thumb: Discover · Library · Settings. */
function TabBar() {
  const insets = useSafeAreaInsets();
  const tab = ui.tab;
  return (
    <View style={{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + 12, alignItems: 'center' }} pointerEvents="box-none">
      <View style={{ flexDirection: 'row', backgroundColor: C.glass, borderRadius: 30, padding: 6, borderWidth: 1, borderColor: C.line }} accessibilityRole="tablist">
        {TABS.map(([key, icon, label]) => {
          const on = tab === key;
          return (
            <Pressable
              key={key}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected: on }}
              onPress={() => {
                tick();
                ui.setTab(key);
              }}
              style={{ height: 48, minWidth: 54, paddingHorizontal: on ? 18 : 16, borderRadius: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: on ? C.ink : 'transparent' }}>
              <Icon name={icon} size={20} color={on ? C.bg : C.dim} />
              {on && <Text style={sans(13.5, 'bold', C.bg)}>{label}</Text>}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function Shell({ autoRun }: { autoRun: boolean }) {
  useStore(ui);
  useEffect(() => {
    void discover.restore();
    if (autoRun) ui.openFeed({ start: true });
  }, [autoRun]);
  const covered = ui.feed || ui.search;
  const tab = ui.tab;
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }} importantForAccessibility={covered ? 'no-hide-descendants' : 'auto'} accessibilityElementsHidden={covered}>
        <View style={{ flex: 1, display: tab === 'discover' ? 'flex' : 'none' }}>
          <DiscoverScreen />
        </View>
        {tab === 'library' && <LibraryScreen />}
        {tab === 'settings' && <SettingsScreen />}
        <TabBar />
      </View>
      {ui.feed && <FeedScreen />}
      {ui.search && <SearchScreen />}
      {ui.filters && <FilterSheet />}
    </View>
  );
}

function Root() {
  useStore(app);
  const [fresh, setFresh] = useState(false);

  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => ui.back());
    // Every time the app comes to the front, check Letterboxd for new entries.
    const state = NativeAppState.addEventListener('change', (s) => {
      if (s === 'active' && app.ready && !app.auth.signingIn) void app.syncLetterboxd();
    });
    return () => {
      back.remove();
      state.remove();
    };
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {app.settings.onboarded ? <Shell autoRun={fresh && app.hasLlm} /> : <Onboarding onDone={() => setFresh(true)} />}
      <FilmSheet />
      <ImportOverlay />
      <Layers />
    </View>
  );
}

export default function App() {
  useStore(app);
  const [fontsLoaded, fontError] = useFonts({
    InstrumentSerif_400Regular,
    InstrumentSerif_400Regular_Italic,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    Manrope_800ExtraBold,
  });
  const ready = app.ready && (fontsLoaded || !!fontError);
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => {});
  }, [ready]);
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {ready ? <Root /> : <View style={{ flex: 1, backgroundColor: C.bg }} />}
    </SafeAreaProvider>
  );
}
