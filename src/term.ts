/**
 * Tiny terminal helpers: ANSI colour that politely disables itself, plus a
 * box-drawing table with per-column alignment. No dependency, ~100 lines.
 */

const ESC = String.fromCharCode(27);
const env = typeof process !== 'undefined' ? process.env : ({} as Record<string, string | undefined>);

function detectColor(): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  if (typeof process === 'undefined') return false;
  return Boolean(process.stdout && process.stdout.isTTY);
}

export const COLOR_ENABLED = detectColor();

function wrap(open: string, close: string) {
  return (text: string): string => (COLOR_ENABLED ? `${ESC}[${open}m${text}${ESC}[${close}m` : text);
}

export const c = {
  reset: wrap('0', '0'),
  bold: wrap('1', '22'),
  dim: wrap('2', '22'),
  italic: wrap('3', '23'),
  underline: wrap('4', '24'),
  red: wrap('31', '39'),
  green: wrap('32', '39'),
  yellow: wrap('33', '39'),
  blue: wrap('34', '39'),
  magenta: wrap('35', '39'),
  cyan: wrap('36', '39'),
  white: wrap('37', '39'),
  grey: wrap('90', '39'),
  orange: wrap('38;5;215', '39'),
  violet: wrap('38;5;141', '39'),
  teal: wrap('38;5;80', '39'),
  pink: wrap('38;5;211', '39'),
};

const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** Visible width, ignoring ANSI escapes. */
export function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

function padTo(text: string, width: number, align: 'left' | 'right' | 'center'): string {
  const pad = Math.max(0, width - visibleWidth(text));
  if (align === 'right') return ' '.repeat(pad) + text;
  if (align === 'center') {
    const left = Math.floor(pad / 2);
    return ' '.repeat(left) + text + ' '.repeat(pad - left);
  }
  return text + ' '.repeat(pad);
}

export interface TableColumn {
  header: string;
  align?: 'left' | 'right' | 'center';
}

/** Render a light box-drawn table. Cells may already contain ANSI colour. */
export function table(columns: TableColumn[], rows: string[][]): string {
  const widths = columns.map((col, i) =>
    Math.max(visibleWidth(col.header), ...rows.map((r) => visibleWidth(r[i] ?? ''))),
  );

  const rule = (l: string, mid: string, r: string) =>
    c.grey(l + widths.map((w) => '─'.repeat(w + 2)).join(mid) + r);
  const bar = c.grey('│');

  const headerCells = columns.map((col, i) => c.bold(c.white(padTo(col.header, widths[i]!, col.align ?? 'left'))));
  const out: string[] = [];
  out.push(rule('┌', '┬', '┐'));
  out.push(`${bar} ${headerCells.join(` ${bar} `)} ${bar}`);
  out.push(rule('├', '┼', '┤'));
  for (const row of rows) {
    const cells = columns.map((col, i) => padTo(row[i] ?? '', widths[i]!, col.align ?? 'left'));
    out.push(`${bar} ${cells.join(` ${bar} `)} ${bar}`);
  }
  out.push(rule('└', '┴', '┘'));
  return out.join('\n');
}

/** Left-aligned key/value block with a hairline gutter. */
export function keyValues(rows: Array<[string, string]>, indent = '  '): string {
  const width = Math.max(...rows.map(([k]) => visibleWidth(k)));
  return rows
    .map(([k, v]) => `${indent}${c.grey(k.padStart(width))} ${c.grey('│')} ${v}`)
    .join('\n');
}

const SPARK_GLYPHS ='▁▂▃▄▅▆▇█';

/** A compact unicode bar chart, used for the energy sparkline and level meters. */
export function sparkline(values: number[], max = 1): string {
  return values
    .map((v) => {
      const t = Math.max(0, Math.min(1, v / (max || 1)));
      return SPARK_GLYPHS[Math.min(SPARK_GLYPHS.length - 1, Math.round(t * (SPARK_GLYPHS.length - 1)))]!;
    })
    .join('');
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export const STYLE_COLOR: Record<string, (t: string) => string> = {
  lofi: c.orange,
  house: c.cyan,
  ambient: c.teal,
  dnb: c.pink,
};

export function styleColor(style: string): (t: string) => string {
  return STYLE_COLOR[style] ?? c.white;
}
