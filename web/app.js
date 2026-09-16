/**
 * groovebox web player.
 *
 * Vanilla ES modules. The engine renders in a Worker, Web Audio plays the
 * result, and one requestAnimationFrame loop draws the whole visualiser:
 * mirrored waveform, live spectrum, energy curve, playhead and chord ribbon.
 */

import { STYLES } from '../dist/styles.js';

/* ------------------------------------------------------------------ dom -- */

const $ = (id) => document.getElementById(id);

const el = {
  html: document.documentElement,
  tStyle: $('t-style'), tKey: $('t-key'), tBpm: $('t-bpm'),
  mCamelot: $('m-camelot'), mBars: $('m-bars'), mLength: $('m-length'),
  mPeak: $('m-peak'), mSeed: $('m-seed'),
  styleSeg: $('style-seg'), styleThumb: $('style-thumb'),
  barsSeg: $('bars-seg'), barsThumb: $('bars-thumb'),
  seed: $('seed'), shuffle: $('shuffle'), generate: $('generate'),
  progress: $('progress'), canvas: $('viz'), empty: $('empty'),
  ribbon: $('ribbon'), underline: $('underline'),
  play: $('play'), track: $('track'), fill: $('fill'), head: $('head'),
  tNow: $('t-now'), tTotal: $('t-total'), tSection: $('t-section'),
  download: $('download'), downloadJson: $('download-json'),
  error: $('error'),
};

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------------------------------------------------------- state -- */

const state = {
  style: 'lofi',
  bars: 32,
  seed: 7,
  busy: false,
  requestId: 0,
  session: null,
  channels: null,    // { left, right, sampleRate } straight from the engine
  duration: 0,
  buffer: null,      // AudioBuffer, created lazily on first play
  wavBytes: null,
  peaks: null,       // Float32Array pairs [min,max] per column
  peakWidth: 0,
  reveal: 0,         // 0..1 waveform draw-in
  revealStart: 0,
  playing: false,
  startedAt: 0,      // audioContext time when playback began
  offset: 0,         // seconds into the track at startedAt
  spectrum: null,    // eased bars
};

let audioCtx = null;
let analyser = null;
let sourceNode = null;
let gainNode = null;
let freqData = null;

/* --------------------------------------------------------------- worker -- */

let worker = null;
try {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
} catch {
  worker = null; // falls back to main-thread generation below
}

/* --------------------------------------------------------------- helpers - */

function fmtTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function cssVar(name) {
  return getComputedStyle(el.html).getPropertyValue(name).trim();
}

function showError(message) {
  el.error.textContent = message;
  el.error.dataset.visible = 'true';
}

function clearError() {
  el.error.dataset.visible = 'false';
}

/* ------------------------------------------------------ segmented control */

function wireSegment(root, thumb, initial, onChange) {
  const buttons = [...root.querySelectorAll('button')];

  const place = (btn, animate = true) => {
    if (!animate) thumb.style.transition = 'none';
    thumb.style.width = `${btn.offsetWidth}px`;
    thumb.style.transform = `translate3d(${btn.offsetLeft - 3}px, 0, 0)`;
    if (!animate) requestAnimationFrame(() => { thumb.style.transition = ''; });
  };

  const select = (btn, animate = true) => {
    buttons.forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
    place(btn, animate);
    onChange(btn.dataset.value);
  };

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => select(btn));
    btn.addEventListener('keydown', (event) => {
      const dir = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!dir) return;
      event.preventDefault();
      const next = buttons[(buttons.indexOf(btn) + dir + buttons.length) % buttons.length];
      next.focus();
      select(next);
    });
  });

  const initialBtn = buttons.find((b) => b.dataset.value === String(initial)) ?? buttons[0];
  // Fonts can settle after first paint, so re-measure once everything is ready.
  requestAnimationFrame(() => place(initialBtn, false));
  window.addEventListener('resize', () => {
    const current = buttons.find((b) => b.getAttribute('aria-checked') === 'true') ?? buttons[0];
    place(current, false);
  });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => place(buttons.find((b) => b.getAttribute('aria-checked') === 'true') ?? buttons[0], false));
  }
  return { select: (value) => { const b = buttons.find((x) => x.dataset.value === String(value)); if (b) select(b); } };
}

