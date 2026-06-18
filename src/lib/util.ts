import type { Peak } from './types';

/** Format seconds as m:ss. */
export function fmtTime(s: number): string {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

/** Lighten a #rrggbb hex by a fixed amount, for block outline contrast. */
export function lighten(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) + 40;
  let g = ((n >> 8) & 255) + 40;
  let b = (n & 255) + 40;
  r = Math.min(255, r);
  g = Math.min(255, g);
  b = Math.min(255, b);
  return `rgb(${r},${g},${b})`;
}

/** Average all channels of an AudioBuffer into a single mono track. */
export function mixDown(buffer: AudioBuffer): Float32Array {
  const len = buffer.length;
  const out = new Float32Array(len);
  const chs = buffer.numberOfChannels;
  for (let c = 0; c < chs; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += data[i] / chs;
  }
  return out;
}

/** Downsample an AudioBuffer to `buckets` [min,max] peak pairs for drawing. */
export function computePeaks(buffer: AudioBuffer, buckets: number): Peak[] {
  const ch =
    buffer.numberOfChannels > 1 ? mixDown(buffer) : buffer.getChannelData(0);
  const blockSize = Math.floor(ch.length / buckets);
  const peaks: Peak[] = new Array(buckets);
  for (let i = 0; i < buckets; i++) {
    let mn = 1.0;
    let mx = -1.0;
    const start = i * blockSize;
    for (let j = 0; j < blockSize; j++) {
      const v = ch[start + j];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    peaks[i] = [mn, mx];
  }
  return peaks;
}

/** Clipboard fallback for older Android webviews. */
export function fallbackCopy(text: string, done: () => void): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    done();
  } catch {
    /* ignore */
  }
  document.body.removeChild(ta);
}
