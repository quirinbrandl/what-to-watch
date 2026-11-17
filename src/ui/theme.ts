import { TextStyle } from 'react-native';

export const C = {
  bg: '#08080A',
  ink: '#F4F1EA',
  dim: '#A29E96',
  faint: '#5F5C57',
  accent: '#FFC857',
  accentInk: '#1B1300',
  card: '#151518',
  sheet: '#131316',
  line: 'rgba(255,255,255,0.12)',
  soft: 'rgba(255,255,255,0.08)',
  glass: 'rgba(20,20,23,0.88)',
  danger: '#FF6B5E',
  good: '#5BD68A',
};

/** Font family names as registered in App.tsx (bundled, never downloaded). */
export const F = {
  serif: 'InstrumentSerif_400Regular',
  serifItalic: 'InstrumentSerif_400Regular_Italic',
  medium: 'Manrope_500Medium',
  semi: 'Manrope_600SemiBold',
  bold: 'Manrope_700Bold',
  black: 'Manrope_800ExtraBold',
};

type Weight = 'medium' | 'semi' | 'bold' | 'black';

export const sans = (size: number, weight: Weight = 'medium', color: string = C.ink, extra: TextStyle = {}): TextStyle => ({
  fontFamily: F[weight],
  fontSize: size,
  color,
  includeFontPadding: false,
  ...extra,
});

export const serif = (size: number, color: string = C.ink, italic = false): TextStyle => ({
  fontFamily: italic ? F.serifItalic : F.serif,
  fontSize: size,
  lineHeight: Math.round(size * 1.08),
  color,
  includeFontPadding: false,
  letterSpacing: -0.2,
});

export const caps = (color: string = C.dim): TextStyle => sans(11.5, 'bold', color, { letterSpacing: 1.3 });

export const runtimeLabel = (m?: number): string => (!m || m <= 0 ? '' : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
