// Shared data model for the Song Analyzer.

/** A selectable section preset in the palette. */
export interface Section {
  name: string;
  color: string;
}

/** A section marker placed on the timeline (time in seconds). */
export interface Marker {
  id: number;
  t: number;
  name: string;
  color: string;
}

/**
 * An arrangement block. Positions are stored in BARS (we always snap to bars).
 * `fadeInBars` is measured from `startBar`; `fadeOutBars` from `endBar`.
 */
export interface Block {
  id: string;
  startBar: number;
  endBar: number;
  fadeInBars: number;
  fadeOutBars: number;
}

/** An instrument lane holding arrangement blocks. */
export interface Lane {
  id: string;
  name: string;
  color: string;
  blocks: Block[];
}

/** A downsampled waveform sample: [min, max] in [-1, 1]. */
export type Peak = [number, number];

/** Shape persisted to localStorage, keyed per audio file. */
export interface SavedState {
  markers: Marker[];
  bpm: number;
  firstBeat: number;
  fileName: string | null;
  lanes: Lane[];
}