wireSegment(el.styleSeg, el.styleThumb, state.style, (value) => {
  state.style = value;
  el.html.dataset.style = value;
});
wireSegment(el.barsSeg, el.barsThumb, state.bars, (value) => {
  state.bars = Number(value);
});

el.shuffle.addEventListener('click', () => {
  state.seed = Math.floor(Math.random() * 100000);
  el.seed.value = String(state.seed);
});
el.seed.addEventListener('change', () => {
  const v = Number(el.seed.value);
  state.seed = Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
  el.seed.value = String(state.seed);
});

/* ------------------------------------------------------------- generate -- */

el.generate.addEventListener('click', () => { void runGenerate(); });

async function runGenerate() {
  if (state.busy) return;
  state.busy = true;
  clearError();
  stopPlayback();
  el.generate.disabled = true;
  el.progress.dataset.active = 'true';

  const seedValue = Number(el.seed.value);
  state.seed = Number.isFinite(seedValue) ? Math.max(0, Math.floor(seedValue)) : 0;

  const options = { seed: state.seed, style: state.style, bars: state.bars };

  try {
    const payload = worker ? await generateInWorker(options) : await generateOnMainThread(options);
    adoptResult(payload);
  } catch (error) {
    showError(`Generation failed: ${error.message || error}`);
  } finally {
    state.busy = false;
    el.generate.disabled = false;
    el.progress.dataset.active = 'false';
  }
}

