import { Ionicons } from '@expo/vector-icons';
import { Image, ImageStyle } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import React, { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, GestureResponderEvent, LayoutChangeEvent, Pressable, ScrollView, StyleProp, StyleSheet, Text, View, ViewStyle, useWindowDimensions } from 'react-native';
import Animated, { Easing, FadeIn, FadeOut, SlideInDown, SlideOutDown, cancelAnimation, useAnimatedStyle, useFrameCallback, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle } from 'react-native-svg';

import { thud, tick } from '../app/platform';
import { Film } from '../core/models';
import { Tmdb } from '../core/tmdb';

import { C, sans, serif } from './theme';

export type IconName = React.ComponentProps<typeof Ionicons>['name'];
export const Icon = Ionicons;

// ---------------------------------------------------------------- posters

/**
 * A film poster. The art is the design, so this is used everywhere. The
 * image view rounds its own corners natively (no clipping wrapper), which
 * keeps walls of moving posters cheap to draw.
 */
export function Poster({ path, label = '', radius = 12, size = 'w342', style }: { path?: string | null; label?: string; radius?: number; size?: string; style?: StyleProp<ViewStyle> }) {
  if (path) {
    return (
      <Image
        source={{ uri: Tmdb.img(path, size) }}
        style={[{ borderRadius: radius, backgroundColor: '#17171B' }, style as StyleProp<ImageStyle>]}
        contentFit="cover"
        transition={220}
        cachePolicy="disk"
        recyclingKey={path}
        accessible={!!label}
        accessibilityRole={label ? 'image' : undefined}
        accessibilityLabel={label ? `Poster: ${label}` : undefined}
      />
    );
  }
  return (
    <View style={[{ borderRadius: radius, backgroundColor: '#17171B', alignItems: 'center', justifyContent: 'center', padding: 8 }, style]} accessible={!!label} accessibilityLabel={label || undefined}>
      {label ? (
        <Text style={[serif(15, C.dim), { textAlign: 'center' }]} numberOfLines={4}>
          {label}
        </Text>
      ) : (
        <Icon name="film-outline" size={22} color={C.faint} />
      )}
    </View>
  );
}

const fill = (posters: string[], min: number): string[] => {
  if (!posters.length) return [];
  const out = [...posters];
  while (out.length < min) out.push(...posters);
  return out;
};

function DriftColumn({ posters, width, speed, reverse }: { posters: string[]; width: number; speed: number; reverse: boolean }) {
  const gap = 10;
  const total = posters.length * (width * 1.5 + gap);
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = 0;
    t.value = withRepeat(withTiming(1, { duration: (total / speed) * 1000, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(t);
  }, [total, speed, t]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: reverse ? (t.value - 1) * total : -t.value * total }] }));
  return (
    <Animated.View style={[{ width }, style]}>
      {[...posters, ...posters].map((p, i) => (
        <Poster key={i} path={p} radius={10} size="w185" style={{ width, height: width * 1.5, marginBottom: gap }} />
      ))}
    </Animated.View>
  );
}

/** A slowly drifting, tilted wall of posters used as a living backdrop. */
export const PosterWall = React.memo(function PosterWall({ posters, dim = 0.5 }: { posters: string[]; dim?: number }) {
  const { width, height } = useWindowDimensions();
  const cols = 4;
  const colW = (width * 1.5) / cols - 10;
  const columns = useMemo(() => Array.from({ length: cols }, (_, c) => fill(posters.filter((_, i) => i % cols === c), Math.ceil((height * 1.4) / (colW * 1.5 + 10)) + 1).slice(0, 9)), [posters, height, colW]);
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      {posters.length > 0 && (
        <View style={{ position: 'absolute', left: -width * 0.25, top: -height * 0.18, width: width * 1.5, height: height * 1.4, flexDirection: 'row', gap: 10, transform: [{ rotate: '-8deg' }] }}>
          {columns.map((p, c) => (
            <DriftColumn key={c} posters={p} width={colW} speed={9 + 5 * ((c * 7) % 3)} reverse={c % 2 === 1} />
          ))}
        </View>
      )}
      <LinearGradient
        colors={[`rgba(8,8,10,${dim})`, `rgba(8,8,10,${dim * 0.6})`, 'rgba(8,8,10,0.94)', C.bg]}
        locations={[0, 0.42, 0.8, 1]}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
});

