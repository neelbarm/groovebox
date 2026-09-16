#!/usr/bin/env node
/**
 * `npm run demo`
 *
 * Renders three ~60-second tracks into examples/ as WAV + MID + JSON (plus an
 * MP3 for sharing if ffmpeg happens to be installed), then prints a summary
 * table. Everything is seeded, so this produces identical files on every run
 * and on every machine.
 */

import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate, toMidi, toSessionJson, toWav } from '../dist/index.js';
import { resolveMusicalParams } from '../dist/generate.js';
import { c, formatDuration, sparkline, styleColor, table } from '../dist/term.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = join(root, 'examples');

const TARGET_SECONDS = 60;

const DEMOS = [
  { style: 'lofi', seed: 7 },
  { style: 'house', seed: 21 },
  { style: 'ambient', seed: 99 },
];

/** Pick a bar count that lands closest to ~60 seconds for this style's tempo. */
function barsForTarget(seed, style) {
  const { bpm } = resolveMusicalParams({ seed, style, bars: 32 });
  const barSeconds = (60 / bpm) * 4;
  const bars = Math.round(TARGET_SECONDS / barSeconds / 4) * 4;
  return Math.max(16, bars);
}

function hasFfmpeg() {
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  return probe.status === 0;
}

function writeMp3(wavPath, mp3Path) {
  const run = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', wavPath, '-codec:a', 'libmp3lame', '-q:a', '4', mp3Path],
    { stdio: 'ignore' },
  );
  return run.status === 0;
}

function kb(path) {
  try {
    return `${Math.round(statSync(path).size / 1024)} KB`;
  } catch {
    return '-';
  }
}

function main() {
  mkdirSync(outDir, { recursive: true });
  const ffmpeg = hasFfmpeg();

  process.stdout.write(`\n${c.bold('groovebox demo')} ${c.grey('— three seeded tracks into ./examples\n\n')}`);

  const rows = [];
  let mp3Count = 0;

  for (const { style, seed } of DEMOS) {
    const bars = barsForTarget(seed, style);
    const tint = styleColor(style);
    process.stdout.write(`  ${c.grey('•')} rendering ${tint(style)} ${c.grey(`seed ${seed}, ${bars} bars`)} …`);

    const started = Date.now();
    const result = generate({ seed, style, bars });
    const base = join(outDir, `${style}-${seed}`);

    writeFileSync(`${base}.wav`, toWav(result));
    writeFileSync(`${base}.mid`, toMidi(result));
    writeFileSync(`${base}.json`, toSessionJson(result));
    if (ffmpeg && writeMp3(`${base}.wav`, `${base}.mp3`)) mp3Count++;

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    process.stdout.write(` ${c.green('done')} ${c.grey(`${elapsed}s`)}\n`);

    const s = result.session;
    rows.push([
      tint(c.bold(style)),
      String(seed),
      s.key + (s.camelotKey === s.key ? '' : c.grey(` \u2248${s.camelotKey}`)),
      c.violet(s.camelot),
      String(s.bpm),
      String(s.bars),
      formatDuration(s.durationSec),
      `${s.stats.peakDb.toFixed(2)} dB`,
      `${s.stats.rmsDb.toFixed(1)} dB`,
      tint(sparkline(s.energyCurve)),
    ]);
  }

  const columns = [
    { header: 'style' },
    { header: 'seed', align: 'right' },
    { header: 'key' },
    { header: 'camelot' },
    { header: 'bpm', align: 'right' },
    { header: 'bars', align: 'right' },
    { header: 'length', align: 'right' },
    { header: 'peak', align: 'right' },
    { header: 'rms', align: 'right' },
    { header: 'energy' },
  ];

  process.stdout.write(`\n${table(columns, rows)}\n\n`);

  const files = DEMOS.flatMap(({ style, seed }) => {
    const base = `${style}-${seed}`;
    const list = [`${base}.wav`, `${base}.mid`, `${base}.json`];
    if (ffmpeg) list.push(`${base}.mp3`);
    return list;
  });
  const total = files.reduce((sum, f) => {
    try {
      return sum + statSync(join(outDir, f)).size;
    } catch {
      return sum;
    }
  }, 0);

  process.stdout.write(
    `  ${c.green('✓')} ${files.length} files in ${c.bold('examples/')} ${c.grey(`(${Math.round(total / 1024)} KB)`)}\n`,
  );
  process.stdout.write(
    ffmpeg
      ? `  ${c.green('✓')} ${mp3Count} MP3 preview${mp3Count === 1 ? '' : 's'} written ${c.grey('(ffmpeg found)')}\n`
      : `  ${c.grey('• ffmpeg not found, skipped MP3 previews')}\n`,
  );
  process.stdout.write(`  ${c.grey(`e.g. ${kb(join(outDir, 'lofi-7.wav'))} → open examples/lofi-7.wav, or run \`npm run web\``)}\n\n`);
}

main();
