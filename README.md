# Song Map

A client-side tool for mapping the structure of a track: load an audio file, see its
waveform, lay a BPM bar-grid over it, drop color-coded **section markers** (intro / verse /
chorus / drop …), and sketch an **arrangement** of instrument lanes with blocks
and fades. Everything runs in the browser — no backend, no upload. Markers and arrangement
persist per file via `localStorage`, and you can copy the whole map out as TSV.

Live: https://songanalyzer.rupel.xyz

## Features

- Waveform rendering via the Web Audio API (`decodeAudioData` + downsampled peaks).
- BPM control with tap-tempo, adjustable bar-1 offset, and a toggleable bar grid.
- Transport: play/pause plus `«bar` / `bar»` buttons that jump the playhead one whole bar at
  a time (snapped to bar starts) for quick re-listening.
- Section markers: tap a section to place one (auto-selected). A marker is grabbed only by its
  label, so tapping elsewhere on the waveform just seeks — even while a marker is selected, so
  you can re-listen mid-edit. Edit from a popup pinned to the marker: move it by the bar,
  rename, delete.
- Arrangement lanes: tap an empty lane for a default block, or **drag from where you press to
  size one** (bar-snapped). Tap a block to select it; a popup above sets start / end and one
  below sets fade-in / fade-out. Hold a +/− stepper to repeat it.
- Start / end move that edge and carry the fade rigidly — the fade length (and the block's
  shape) never changes, and no fade is invented where there wasn't one.
- Per-file persistence (keyed by name + size); copy the whole map to the clipboard as TSV, and
  import it back the same way (marker times round to whole seconds, block bars are exact).
- Touch-first: vertical drags scroll and pinch zooms as normal; a horizontal drag on a lane
  sizes a new block. Edit popups stay anchored to whatever you've selected (built for mobile).

## Development

The toolchain is pinned in a Nix flake and loaded automatically by direnv:

```sh
direnv allow          # one-time: loads bun + node from the flake on cd
bun install
bun run dev           # http://localhost:5173
```

Without direnv, enter the shell explicitly: `nix develop -c bun run dev`.

Other scripts:

```sh
bun run check         # svelte-check (TypeScript)
bun run build         # production build → dist/
bun run preview       # serve the built dist/ locally
```

## Deployment

Static site on **Cloudflare Pages** (git-connected):

- Build command: `bun run build`
- Build output directory: `dist`

## Stack

Svelte 5 (runes) · Vite · TypeScript · bun · Nix flake + direnv
