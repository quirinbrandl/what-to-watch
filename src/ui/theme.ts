import { TextStyle } from 'react-native';

export const C = {
  bg: '#0A0908',
  ink: '#FFFFFF',
  dim: '#A19C99',
  faint: '#5F5B58',
  accent: '#FF4D2E',
  accentInk: '#FFFFFF',
  accentSoft: 'rgba(255,77,46,0.2)',
  accentLine: 'rgba(255,77,46,0.55)',
  card: '#161514',
  sheet: '#141312',
  line: 'rgba(255,255,255,0.12)',
  soft: 'rgba(255,255,255,0.08)',
  glass: 'rgba(21,20,19,0.88)',
  // The accent is itself a warm red, so warnings of loss lean pink and middling scores stay amber.
  danger: '#FF4D7D',
  mid: '#FFC857',
  good: '#5BD68A',
  /** The app icon's tile; the logo is drawn on it wherever it appears. */
  tile: '#0B0B0E',
};

/** Font family names as registered in App.tsx (bundled, never downloaded). */
export const F = {
  display: 'Anton_400Regular',
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

/** Titles and the app's name: Anton, always in capitals. */
export const display = (size: number, color: string = C.ink): TextStyle => ({
  fontFamily: F.display,
  fontSize: size,
  lineHeight: Math.round(size * 1.16),
  color,
  includeFontPadding: false,
  letterSpacing: size * 0.02,
  textTransform: 'uppercase',
});

export const caps = (color: string = C.dim): TextStyle => sans(11.5, 'bold', color, { letterSpacing: 1.3 });

export const runtimeLabel = (m?: number): string => (!m || m <= 0 ? '' : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
