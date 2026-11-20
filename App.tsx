import { Anton_400Regular } from '@expo-google-fonts/anton';
import { Manrope_500Medium, Manrope_600SemiBold, Manrope_700Bold, Manrope_800ExtraBold } from '@expo-google-fonts/manrope';
import { useFonts } from 'expo-font';
import { LinearGradient } from 'expo-linear-gradient';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useMemo, useState } from 'react';
import { AppState as NativeAppState, BackHandler, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { GestureDetector, GestureHandlerRootView, usePanGesture } from 'react-native-gesture-handler';
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { discover } from './src/app/discover';
import { tick } from './src/app/platform';
import { app, useStore } from './src/app/store';
import { ui } from './src/app/ui';
import { Icon, IconName, Showing, TabSwipe } from './src/ui/components';
import { DiscoverScreen, FilterSheet } from './src/ui/Discover';
import { FeedScreen } from './src/ui/Feed';
import { FilmSheet } from './src/ui/FilmSheet';
import { Layers } from './src/ui/Layers';
import { LibraryScreen, SearchScreen } from './src/ui/Library';
import { Onboarding } from './src/ui/Onboarding';
import { SearchesScreen } from './src/ui/Searches';
import { ImportOverlay, SettingsScreen } from './src/ui/Settings';
import { C, sans } from './src/ui/theme';

void SplashScreen.preventAutoHideAsync().catch(() => {});
void app.init();

const TABS: [typeof ui.tab, IconName, string][] = [
  ['discover', 'search', 'Discover'],
  ['library', 'film', 'Library'],
  ['searches', 'library', 'Searches'],
  ['settings', 'options', 'Settings'],
];

/** Four places, one thumb: Discover · Library · Searches · Settings. */
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

const KEYS = TABS.map(([k]) => k);

/** Library, Searches and Settings scroll under the status bar; this keeps the two apart. */
function StatusShade() {
  const insets = useSafeAreaInsets();
  return <LinearGradient colors={[C.bg, 'rgba(10,9,8,0.85)', 'rgba(10,9,8,0)']} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: insets.top + 18 }} pointerEvents="none" />;
}

function Shell() {
  useStore(ui);
  const { width } = useWindowDimensions();
  useEffect(() => {
    void discover.restore();
  }, []);
  const covered = ui.feed || ui.search;
  const index = KEYS.indexOf(ui.tab);
  // Once an overlay has faded in, stop drawing what it covers.
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (!covered) return setHidden(false);
    const t = setTimeout(() => setHidden(true), 320);
    return () => clearTimeout(t);
  }, [covered]);

  // The tabs lie side by side; `pos` is the visible one (fractional while swiping).
  const pos = useSharedValue(index);
  const from = useSharedValue(index);
  const [mounted, setMounted] = useState<Set<string>>(() => new Set([ui.tab]));
  useEffect(() => {
    // The neighbours are ready shortly after start, so a swipe never reveals an empty page.
    const t = setTimeout(() => setMounted(new Set(KEYS)), 900);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    // A tap on the tab bar or the back button: glide there.
    if (Math.abs(pos.value - index) > 0.01) pos.value = withTiming(index, { duration: 300, easing: Easing.out(Easing.cubic) });
    setMounted((m) => (m.has(ui.tab) ? m : new Set([...m, ui.tab])));
  }, [index, pos]);
  const settle = (i: number) => {
    if (KEYS[i] !== ui.tab) {
      tick();
      ui.setTab(KEYS[i]);
    }
  };
  const last = KEYS.length - 1;
  // Memoised, so the gesture keeps its identity for the scrollers that defer to it.
  const swipe = usePanGesture(
    useMemo(
      () => ({
        activeOffsetX: [-14, 14] as [number, number],
        failOffsetY: [-12, 12] as [number, number],
        onActivate: () => {
          'worklet';
          cancelAnimation(pos);
          from.value = pos.value;
        },
        onUpdate: (e: { translationX: number }) => {
          'worklet';
          let p = from.value - e.translationX / width;
          // Resist past the first and last tab.
          if (p < 0) p *= 0.25;
          if (p > last) p = last + (p - last) * 0.25;
          pos.value = p;
        },
        onDeactivate: (e: { velocityX: number }) => {
          'worklet';
          const start = Math.round(from.value);
          let to = Math.round(pos.value);
          if (e.velocityX < -450) to = Math.ceil(pos.value - 0.02);
          else if (e.velocityX > 450) to = Math.floor(pos.value + 0.02);
          to = Math.max(0, Math.min(last, Math.max(start - 1, Math.min(start + 1, to))));
          pos.value = withSpring(to, { damping: 34, stiffness: 300, mass: 1, overshootClamping: true, velocity: -e.velocityX / width });
          scheduleOnRN(settle, to);
        },
      }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [width],
    ),
  );
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: -pos.value * width }] }));
  const page = (key: string, body: React.ReactNode) => (
    // Clipped, so the home screen's tilted poster wall stays out of its neighbour.
    <View key={key} style={{ width, height: '100%', overflow: 'hidden' }} importantForAccessibility={key === ui.tab ? 'auto' : 'no-hide-descendants'} accessibilityElementsHidden={key !== ui.tab}>
      <Showing.Provider value={key === ui.tab && !hidden}>{mounted.has(key) && body}</Showing.Provider>
    </View>
  );
  return (
    <View style={{ flex: 1 }}>
      <TabSwipe.Provider value={swipe}>
        <GestureDetector gesture={swipe}>
          <View style={{ flex: 1, overflow: 'hidden', display: hidden ? 'none' : 'flex' }} importantForAccessibility={covered ? 'no-hide-descendants' : 'auto'} accessibilityElementsHidden={covered}>
            <Animated.View style={[{ flex: 1, flexDirection: 'row', width: width * KEYS.length }, slide]}>
              {page('discover', <DiscoverScreen />)}
              {page(
                'library',
                <>
                  <LibraryScreen />
                  <StatusShade />
                </>,
              )}
              {page(
                'searches',
                <>
                  <SearchesScreen />
                  <StatusShade />
                </>,
              )}
              {page(
                'settings',
                <>
                  <SettingsScreen />
                  <StatusShade />
                </>,
              )}
            </Animated.View>
            <TabBar />
          </View>
        </GestureDetector>
      </TabSwipe.Provider>
      {ui.feed && <FeedScreen />}
      {ui.search && <SearchScreen />}
      {ui.filters && <FilterSheet />}
    </View>
  );
}

function Root() {
  useStore(app);

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
      {/* Onboarding ends on Discover, where the first search is set up; nothing starts by itself. */}
      {app.settings.onboarded ? <Shell /> : <Onboarding />}
      <FilmSheet />
      <ImportOverlay />
      <Layers />
    </View>
  );
}

export default function App() {
  useStore(app);
  const [fontsLoaded, fontError] = useFonts({
    Anton_400Regular,
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
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: C.bg }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        {ready ? <Root /> : <View style={{ flex: 1, backgroundColor: C.bg }} />}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
