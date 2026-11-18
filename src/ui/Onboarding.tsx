import React, { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { app, useStore } from '../app/store';
import { apiKeyFlow, signInFlow, ui } from '../app/ui';
import { cleanUsername } from '../core/letterboxd';

import { BigButton, Chip, Icon, PosterWall, Wordmark } from './components';
import { ExportSteps, importZipFlow, openLetterboxdExport } from './Settings';
import { C, sans, display } from './theme';

/** Two quick steps: sign in → Letterboxd. Streaming services are picked per search, in the filters. */
export function Onboarding({ onDone }: { onDone: () => void }) {
  useStore(app);
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState(app.hasLlm ? 1 : 0);
  const [busy, setBusy] = useState(false);
  const [wall, setWall] = useState<string[]>([]);
  const [user, setUser] = useState('');
  const next = () => setStep((s) => s + 1);
  const finish = () => {
    app.settings.onboarded = true;
    app.changed();
    onDone();
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

  const signIn = async () => {
    setBusy(true);
    const ok = await signInFlow();
    setBusy(false);
    if (ok) next();
  };
  const useUsername = () => {
    if (!cleanUsername(user)) return ui.toast('That does not look like a username');
    app.setUsername(user);
    finish();
  };

  const lib = app.lib;
  const imported = lib.lbImportAt !== undefined;
  const link = (label: string, onPress: () => void) => (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={8} style={{ alignSelf: 'center', minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, marginTop: 4 }}>
      <Text style={sans(14, 'semi', C.dim)}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <PosterWall posters={wall} dim={step === 0 ? 0.2 : 0.82} />
      <View style={{ flex: 1, paddingTop: insets.top + 16, paddingHorizontal: 24, paddingBottom: insets.bottom + 20 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 6 }} accessible accessibilityLabel={`Step ${step + 1} of 2`}>
          {[0, 1].map((i) => (
            <View key={i} style={{ width: i === step ? 22 : 6, height: 6, borderRadius: 3, backgroundColor: i <= step ? C.ink : 'rgba(255,255,255,0.27)' }} />
          ))}
        </View>
        <View style={{ flex: 1 }} />
        {step === 0 && (
          <Animated.View key="s0" entering={FadeInDown.duration(320)}>
            <Wordmark size={50} mark />
            <BigButton label="Continue with ChatGPT" onPress={signIn} busy={busy} style={{ marginTop: 34 }} />
            {busy ? link('Cancel', () => app.auth.cancelSignIn()) : link('Use an OpenAI API key', async () => (await apiKeyFlow()) && next())}
          </Animated.View>
        )}
        {step === 1 && (
          <Animated.View key="s1" entering={FadeInDown.duration(320)}>
            <Text style={display(40)} accessibilityRole="header">
              {imported ? 'Got your films' : 'Bring your\nLetterboxd'}
            </Text>
            {imported ? (
              <Text style={[sans(15, 'medium', C.dim), { marginTop: 12 }]}>{`${lib.rated.length} ratings  ·  ${lib.watched.length} seen  ·  ${lib.watchlist.length} watchlist`}</Text>
            ) : (
              <View style={{ marginTop: 16, gap: 12, backgroundColor: 'rgba(8,8,10,0.78)', borderRadius: 20, padding: 14 }}>
                <ExportSteps />
                <View style={{ alignSelf: 'flex-start', marginLeft: 30 }}>
                  <Chip label="Open letterboxd.com" icon="open-outline" onPress={openLetterboxdExport} />
                </View>
              </View>
            )}
            {imported ? (
              <BigButton label={app.hasLlm ? 'Show me films' : 'Done'} icon="sparkles" color={C.accent} ink={C.accentInk} onPress={finish} style={{ marginTop: 28 }} />
            ) : (
              <>
                <BigButton label="Choose the ZIP file" icon="archive-outline" onPress={() => void importZipFlow()} style={{ marginTop: 22 }} />
                <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 29, height: 58, paddingLeft: 22, paddingRight: 6, marginTop: 12 }}>
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
                  <Pressable accessibilityRole="button" accessibilityLabel="Use username" onPress={useUsername} style={{ width: 46, height: 46, alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="arrow-forward" size={20} color={C.ink} />
                  </Pressable>
                </View>
                {link('Skip', finish)}
              </>
            )}
          </Animated.View>
        )}
      </View>
    </View>
  );
}
