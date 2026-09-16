/**
 * Song form: which layers are playing when, and how loud the track feels.
 *
 * A style owns a template of proportional sections. The template is scaled to
 * whatever bar count the user asked for, snapped to 4-bar multiples so the
 * drum fills always land on a phrase boundary.
 */

import { Rng } from './rng.js';
import type { StyleName } from './styles.js';

export type Layer = 'drums' | 'hats' | 'bass' | 'pad' | 'lead' | 'texture';

export interface SectionTemplate {
  name: string;
  weight: number;
  layers: Layer[];
  energy: number;
}

export interface Section {
  name: string;
  startBar: number;
  bars: number;
  layers: Set<Layer>;
  energy: number;
  /** True for the closing section, which fades. */
  isOutro: boolean;
}

const ALL: Layer[] = ['drums', 'hats', 'bass', 'pad', 'lead', 'texture'];

const TEMPLATES: Record<StyleName, SectionTemplate[]> = {
  lofi: [
    { name: 'intro', weight: 0.12, layers: ['pad', 'texture'], energy: 0.2 },
    { name: 'A', weight: 0.22, layers: ['drums', 'hats', 'bass', 'pad', 'lead', 'texture'], energy: 0.55 },
    { name: 'B', weight: 0.22, layers: ALL, energy: 0.8 },
    { name: "A'", weight: 0.18, layers: ['drums', 'hats', 'bass', 'pad', 'lead', 'texture'], energy: 0.68 },
    { name: 'break', weight: 0.12, layers: ['pad', 'texture', 'hats'], energy: 0.3 },
    { name: 'outro', weight: 0.14, layers: ['drums', 'hats', 'bass', 'pad', 'lead', 'texture'], energy: 0.4 },
  ],
  house: [
    { name: 'intro', weight: 0.12, layers: ['drums', 'hats', 'texture'], energy: 0.25 },
    { name: 'build', weight: 0.13, layers: ['drums', 'hats', 'bass', 'pad'], energy: 0.5 },
    { name: 'drop', weight: 0.25, layers: ALL, energy: 0.95 },
    { name: 'breakdown', weight: 0.14, layers: ['pad', 'hats', 'texture'], energy: 0.35 },
    { name: 'drop II', weight: 0.24, layers: ALL, energy: 1.0 },
    { name: 'outro', weight: 0.12, layers: ['drums', 'hats', 'pad'], energy: 0.35 },
  ],
  ambient: [
    { name: 'emerge', weight: 0.22, layers: ['pad', 'texture'], energy: 0.18 },
    { name: 'drift', weight: 0.3, layers: ['pad', 'texture', 'bass'], energy: 0.45 },
    { name: 'swell', weight: 0.3, layers: ['pad', 'texture', 'bass', 'lead', 'hats'], energy: 0.72 },
    { name: 'dissolve', weight: 0.18, layers: ['pad', 'texture'], energy: 0.25 },
  ],
  dnb: [
    { name: 'intro', weight: 0.11, layers: ['hats', 'pad', 'texture'], energy: 0.25 },
    { name: 'build', weight: 0.12, layers: ['drums', 'hats', 'pad', 'texture'], energy: 0.5 },
    { name: 'drop', weight: 0.27, layers: ALL, energy: 1.0 },
    { name: 'break', weight: 0.15, layers: ['pad', 'texture', 'lead'], energy: 0.35 },
    { name: 'drop II', weight: 0.23, layers: ALL, energy: 1.0 },
    { name: 'outro', weight: 0.12, layers: ['drums', 'hats', 'pad', 'texture'], energy: 0.4 },
  ],
};

/** Build the section list for a style, scaled to `bars` total bars. */
export function buildStructure(style: StyleName, bars: number, rng: Rng): Section[] {
  const template = TEMPLATES[style];
  const grid = bars >= 24 ? 4 : bars >= 12 ? 2 : 1;
  const minBars = grid;

  const raw = template.map((t) => t.weight * bars);
  const alloc = raw.map((r) => Math.max(minBars, Math.round(r / grid) * grid));

  // Reconcile the rounding drift against the requested total.
  let total = alloc.reduce((a, b) => a + b, 0);
  let guard = 0;
  while (total !== bars && guard++ < 512) {
    const diff = bars - total;
    const step = diff > 0 ? grid : -grid;
    // Grow/shrink the longest sections first so short intros stay intact.
    let idx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < alloc.length; i++) {
      if (step < 0 && alloc[i]! - grid < minBars) continue;
      const score = alloc[i]! + rng.next() * 0.001;
      if (score > bestScore) {
        bestScore = score;
        idx = i;
      }
    }
    if (bestScore === -Infinity) break;
    alloc[idx] = alloc[idx]! + step;
    total += step;
  }
  if (total !== bars && alloc.length > 0) {
    alloc[alloc.length - 1] = Math.max(1, alloc[alloc.length - 1]! + (bars - total));
  }

  const out: Section[] = [];
  let cursor = 0;
  for (let i = 0; i < template.length; i++) {
    const t = template[i]!;
    const len = alloc[i]!;
    if (len <= 0) continue;
    out.push({
      name: t.name,
      startBar: cursor,
      bars: len,
      layers: new Set(t.layers),
      energy: t.energy,
      isOutro: i === template.length - 1,
    });
    cursor += len;
  }
  return out;
}

export function sectionAtBar(sections: Section[], bar: number): Section {
  let best = sections[0]!;
  for (const s of sections) {
    if (bar >= s.startBar) best = s;
    else break;
  }
  return best;
}

/**
 * Per-bar energy in 0..1: the section's base energy with a gentle rise across
 * the section, so even a static loop breathes. The web player draws this and
 * a DJ tool can use it to pick mix-in points.
 */
export function energyCurve(sections: Section[], bars: number): number[] {
  const out: number[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const s = sectionAtBar(sections, bar);
    const t = s.bars <= 1 ? 0 : (bar - s.startBar) / (s.bars - 1);
    const rise = s.isOutro ? -0.18 * t : 0.12 * t;
    out.push(clamp01(s.energy + rise));
  }
  return out;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