/** A horizontal ribbon of posters gliding by. The list may grow while it runs. */
export function PosterRibbon({ posters, height = 150, speed = 26, reverse = false }: { posters: string[]; height?: number; speed?: number; reverse?: boolean }) {
  const list = useMemo(() => fill(posters.slice(0, 24), 7), [posters]);
  const itemW = (height * 2) / 3 + 10;
  const w = useSharedValue(list.length * itemW);
  const offset = useSharedValue(0);
  useEffect(() => {
    w.value = list.length * itemW;
  }, [list.length, itemW, w]);
  useFrameCallback((f) => {
    offset.value += (speed * (f.timeSincePreviousFrame ?? 16)) / 1000;
  });
  const style = useAnimatedStyle(() => {
    const x = w.value > 0 ? offset.value % w.value : 0;
    return { transform: [{ translateX: reverse ? x - w.value : -x }] };
  });
  return (
    <View style={{ height, overflow: 'hidden' }} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <Animated.View style={[{ flexDirection: 'row' }, style]}>
        {[...list, ...list].map((p, i) => (
          <Poster key={i} path={p} radius={10} size="w185" style={{ width: itemW - 10, height, marginRight: 10 }} />
        ))}
      </Animated.View>
    </View>
  );
}

// ---------------------------------------------------------------- stars

/** Read-only star rating with half stars. */
export function Stars({ value, size = 14, color = C.accent }: { value: number; size?: number; color?: string }) {
  return (
    <View style={{ flexDirection: 'row' }} accessible accessibilityLabel={`${value} stars`}>
      {[1, 2, 3, 4, 5].map((i) => (value >= i ? <Icon key={i} name="star" size={size} color={color} /> : value >= i - 0.5 ? <Icon key={i} name="star-half" size={size} color={color} /> : null))}
    </View>
  );
}

/** Half-star rating input: tap or drag across the stars. Tapping the current value clears it. */
export function StarInput({ value, onChange, size = 46 }: { value?: number; onChange: (v: number | undefined) => void; size?: number }) {
  const v = value ?? 0;
  const last = useRef<number | undefined>(value);
  const moved = useRef(false);
  const start = useRef<number | undefined>(value);
  const at = (e: GestureResponderEvent) => Math.min(10, Math.max(1, Math.ceil((e.nativeEvent.locationX / (size * 5)) * 10))) / 2;
  const set = (n: number) => {
    if (n !== last.current) {
      last.current = n;
      tick();
      onChange(n);
    }
  };
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Your rating"
      accessibilityValue={{ text: value === undefined ? 'not rated' : `${value} stars` }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => onChange(e.nativeEvent.actionName === 'increment' ? Math.min(5, v + 0.5) : v <= 0.5 ? undefined : v - 0.5)}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={
        ((e: GestureResponderEvent) => {
          moved.current = false;
          start.current = value;
          last.current = value;
          set(at(e));
          return true; // keep an enclosing scroll view from taking the drag
        }) as (e: GestureResponderEvent) => void
      }
      onResponderMove={(e) => {
        moved.current = true;
        set(at(e));
      }}
      onResponderRelease={() => {
        if (!moved.current && start.current !== undefined && start.current === last.current) {
          last.current = undefined;
          tick();
          onChange(undefined);
        }
      }}
      style={{ width: size * 5, height: size + 10, justifyContent: 'center' }}>
      <View style={{ flexDirection: 'row' }} pointerEvents="none">
        {[1, 2, 3, 4, 5].map((i) => (
          <Icon key={i} name={v >= i ? 'star' : v >= i - 0.5 ? 'star-half' : 'star-outline'} size={size} color={v >= i - 0.5 ? C.accent : C.faint} />
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- buttons

/** Round icon button with a generous touch target and a screen-reader label. */
export function RoundButton(props: { icon: IconName; label: string; onPress?: () => void; active?: boolean; size?: number; showLabel?: boolean; caption?: string }) {
  const { icon, label, onPress, active = false, size = 54, showLabel = false, caption } = props;
  const color = !onPress ? C.faint : active ? C.accent : C.ink;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled: !onPress }}
      disabled={!onPress}
      hitSlop={6}
      onPress={() => {
        tick();
        onPress?.();
      }}
      style={{ alignItems: 'center', minWidth: size }}>
      {({ pressed }) => (
        <>
          <View
            style={{
              width: size,
              height: size,
              borderRadius: size / 2,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: active ? 'rgba(255,200,87,0.16)' : pressed ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.1)',
              borderWidth: 1,
              borderColor: active ? 'rgba(255,200,87,0.5)' : C.line,
            }}>
            <Icon name={icon} size={size * 0.42} color={color} />
          </View>
          {showLabel && <Text style={[sans(11, 'semi', C.dim), { marginTop: 6 }]}>{caption ?? label}</Text>}
        </>
      )}
    </Pressable>
  );
}