function generateInWorker(options) {
  return new Promise((resolve, reject) => {
    const id = ++state.requestId;
    const onMessage = (event) => {
      const data = event.data;
      if (data.id !== id) return;
      if (data.type === 'done') {
        worker.removeEventListener('message', onMessage);
        resolve(data);
      } else if (data.type === 'error') {
        worker.removeEventListener('message', onMessage);
        reject(new Error(data.message));
      }
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', (e) => reject(new Error(e.message || 'worker error')), { once: true });
    worker.postMessage({ id, options });
  });
}

async function generateOnMainThread(options) {
  const mod = await import('../dist/index.js');
  // Yield a frame so the breathing bar actually paints before we block.
  await new Promise((r) => setTimeout(r, 32));
  const result = mod.generate(options);
  return {
    session: result.session,
    sampleRate: result.audio.sampleRate,
    left: result.audio.left,
    right: result.audio.right,
    wav: mod.toWav(result),
  };
}

function adoptResult(payload) {
  // The AudioContext is deliberately NOT created here: browsers want a user
  // gesture first, and we do not need one until the play button is pressed.
  state.channels = { left: payload.left, right: payload.right, sampleRate: payload.sampleRate };
  state.duration = payload.left.length / payload.sampleRate;
  state.buffer = null;
  state.session = payload.session;
  state.wavBytes = payload.wav;
  state.peaks = null;
  state.offset = 0;
  state.reveal = reduceMotion ? 1 : 0;
  state.revealStart = performance.now();

  el.empty.dataset.hidden = 'true';
  el.play.disabled = false;
  el.download.disabled = false;
  el.downloadJson.disabled = false;

  renderHeader(payload.session);
  renderRibbon(payload.session);
  resizeCanvas();
}

/* --------------------------------------------------------------- header -- */

function renderHeader(session) {
  const preset = STYLES[session.style];
  el.tStyle.textContent = preset ? preset.label : session.style;
  el.tKey.textContent = session.key;
  el.tBpm.textContent = String(session.bpm);
  el.mCamelot.textContent = session.camelot;
  el.mCamelot.parentElement.title =
    session.camelotKey === session.key
      ? `${session.keyName}`
      : `${session.keyName} \u2014 same note collection as ${session.camelotKey}`;
  el.mBars.textContent = String(session.bars);
  el.mLength.textContent = fmtTime(session.durationSec);
  el.mPeak.textContent = `${session.stats.peakDb.toFixed(1)} dB`;
  el.mSeed.textContent = String(session.seed);
  el.tTotal.textContent = fmtTime(session.durationSec);
  document.title = `groovebox — ${preset ? preset.label : session.style} ${session.key} ${session.bpm}bpm`;
}

function renderRibbon(session) {
  [...el.ribbon.querySelectorAll('.chord')].forEach((n) => n.remove());
  const frag = document.createDocumentFragment();
  session.chords.forEach((chord, index) => {
    const node = document.createElement('span');
    node.className = 'chord';
    node.dataset.index = String(index);
    node.innerHTML = `<span class="bar-no">${chord.bar + 1}</span>${chord.name}`;
    frag.appendChild(node);
  });
  el.ribbon.appendChild(frag);
  el.underline.style.opacity = '0';
}

let lastChordIndex = -1;
function updateRibbon(index) {
  if (index === lastChordIndex) return;
  lastChordIndex = index;
  const chips = el.ribbon.querySelectorAll('.chord');
  chips.forEach((chip, i) => { chip.dataset.current = String(i === index); });
  const active = chips[index];
  if (!active) { el.underline.style.opacity = '0'; return; }
  const left = active.offsetLeft + 10;
  const width = Math.max(8, active.offsetWidth - 20);
  el.underline.style.opacity = '1';
  el.underline.style.transform = `translate3d(${left}px, 0, 0) scaleX(${width})`;
  // Keep the current chord in view without yanking the page around.
  const view = el.ribbon;
  if (active.offsetLeft < view.scrollLeft + 24 || active.offsetLeft + active.offsetWidth > view.scrollLeft + view.clientWidth - 24) {
    view.scrollTo({ left: Math.max(0, active.offsetLeft - view.clientWidth * 0.35), behavior: reduceMotion ? 'auto' : 'smooth' });
  }
}

/* ---------------------------------------------------------------- audio -- */

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.72;
    gainNode = audioCtx.createGain();
    gainNode.gain.value = 0.92;
    gainNode.connect(analyser);
    analyser.connect(audioCtx.destination);
    freqData = new Uint8Array(analyser.frequencyBinCount);
  }
  return audioCtx;
}

function currentTime() {
  if (!state.channels) return 0;
  if (!state.playing) return state.offset;
  return Math.min(state.duration, state.offset + (audioCtx.currentTime - state.startedAt));
}

/** Decode-free: copy the engine's Float32 channels straight into an AudioBuffer. */
function ensureBuffer(ctx) {
  if (state.buffer) return state.buffer;
  const { left, right, sampleRate } = state.channels;
  const buffer = ctx.createBuffer(2, left.length, sampleRate);
  buffer.copyToChannel(left, 0);
  buffer.copyToChannel(right, 1);
  state.buffer = buffer;
  return buffer;
}

function startPlayback(from) {
  if (!state.channels) return;
  const ctx = ensureAudio();
  const audioBuffer = ensureBuffer(ctx);
  if (ctx.state === 'suspended') void ctx.resume();
  stopSource();
  sourceNode = ctx.createBufferSource();
  sourceNode.buffer = audioBuffer;
  sourceNode.connect(gainNode);
  sourceNode.onended = () => {
    if (!state.playing) return;
    // Natural end of the track.
    state.playing = false;
    state.offset = 0;
    el.play.dataset.playing = 'false';
    el.play.setAttribute('aria-label', 'Play');
  };
  state.offset = Math.max(0, Math.min(state.duration - 0.01, from));
  state.startedAt = ctx.currentTime;
  sourceNode.start(0, state.offset);
  state.playing = true;
  el.play.dataset.playing = 'true';
  el.play.setAttribute('aria-label', 'Pause');
}

