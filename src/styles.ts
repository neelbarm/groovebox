/** Per-style musical + sonic presets. One place to tune the whole record. */

import type { ScaleName } from './theory.js';

export const STYLE_NAMES = ['lofi', 'house', 'ambient', 'dnb'] as const;
export type StyleName = (typeof STYLE_NAMES)[number];

export function isStyleName(value: string): value is StyleName {
  return (STYLE_NAMES as readonly string[]).includes(value);
}

export interface StylePreset {
  name: StyleName;
  label: string;
  /** [min, max] bpm; the seed picks inside this range. */
  bpmRange: [number, number];
  /** Modes this style draws from when no key is supplied. */
  scales: ScaleName[];
  /** Tonics the style likes (pitch classes) when no key is supplied. */
  tonics: number[];
  /** 0 = straight, 0.66 = heavy triplet swing. Applied to off-8ths/16ths. */
  swing: number;
  /** Sidechain duck depth, 0..1. */
  duck: number;
  /** Reverb send for pads, 0..1. */
  padReverb: number;
  /** Vinyl/noise bed level, 0..1. */
  noiseBed: number;
  /** Stereo delay mix for the lead. */
  leadDelay: number;
  /** Accent colour used by the web player. */
  accent: string;
  accent2: string;
}

export const STYLES: Record<StyleName, StylePreset> = {
  lofi: {
    name: 'lofi',
    label: 'Lo-fi',
    bpmRange: [70, 90],
    scales: ['minor', 'dorian'],
    tonics: [9, 2, 4, 7, 0, 5], // A, D, E, G, C, F
    swing: 0.58,
    duck: 0.45,
    padReverb: 0.38,
    noiseBed: 0.5,
    leadDelay: 0.3,
    accent: '#ffb37a',
    accent2: '#c98bff',
  },
  house: {
    name: 'house',
    label: 'House',
    bpmRange: [120, 126],
    scales: ['minor', 'dorian'],
    tonics: [9, 2, 7, 0, 5],
    swing: 0.52,
    duck: 0.62,
    padReverb: 0.3,
    noiseBed: 0.06,
    leadDelay: 0.34,
    accent: '#6fd3ff',
    accent2: '#7b8cff',
  },
  ambient: {
    name: 'ambient',
    label: 'Ambient',
    bpmRange: [62, 76],
    scales: ['dorian', 'major', 'minor'],
    tonics: [0, 5, 10, 3, 8],
    swing: 0.5,
    duck: 0.16,
    padReverb: 0.82,
    noiseBed: 0.22,
    leadDelay: 0.5,
    accent: '#5fe2c4',
    accent2: '#63a8ff',
  },
  dnb: {
    name: 'dnb',
    label: 'Drum & bass',
    bpmRange: [172, 176],
    scales: ['minor'],
    tonics: [9, 2, 4, 7],
    swing: 0.5,
    duck: 0.3,
    padReverb: 0.34,
    noiseBed: 0.08,
    leadDelay: 0.26,
    accent: '#ff6b8b',
    accent2: '#9b5cff',
  },
};