/** The primary call to action. */
export function BigButton(props: { label: string; icon?: IconName; onPress?: () => void; busy?: boolean; color?: string; ink?: string; style?: StyleProp<ViewStyle> }) {
  const { label, icon, onPress, busy = false, color = C.ink, ink = '#0B0B0E', style } = props;
  const off = !onPress;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off || busy, busy }}
      disabled={off || busy}
      onPress={() => {
        thud();
        onPress?.();
      }}
      style={({ pressed }) => [
        { height: 58, borderRadius: 29, backgroundColor: off ? 'rgba(255,255,255,0.2)' : color, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 10, opacity: pressed ? 0.85 : 1 },
        style,
      ]}>
      {busy ? (
        <ActivityIndicator color={ink} />
      ) : (
        <>
          {icon && <Icon name={icon} size={20} color={ink} />}
          <Text style={sans(16.5, 'bold', ink)}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

/** Compact selectable chip. `negative` marks an exclusion. */
export function Chip(props: { label: string; icon?: IconName; active?: boolean; negative?: boolean; onPress?: () => void; leading?: ReactNode }) {
  const { label, icon, active = false, negative = false, onPress, leading } = props;
  const fg = negative ? C.danger : active ? '#0B0B0E' : onPress ? C.ink : C.faint;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={negative ? `Not ${label}` : label}
      accessibilityState={{ selected: active, disabled: !onPress }}
      disabled={!onPress}
      onPress={() => {
        tick();
        onPress?.();
      }}
      style={({ pressed }) => ({
        minHeight: 44,
        paddingHorizontal: 14,
        borderRadius: 22,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        backgroundColor: negative ? 'rgba(255,107,94,0.14)' : active ? C.ink : pressed ? 'rgba(255,255,255,0.16)' : C.soft,
        borderWidth: 1,
        borderColor: negative ? 'rgba(255,107,94,0.5)' : active ? C.ink : C.line,
      })}>
      {leading}
      {icon && <Icon name={icon} size={16} color={fg} />}
      <Text style={sans(13.5, 'semi', fg, negative ? { textDecorationLine: 'line-through' } : {})} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function ProviderLogo({ logo, name, size = 34 }: { logo?: string | null; name: string; size?: number }) {
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={name} style={{ width: size, height: size, borderRadius: size * 0.24, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center' }}>
      {logo ? <Image source={{ uri: Tmdb.img(logo, 'w92') }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="disk" /> : <Text style={sans(13, 'bold')}>{name.slice(0, 1)}</Text>}
    </View>
  );
}

/** TMDB user score as a ring. */
export function ScoreRing({ film, size = 46 }: { film: Film; size?: number }) {
  const v = film.votes > 0 ? film.vote : 0;
  const color = v >= 7 ? C.good : v >= 5.5 ? C.accent : C.danger;
  const pct = Math.round(v * 10);
  const stroke = 3.2;
  const r = (size - stroke) / 2;
  const len = 2 * Math.PI * r;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={`TMDB user score ${pct} percent`} style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.14)" strokeWidth={stroke} fill="none" />
        {film.votes > 0 && (
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            fill="none"
            strokeDasharray={`${(len * pct) / 100} ${len}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </Svg>
      <Text style={sans(size * 0.3, 'bold')}>{film.votes > 0 ? pct : '–'}</Text>
    </View>
  );
}

/** Designed empty / error state: an icon, a few words, one action. */
export function Blank({ icon, title, action, onAction }: { icon: IconName; title: string; action?: string; onAction?: () => void }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 36 }}>
      <View style={{ width: 84, height: 84, borderRadius: 42, backgroundColor: 'rgba(255,255,255,0.07)', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={34} color={C.dim} />
      </View>
      <Text style={[serif(26), { textAlign: 'center', marginTop: 22 }]}>{title}</Text>
      {action && <BigButton label={action} onPress={onAction} style={{ marginTop: 22, paddingHorizontal: 34 }} />}
    </View>
  );
}

// ---------------------------------------------------------------- slider

/**
 * A slider with one or two thumbs. Values snap to `step`. With two thumbs
 * the touch grabs the nearer one.
 */
export function RangeSlider(props: { min: number; max: number; step?: number; low?: number; high: number; onChange: (low: number, high: number) => void; label: string; format?: (v: number) => string }) {
  const { min, max, step = 1, low, high, onChange, label, format = String } = props;
  const [width, setWidth] = useState(0);
  const grabbed = useRef<'low' | 'high'>('high');
  const cur = useRef({ low: low ?? min, high });
  cur.current = { low: low ?? min, high };
  const pad = 14;
  const track = Math.max(1, width - pad * 2);
  const pos = (v: number) => pad + ((v - min) / (max - min)) * track;
  const valueAt = (x: number) => Math.min(max, Math.max(min, min + Math.round((((x - pad) / track) * (max - min)) / step) * step));
  const update = (e: GestureResponderEvent, grab: boolean) => {
    const v = valueAt(e.nativeEvent.locationX);
    const c = cur.current;
    if (grab) grabbed.current = low === undefined ? 'high' : Math.abs(v - c.low) < Math.abs(v - c.high) || (v < c.low && c.low === c.high) ? 'low' : 'high';
    const next = grabbed.current === 'low' ? { low: Math.min(v, c.high), high: c.high } : { low: c.low, high: Math.max(v, c.low) };
    if (next.low !== c.low || next.high !== c.high) {
      tick();
      onChange(next.low, next.high);
    }
  };
  const thumb = (v: number) => <View style={{ position: 'absolute', left: pos(v) - 11, top: 11, width: 22, height: 22, borderRadius: 11, backgroundColor: C.ink }} />;
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ text: low === undefined ? format(high) : `${format(low)} to ${format(high)}` }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => {
        const d = e.nativeEvent.actionName === 'increment' ? step : -step;
        onChange(cur.current.low, Math.min(max, Math.max(cur.current.low, high + d)));
      }}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={
        ((e: GestureResponderEvent) => {
          update(e, true);
          return true; // keep the sheet from scrolling while a thumb is dragged
        }) as (e: GestureResponderEvent) => void
      }
      onResponderMove={(e) => update(e, false)}
      style={{ height: 44, justifyContent: 'center' }}>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View style={{ position: 'absolute', left: pad, right: pad, top: 20.5, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.2)' }} />
        {width > 0 && (
          <>
            <View style={{ position: 'absolute', left: pos(low ?? min), width: Math.max(0, pos(high) - pos(low ?? min)), top: 20.5, height: 3, borderRadius: 2, backgroundColor: C.ink }} />
            {low !== undefined && thumb(low)}
            {thumb(high)}
          </>
        )}
      </View>
    </View>
  );
}

/** An on/off row with icon, label and optional detail. */
export function ToggleRow({ icon, label, sub, value, onChange }: { icon: IconName; label: string; sub?: string; value: boolean; onChange?: (v: boolean) => void }) {
  const off = !onChange;
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: off }}
      disabled={off}
      onPress={() => {
        tick();
        onChange?.(!value);
      }}
      style={{ flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingHorizontal: 4, gap: 14 }}>
      <Icon name={icon} size={21} color={off ? C.faint : C.dim} />
      <View style={{ flex: 1 }}>
        <Text style={sans(15, 'semi', off ? C.faint : C.ink)}>{label}</Text>
        {sub && (
          <Text style={[sans(12, 'medium', C.dim), { marginTop: 2 }]} numberOfLines={1}>
            {sub}
          </Text>
        )}
      </View>
      <View style={{ width: 50, height: 30, borderRadius: 15, backgroundColor: value ? C.accent : 'rgba(255,255,255,0.16)', padding: 3, alignItems: value ? 'flex-end' : 'flex-start' }}>
        <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: value ? C.accentInk : C.dim }} />
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------- layers

/** A bottom sheet over a dimmed backdrop. */
export function Sheet({ onClose, children, tint, maxHeight = 0.9 }: { onClose: () => void; children: ReactNode; tint?: string; maxHeight?: number }) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return (
    <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
      <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(160)} style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.6)' }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
      </Animated.View>
      <Animated.View
        entering={SlideInDown.duration(280).easing(Easing.out(Easing.cubic))}
        exiting={SlideOutDown.duration(200)}
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: height * maxHeight, backgroundColor: tint ?? C.sheet, borderTopLeftRadius: 32, borderTopRightRadius: 32, borderWidth: 1, borderBottomWidth: 0, borderColor: C.line, overflow: 'hidden' }}>
        <View style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 6 }}>
          <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: C.faint }} />
        </View>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          {children}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

/** A full-screen layer above the tabs (feed, search). */
export function Overlay({ children }: { children: ReactNode }) {
  return (
    <Animated.View entering={FadeIn.duration(240)} exiting={FadeOut.duration(180)} style={[StyleSheet.absoluteFill, { backgroundColor: C.bg }]} accessibilityViewIsModal>
      {children}
    </Animated.View>
  );
}
