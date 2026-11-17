import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, FadeOutDown, ZoomIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useStore } from '../app/store';
import { Dialog, ui } from '../app/ui';

import { Icon, Sheet } from './components';
import { C, sans, display } from './theme';

function TextButton({ label, onPress, color = C.accent }: { label: string; onPress: () => void; color?: string }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={6} style={{ minHeight: 44, minWidth: 64, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={sans(14.5, 'bold', color)}>{label}</Text>
    </Pressable>
  );
}

function Ask({ d }: { d: Extract<Dialog, { kind: 'ask' }> }) {
  const [text, setText] = useState(d.initial ?? '');
  return (
    <>
      <TextInput
        value={text}
        onChangeText={setText}
        autoFocus
        secureTextEntry={d.secret}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={d.hint}
        placeholderTextColor={C.faint}
        selectionColor={C.accent}
        onSubmitEditing={() => d.resolve(text)}
        accessibilityLabel={d.title}
        style={[sans(16), { borderBottomWidth: 1, borderBottomColor: C.line, paddingVertical: 10, marginTop: 14 }]}
      />
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 14 }}>
        <TextButton label="Cancel" color={C.dim} onPress={() => d.resolve(undefined)} />
        <TextButton label={d.action} onPress={() => d.resolve(text)} />
      </View>
    </>
  );
}

/** Dialogs, pickers and the toast, above everything else. */
export function Layers() {
  const { dialog: d, toastText } = useStore(ui);
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  return (
    <>
      {d?.kind === 'choose' && (
        <Sheet onClose={() => d.resolve(undefined)} maxHeight={0.8}>
          <Text style={[display(23), { marginTop: 8, marginBottom: 10 }]} accessibilityRole="header">
            {d.title}
          </Text>
          {d.items.map((it) => (
            <Pressable
              key={it.key}
              accessibilityRole="radio"
              accessibilityState={{ selected: it.key === d.current }}
              accessibilityLabel={it.label}
              onPress={() => d.resolve(it.key)}
              style={{ minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Text style={sans(16, it.key === d.current ? 'black' : 'medium')}>{it.label}</Text>
                {it.sub && <Text style={[sans(12.5, 'medium', C.dim), { marginTop: 2 }]}>{it.sub}</Text>}
              </View>
              {it.key === d.current && <Icon name="checkmark" size={20} color={C.accent} />}
            </Pressable>
          ))}
        </Sheet>
      )}
      {d && d.kind !== 'choose' && (
        <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', padding: 24 }]} accessibilityViewIsModal>
          <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(140)} style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.66)' }]}>
            <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="Close" onPress={() => ui.back()} />
          </Animated.View>
          <Animated.View
            entering={ZoomIn.duration(200)}
            exiting={FadeOut.duration(140)}
            style={{ alignSelf: 'stretch', maxHeight: height * 0.76, backgroundColor: C.card, borderRadius: 28, borderWidth: 1, borderColor: C.line, padding: 22, paddingBottom: 12 }}>
            <Text style={display(23)} accessibilityRole="header">
              {d.title}
            </Text>
            {d.kind === 'ask' ? (
              <Ask d={d} />
            ) : (
              <>
                <ScrollView style={{ marginTop: 12, flexGrow: 0 }} showsVerticalScrollIndicator={false}>
                  <Text style={sans(15, 'medium', C.dim, { lineHeight: 22 })}>{d.body}</Text>
                </ScrollView>
                <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12 }}>
                  {d.kind === 'confirm' ? (
                    <>
                      <TextButton label="Cancel" color={C.dim} onPress={() => d.resolve(false)} />
                      <TextButton label={d.action} color={d.danger ? C.danger : C.accent} onPress={() => d.resolve(true)} />
                    </>
                  ) : (
                    <TextButton label={d.title.startsWith("You're") ? 'Got it' : 'Close'} onPress={() => d.resolve()} />
                  )}
                </View>
              </>
            )}
          </Animated.View>
        </View>
      )}
      {toastText && (
        <Animated.View
          entering={FadeInDown.duration(220)}
          exiting={FadeOutDown.duration(180)}
          pointerEvents="none"
          accessibilityLiveRegion="polite"
          style={{ position: 'absolute', left: 20, right: 20, bottom: insets.bottom + 96, alignItems: 'center' }}>
          <View style={{ backgroundColor: '#2A2A30', borderRadius: 18, paddingHorizontal: 18, paddingVertical: 13, borderWidth: 1, borderColor: C.line }}>
            <Text style={[sans(14, 'semi'), { textAlign: 'center' }]}>{toastText}</Text>
          </View>
        </Animated.View>
      )}
    </>
  );
}
