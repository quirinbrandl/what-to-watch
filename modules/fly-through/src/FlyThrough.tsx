import { requireNativeView } from 'expo';
import type { ViewProps } from 'react-native';

export interface FlyThroughProps extends ViewProps {
  own: string[]; // poster paths of the user's films, for the flight and the far wall
  found: string[]; // poster paths of the films found, in order
  finalists: string[]; // poster paths of the films being rated, in the engine's order
  verdictFilms: string[]; // poster path and predicted rating, in the order they came in
  verdictStars: number[];
  done: boolean; // the search is over
  miss: number; // a film predicted below this is not in the feed
  seed: number;
}

/** The wait screen's fly-through, simulated and drawn natively (Android only): see android/…/FlyThroughView.kt. */
export default requireNativeView<FlyThroughProps>('FlyThrough');