function stopSource() {
  if (sourceNode) {
    sourceNode.onended = null;
    try { sourceNode.stop(); } catch { /* already stopped */ }
    sourceNode.disconnect();
    sourceNode = null;
  }
}

function pausePlayback() {
  if (!state.playing) return;
  state.offset = currentTime();
  stopSource();
  state.playing = false;
  el.play.dataset.playing = 'false';
  el.play.setAttribute('aria-label', 'Play');
}

function stopPlayback() {
  pausePlayback();
  state.offset = 0;
}

el.play.addEventListener('click', () => {
  if (!state.channels) return;
  if (state.playing) pausePlayback();
  else startPlayback(state.offset >= state.duration - 0.05 ? 0 : state.offset);
});

document.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.target.tagName === 'INPUT') return;
  event.preventDefault();
  el.play.click();
});

/* ------------------------------------------------------------- scrubbing - */

function seekFromEvent(event) {
  if (!state.channels) return;
  const rect = el.track.getBoundingClientRect();
  const x = (event.touches ? event.touches[0].clientX : event.clientX) - rect.left;
  const fraction = Math.max(0, Math.min(1, x / rect.width));
  const target = fraction * state.duration;
  if (state.playing) startPlayback(target);
  else state.offset = target;
}

let scrubbing = false;
el.track.addEventListener('pointerdown', (event) => {
  scrubbing = true;
  el.track.setPointerCapture(event.pointerId);
  seekFromEvent(event);
});
el.track.addEventListener('pointermove', (event) => { if (scrubbing) seekFromEvent(event); });
el.track.addEventListener('pointerup', () => { scrubbing = false; });
el.track.addEventListener('keydown', (event) => {
  if (!state.channels) return;
  const step = event.shiftKey ? 10 : 3;
  if (event.key === 'ArrowRight') { event.preventDefault(); seekTo(currentTime() + step); }
  if (event.key === 'ArrowLeft') { event.preventDefault(); seekTo(currentTime() - step); }
});
function seekTo(seconds) {
  const target = Math.max(0, Math.min(state.duration, seconds));
  if (state.playing) startPlayback(target);
  else state.offset = target;
}

/* ------------------------------------------------------------ downloads -- */

