# Song Analyzer

A client-side tool for mapping the structure of a track: load an audio file, see its
waveform, lay a BPM bar-grid over it, drop color-coded **section markers** (intro / verse /
chorus / drop …), and sketch an **arrangement** of instrument lanes with draggable blocks
and fades. Everything runs in the browser — no backend, no upload. Markers and arrangement
persist per file via `localStorage`, and you can copy the whole map out as TSV.

Live: https://song-analyzer.rupel.xyz

## Features

- Waveform rendering via the Web Audio API (`decodeAudioData` + downsampled peaks).
- BPM control with tap-tempo, adjustable bar-1 offset, and a toggleable bar grid.
- Section markers: tap to place, drag to move, drag off the edge to delete, rename, jump.
- Arrangement lanes with blocks whose **four corners drag independently** — bottom corners
  resize start/end, top corners set fade-in/fade-out — bar-snapped.
- Per-file persistence (keyed by name + size) and TSV export to the clipboard.
- Touch-friendly (built for mobile use).

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
