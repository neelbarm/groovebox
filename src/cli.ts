#!/usr/bin/env node
/**
 * groovebox CLI.
 *
 *   npx groovebox --seed 42 --style lofi --bars 32 -o track.wav
 *   npx groovebox --style house --bpm 124 --key Am --midi --json
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { STYLE_NAMES, isStyleName, StyleName } from './styles.js';
import { generate } from './generate.js';
import { toMidi, toSessionJson, toWav } from './index.js';
import { c, formatDuration, keyValues, sparkline, styleColor } from './term.js';
import { parseKey } from './theory.js';

interface Args {
  seed: number;
  style: StyleName;
  bars: number;
  bpm?: number;
  key?: string;
  out: string;
  midi: boolean;
  json: boolean;
  sampleRate: number;
  quiet: boolean;
}

const VERSION = '0.1.0';

function usage(): string {
  const b = c.bold;
  const g = c.grey;
  return [
    `${b('groovebox')} ${g(`v${VERSION}`)} ${g('- deterministic generative music, zero dependencies')}`,
    '',
    `${b('USAGE')}`,
    `  groovebox [options]`,
    '',
    `${b('OPTIONS')}`,
    `  --seed <n>          Seed. Same seed + options always yields the same file. ${g('[default: random]')}`,
    `  --style <name>      ${STYLE_NAMES.join(' | ')} ${g('[default: lofi]')}`,
    `  --bars <n>          Length in bars. ${g('[default: 32]')}`,
    `  --bpm <n>           Override the tempo the style would pick.`,
    `  --key <key>         e.g. Am, F#m, C major, D dorian, G mixolydian.`,
    `  -o, --out <file>    Output WAV path. ${g('[default: groovebox-<style>-<seed>.wav]')}`,
    `  --midi              Also write a standard MIDI file next to the WAV.`,
    `  --json              Also write the session JSON (bpm, key, camelot, chords, sections).`,
    `  --sample-rate <n>   ${g('[default: 44100]')}`,
    `  -q, --quiet         Only print the output path.`,
    `  -h, --help          Show this help.`,
    `  -v, --version       Print the version.`,
    '',
    `${b('EXAMPLES')}`,
    `  ${g('$')} groovebox --seed 42 --style lofi --bars 32 -o track.wav`,
    `  ${g('$')} groovebox --style house --bars 64 --key Am --midi --json`,
    `  ${g('$')} groovebox --style ambient --seed 99 --bpm 68 --bars 48`,
    '',
  ].join('\n');
}

function fail(message: string): never {
  process.stderr.write(`${c.red('error')} ${message}\n`);
  process.stderr.write(`${c.grey('Run `groovebox --help` for usage.')}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    seed: Math.floor(Math.random() * 1_000_000),
    style: 'lofi',
    bars: 32,
    out: '',
    midi: false,
    json: false,
    sampleRate: 44100,
    quiet: false,
  };

  const need = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) fail(`${flag} needs a value`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '-h':
      case '--help':
        process.stdout.write(usage());
        process.exit(0);
        break;
      case '-v':
      case '--version':
        process.stdout.write(`${VERSION}\n`);
        process.exit(0);
        break;
      case '--seed': {
        const v = Number(need(i++, '--seed'));
        if (!Number.isFinite(v)) fail('--seed must be a number');
        args.seed = Math.floor(v) >>> 0;
        break;
      }
      case '--style': {
        const v = need(i++, '--style');
        if (!isStyleName(v)) fail(`unknown style "${v}". Expected one of: ${STYLE_NAMES.join(', ')}`);
        args.style = v;
        break;
      }
      case '--bars': {
        const v = Number(need(i++, '--bars'));
        if (!Number.isFinite(v) || v < 4 || v > 512) fail('--bars must be between 4 and 512');
        args.bars = Math.round(v);
        break;
      }
      case '--bpm': {
        const v = Number(need(i++, '--bpm'));
        if (!Number.isFinite(v) || v < 40 || v > 220) fail('--bpm must be between 40 and 220');
        args.bpm = v;
        break;
      }
      case '--key': {
        const v = need(i++, '--key');
        try {
          parseKey(v);
        } catch (err) {
          fail(`${(err as Error).message}`);
        }
        args.key = v;
        break;
      }
      case '--sample-rate': {
        const v = Number(need(i++, '--sample-rate'));
        if (![22050, 32000, 44100, 48000].includes(v)) fail('--sample-rate must be 22050, 32000, 44100 or 48000');
        args.sampleRate = v;
        break;
      }
      case '-o':
      case '--out':
        args.out = need(i++, '--out');
        break;
      case '--midi':
        args.midi = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '-q':
      case '--quiet':
        args.quiet = true;
        break;
      default:
        fail(`unknown option "${arg}"`);
    }
  }

  if (args.out === '') args.out = `groovebox-${args.style}-${args.seed}.wav`;
  return args;
}

function progressBar(fraction: number, label: string): string {
  const width = 24;
  const filled = Math.round(fraction * width);
  const bar = '█'.repeat(filled) + c.grey('░'.repeat(width - filled));
  return `  ${bar} ${String(Math.round(fraction * 100)).padStart(3)}% ${c.grey(label.padEnd(10))}`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const interactive = !args.quiet && Boolean(process.stderr.isTTY);
  const tint = styleColor(args.style);

  if (!args.quiet) {
    process.stderr.write(`\n${c.bold('groovebox')} ${c.grey('→')} ${tint(args.style)} ${c.grey(`seed ${args.seed}`)}\n`);
  }

  const started = Date.now();
  let lastDraw = 0;
  const result = generate({
    seed: args.seed,
    style: args.style,
    bars: args.bars,
    bpm: args.bpm,
    key: args.key,
    sampleRate: args.sampleRate,
    onProgress: (fraction, label) => {
      if (!interactive) return;
      const now = Date.now();
      if (now - lastDraw < 40 && fraction < 1) return;
      lastDraw = now;
      process.stderr.write(`\r${progressBar(fraction, label)}`);
    },
  });
  if (interactive) process.stderr.write(`\r${' '.repeat(60)}\r`);

  const outPath = resolve(process.cwd(), args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, toWav(result));

  const written: string[] = [outPath];
  if (args.midi) {
    const midPath = outPath.replace(/\.wav$/i, '') + '.mid';
    writeFileSync(midPath, toMidi(result));
    written.push(midPath);
  }
  if (args.json) {
    const jsonPath = outPath.replace(/\.wav$/i, '') + '.json';
    writeFileSync(jsonPath, toSessionJson(result));
    written.push(jsonPath);
  }

  if (args.quiet) {
    process.stdout.write(`${outPath}\n`);
    return;
  }

  const s = result.session;
  const rows: Array<[string, string]> = [
    ['style', tint(c.bold(args.style))],
    ['key', `${c.bold(s.key)} ${c.grey(`(${s.keyName})`)}`],
    [
      'camelot',
      c.violet(c.bold(s.camelot)) + (s.camelotKey === s.key ? '' : c.grey(`  (${s.camelotKey} collection)`)),
    ],
    ['bpm', c.bold(String(s.bpm))],
    ['length', `${s.bars} bars ${c.grey(`\u00b7 ${formatDuration(s.durationSec)}`)}`],
    ['peak', `${c.bold(s.stats.peakDb.toFixed(2))} ${c.grey('dBFS')}   ${c.grey(`rms ${s.stats.rmsDb.toFixed(1)} dBFS`)}`],
    ['form', s.sections.map((x) => tint(x.name)).join(c.grey(' \u203a '))],
    ['chords', s.chords.slice(0, 8).map((x) => c.cyan(x.name)).join(c.grey(' \u00b7 ')) + (s.chords.length > 8 ? c.grey(' \u2026') : '')],
    ['energy', tint(sparkline(s.energyCurve))],
  ];

  process.stdout.write('\n');
  process.stdout.write(keyValues(rows));
  process.stdout.write('\n\n');
  for (const file of written) {
    process.stdout.write(`  ${c.green('\u2713')} ${c.bold(basename(file))} ${c.grey(dirname(file))}\n`);
  }
  process.stdout.write(`${c.grey(`  rendered in ${((Date.now() - started) / 1000).toFixed(1)}s`)}\n\n`);
}

main();