function download(bytes, filename, type) {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

el.download.addEventListener('click', () => {
  if (!state.wavBytes || !state.session) return;
  const s = state.session;
  download(state.wavBytes, `groovebox-${s.style}-${s.seed}.wav`, 'audio/wav');
});
el.downloadJson.addEventListener('click', () => {
  if (!state.session) return;
  const s = state.session;
  download(new TextEncoder().encode(JSON.stringify(s, null, 2)), `groovebox-${s.style}-${s.seed}.json`, 'application/json');
});

/* ---------------------------------------------------------------- canvas - */

const ctx2d = el.canvas.getContext('2d');
let dpr = 1;
let cw = 0;
let ch = 0;

function resizeCanvas() {
  const rect = el.canvas.getBoundingClientRect();
  dpr = Math.min(2, window.devicePixelRatio || 1);
  cw = Math.max(1, Math.round(rect.width));
  ch = Math.max(1, Math.round(rect.height));
  el.canvas.width = Math.round(cw * dpr);
  el.canvas.height = Math.round(ch * dpr);
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  state.peaks = null;
}
new ResizeObserver(resizeCanvas).observe(el.canvas);
resizeCanvas();

/** Min/max envelope per pixel column -- computed once per size, not per frame. */
function computePeaks() {
  const columns = cw;
  const { left, right } = state.channels;
  const peaks = new Float32Array(columns * 2);
  const perColumn = left.length / columns;
  for (let x = 0; x < columns; x++) {
    const from = Math.floor(x * perColumn);
    const to = Math.min(left.length, Math.floor((x + 1) * perColumn));
    let min = 0;
    let max = 0;
    // Stride large buffers: 4x fewer reads, visually identical.
    const stride = perColumn > 2048 ? 4 : 1;
    for (let i = from; i < to; i += stride) {
      const v = (left[i] + right[i]) * 0.5;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    peaks[x * 2] = min;
    peaks[x * 2 + 1] = max;
  }
  state.peaks = peaks;
  state.peakWidth = columns;
}

function easeOutCubic(x) { return 1 - Math.pow(1 - x, 3); }

function draw() {
  requestAnimationFrame(draw);
  if (cw === 0 || ch === 0) return;

  const accent = cssVar('--accent') || '#ffb37a';
  const accent2 = cssVar('--accent-2') || '#c98bff';

  ctx2d.clearRect(0, 0, cw, ch);

  if (!state.channels || !state.session) return;
  if (!state.peaks || state.peakWidth !== cw) computePeaks();

  if (state.reveal < 1) {
    const t = (performance.now() - state.revealStart) / 820;
    state.reveal = t >= 1 ? 1 : easeOutCubic(Math.max(0, t));
  }

  const session = state.session;
  const duration = state.duration;
  const now = currentTime();
  const playFraction = duration > 0 ? now / duration : 0;

  const waveTop = ch * 0.07;
  const waveH = ch * 0.58;
  const waveMid = waveTop + waveH / 2;
  const specTop = waveTop + waveH + ch * 0.06;
  const specH = Math.max(12, ch - specTop - ch * 0.06);

  /* ---- energy curve: a soft filled area behind everything --------------- */
  const energy = session.energyCurve;
  if (energy && energy.length > 1) {
    ctx2d.save();
    const grad = ctx2d.createLinearGradient(0, waveTop, 0, waveTop + waveH);
    grad.addColorStop(0, `${accent}22`);
    grad.addColorStop(1, `${accent}00`);
    ctx2d.beginPath();
    ctx2d.moveTo(0, waveTop + waveH);
    for (let x = 0; x <= cw; x += 2) {
      const i = Math.min(energy.length - 1, Math.floor((x / cw) * energy.length));
      const y = waveTop + waveH - energy[i] * waveH * 0.92;
      ctx2d.lineTo(x, y);
    }
    ctx2d.lineTo(cw, waveTop + waveH);
    ctx2d.closePath();
    ctx2d.fillStyle = grad;
    ctx2d.fill();
    ctx2d.restore();
  }

  /* ---- mirrored waveform ------------------------------------------------ */
  const peaks = state.peaks;
  const revealX = cw * state.reveal;
  const playedGrad = ctx2d.createLinearGradient(0, waveMid - waveH / 2, 0, waveMid + waveH / 2);
  playedGrad.addColorStop(0, accent2);
  playedGrad.addColorStop(0.5, accent);
  playedGrad.addColorStop(1, accent2);

  for (let x = 0; x < cw; x++) {
    if (x > revealX) break;
    const min = peaks[x * 2];
    const max = peaks[x * 2 + 1];
    const amp = Math.max(Math.abs(min), Math.abs(max));
    // Mirror around the centre line for a symmetric, "mastered" look.
    let h = amp * waveH * 0.5;
    if (state.reveal < 1) h *= 0.35 + 0.65 * state.reveal;
    const played = x / cw <= playFraction;
    ctx2d.fillStyle = played ? playedGrad : 'rgba(255,255,255,0.22)';
    ctx2d.fillRect(x, waveMid - Math.max(0.7, h), 1, Math.max(1.4, h * 2));
  }

  /* ---- section dividers ------------------------------------------------- */
  ctx2d.save();
  ctx2d.font = '600 9.5px -apple-system, system-ui, sans-serif';
  ctx2d.textBaseline = 'top';
  for (const section of session.sections) {
    if (section.startBar === 0) continue;
    const x = Math.round((section.startSec / duration) * cw) + 0.5;
    if (x > revealX) continue;
    ctx2d.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(x, waveTop);
    ctx2d.lineTo(x, waveTop + waveH);
    ctx2d.stroke();
    ctx2d.fillStyle = 'rgba(255,255,255,0.32)';
    ctx2d.fillText(section.name.toUpperCase(), x + 5, waveTop + 1);
  }
  ctx2d.restore();

  /* ---- live spectrum ---------------------------------------------------- */
  if (analyser && freqData) {
    analyser.getByteFrequencyData(freqData);
    const bars = 64;
    if (!state.spectrum || state.spectrum.length !== bars) state.spectrum = new Float32Array(bars);
    const spectrum = state.spectrum;
    const nyquistBins = freqData.length;
    for (let b = 0; b < bars; b++) {
      // Log-ish bin mapping so the low end is not crammed into two pixels.
      const from = Math.floor(Math.pow(b / bars, 2.1) * nyquistBins);
      const to = Math.max(from + 1, Math.floor(Math.pow((b + 1) / bars, 2.1) * nyquistBins));
      let sum = 0;
      for (let i = from; i < to; i++) sum += freqData[i];
      const value = (sum / (to - from)) / 255;
      const boosted = Math.min(1, value * (1 + b / bars));
      // Fast rise, eased decay -- bars fall like a real meter.
      spectrum[b] = boosted > spectrum[b] ? boosted : spectrum[b] * (reduceMotion ? 0.5 : 0.88);
    }

    const gap = 2;
    const barW = Math.max(1, (cw - gap * (bars - 1)) / bars);
    for (let b = 0; b < bars; b++) {
      const h = Math.max(1.5, spectrum[b] * specH);
      const x = b * (barW + gap);
      const t = b / bars;
      const grad = ctx2d.createLinearGradient(0, specTop + specH - h, 0, specTop + specH);
      grad.addColorStop(0, accent);
      grad.addColorStop(1, `${accent2}55`);
      ctx2d.globalAlpha = 0.35 + 0.55 * (1 - t) + spectrum[b] * 0.3;
      ctx2d.fillStyle = grad;
      ctx2d.fillRect(x, specTop + specH - h, barW, h);
    }
    ctx2d.globalAlpha = 1;
  }

  /* ---- playhead --------------------------------------------------------- */
  if (state.reveal > 0.35) {
    const px = Math.round(playFraction * cw) + 0.5;
    const glow = ctx2d.createLinearGradient(px - 22, 0, px + 22, 0);
    glow.addColorStop(0, `${accent}00`);
    glow.addColorStop(0.5, `${accent}55`);
    glow.addColorStop(1, `${accent}00`);
    ctx2d.fillStyle = glow;
    ctx2d.fillRect(px - 22, waveTop, 44, waveH);

    ctx2d.fillStyle = '#ffffff';
    ctx2d.fillRect(px - 0.5, waveTop - 3, 1.6, waveH + 6);
    ctx2d.beginPath();
    ctx2d.arc(px, waveTop - 4, 3, 0, Math.PI * 2);
    ctx2d.fill();
  }

  /* ---- transport readouts ---------------------------------------------- */
  el.fill.style.transform = `scaleX(${playFraction})`;
  el.head.style.transform = `translate3d(${playFraction * el.track.clientWidth}px, 0, 0)`;
  el.track.setAttribute('aria-valuenow', String(Math.round(playFraction * 100)));
  el.tNow.textContent = fmtTime(now);

  const bar = Math.floor((now / duration) * session.bars);
  let sectionName = session.sections[0] ? session.sections[0].name : '';
  for (const section of session.sections) if (bar >= section.startBar) sectionName = section.name;
  if (el.tSection.textContent !== sectionName) el.tSection.textContent = sectionName;

  let chordIndex = 0;
  for (let i = 0; i < session.chords.length; i++) if (session.chords[i].bar <= bar) chordIndex = i;
  updateRibbon(chordIndex);
}

requestAnimationFrame(draw);

/* Generate one track straight away so the page is never an empty shell. */
window.addEventListener('load', () => {
  setTimeout(() => { void runGenerate(); }, reduceMotion ? 0 : 420);
});
