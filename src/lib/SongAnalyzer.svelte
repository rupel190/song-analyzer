<script lang="ts">
  import type { Section, Marker, Block, Lane, Peak, SavedState } from './types';
  import { fmtTime, lighten, computePeaks, fallbackCopy } from './util';

  // ── Persistence ──────────────────────────────────────────────────────────
  // Wrap localStorage with an in-memory fallback so the app still works where
  // storage is unavailable (e.g. sandboxed previews). On a real HTTPS origin
  // this persists markers + BPM + arrangement per loaded file.
  const memFallback: Record<string, unknown> = {};
  const store = {
    read<T>(key: string): T | null {
      try {
        const raw = window.localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : null;
      } catch {
        return (memFallback[key] as T) ?? null;
      }
    },
    write(key: string, val: unknown): void {
      try {
        window.localStorage.setItem(key, JSON.stringify(val));
      } catch {
        memFallback[key] = val;
      }
    },
  };

  // Section presets — color-coded, tap to set marker type quickly.
  const SECTIONS: Section[] = [
    { name: 'Intro', color: '#6b7a8f' },
    { name: 'Verse', color: '#4a8fb8' },
    { name: 'Pre', color: '#7b9e7e' },
    { name: 'Chorus', color: '#d4915d' },
    { name: 'Drop', color: '#c45b5b' },
    { name: 'Bridge', color: '#9a7bb8' },
    { name: 'Break', color: '#8f8f6b' },
    { name: 'Outro', color: '#6b7a8f' },
  ];

  // Default instrument lanes for a fresh track. Stored per-file once edited.
  const DEFAULT_LANES: { name: string; color: string }[] = [
    { name: 'Kick', color: '#c45b5b' },
    { name: 'Bass', color: '#d4915d' },
    { name: 'Drums', color: '#9a7bb8' },
    { name: 'Lead', color: '#4a8fb8' },
    { name: 'Pads', color: '#7b9e7e' },
    { name: 'FX', color: '#8f8f6b' },
  ];

  const WAVE_H = 200;
  const GAP = 10;
  const LANE_H = 46;
  const LANE_GAP = 6;
  const FADE_HANDLE = 12;
  const EDGE_GRAB = 9;
  const EDGE_DELETE_PX = 28; // how far past an edge before a marker is armed for deletion
  const beatsPerBar = 4;

  let laneIdCounter = 1;
  let blockIdCounter = 1;
  const makeLane = (name: string, color: string): Lane => ({
    id: `lane_${laneIdCounter++}_${Date.now()}`,
    name,
    color,
    blocks: [],
  });

  // ── Reactive state ─────────────────────────────────────────────────────────
  let fileName = $state<string | null>(null);
  let fileKey = $state<string | null>(null);
  let peaks = $state<Peak[] | null>(null);
  let duration = $state(0);
  let bpm = $state(120);
  let firstBeat = $state(0); // offset (s) of bar 1
  let showGrid = $state(true);
  let markers = $state<Marker[]>([]);
  let playing = $state(false);
  let position = $state(0);
  let activeSection = $state<Section | null>(null);
  let loading = $state(false);
  let copied = $state(false);
  let lanes = $state<Lane[]>([]);
  let plotWidth = $state(600); // shared canvas width for waveform + lanes
  let hoverMarker = $state(false);
  let dragging = $state(false);
  let armedDelete = $state(false);
  let laneArmedDelete = $state(false);
  let lanePreview = $state<{ laneId: string; from: number; to: number } | null>(null);
  let confirmClear = $state(false);
  let editingLaneId = $state<string | null>(null);
  let editingName = $state('');

  // ── Non-reactive refs ───────────────────────────────────────────────────────
  let audioCtx: AudioContext | null = null;
  let buffer: AudioBuffer | null = null;
  let source: AudioBufferSourceNode | null = null;
  let startedAt = 0; // ctx time when playback began
  let startOffset = 0; // buffer offset when playback began
  let raf = 0;
  let canvasEl = $state<HTMLCanvasElement>();
  let wrapEl = $state<HTMLDivElement>();
  let tapsRef: number[] = [];

  type Mode = 'resizeL' | 'resizeR' | 'fadeIn' | 'fadeOut' | 'move' | 'draw';
  interface LaneHit {
    laneId: string;
    blockId: string | null;
    mode: Mode;
    laneIndex?: number;
  }
  interface LaneDrag extends LaneHit {
    startBarFloat: number;
    orig: Block | null;
    drawFromBar: number;
    previewFrom?: number;
    previewTo?: number;
  }
  let dragRef: { id: number } | null = null;
  let laneDragRef: LaneDrag | null = null;

  // ── Derived bar helpers ──────────────────────────────────────────────────────
  const secPerBar = $derived((60 / bpm) * beatsPerBar);
  const totalBars = $derived(
    duration && secPerBar > 0
      ? Math.max(1, Math.ceil((duration - firstBeat) / secPerBar))
      : 0
  );
  const currentBar = $derived(duration ? barAtTime(position) : 0);
  const hasBlocks = $derived(lanes.some((l) => l.blocks.length > 0));
  const showFooter = $derived(markers.length > 0 || hasBlocks);
  const cursor = $derived(
    laneArmedDelete
      ? 'no-drop'
      : dragging
        ? armedDelete
          ? 'no-drop'
          : 'grabbing'
        : hoverMarker
          ? 'grab'
          : activeSection
            ? 'copy'
            : 'crosshair'
  );

  // Hoisted (function declarations) so the derived values above can reference them.
  function barAtTime(t: number) {
    return Math.floor((t - firstBeat) / secPerBar) + 1;
  }
  function barFloatAtTime(t: number) {
    return (t - firstBeat) / secPerBar + 1;
  }
  function timeAtBar(bar: number) {
    return firstBeat + (bar - 1) * secPerBar;
  }
  // Snap a fractional bar to the nearest integer bar line, clamped to the track.
  function snapBar(bar: number) {
    return Math.max(1, Math.min(totalBars + 1, Math.round(bar)));
  }
  function clamp(v: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, v));
  }

  // ── Effects ──────────────────────────────────────────────────────────────────
  // Measure the waveform wrap on mount + resize; both canvases use this width.
  $effect(() => {
    if (!wrapEl) return;
    const el = wrapEl;
    const measure = () => (plotWidth = el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });

  // Load persisted state whenever a file is identified.
  $effect(() => {
    const key = fileKey;
    if (!key) return;
    const saved = store.read<SavedState>(`song:${key}`);
    if (saved) {
      markers = saved.markers || [];
      if (saved.bpm) bpm = saved.bpm;
      if (typeof saved.firstBeat === 'number') firstBeat = saved.firstBeat;
      lanes =
        saved.lanes && saved.lanes.length
          ? saved.lanes
          : DEFAULT_LANES.map((l) => makeLane(l.name, l.color));
    } else {
      markers = [];
      lanes = DEFAULT_LANES.map((l) => makeLane(l.name, l.color));
    }
  });

  // Persist on change.
  $effect(() => {
    if (!fileKey) return;
    store.write(`song:${fileKey}`, { markers, bpm, firstBeat, fileName, lanes });
  });

  // Position tracking: one rAF loop for the lifetime of the component; each frame
  // reads the *current* playing/position so it never needs to re-subscribe.
  $effect(() => {
    const tick = () => {
      if (playing && audioCtx) {
        const elapsed = audioCtx.currentTime - startedAt;
        const pos = startOffset + elapsed;
        position = pos >= duration ? duration : pos;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  // Canvas draw — auto-tracks every reactive value it reads (no manual dep list).
  $effect(() => {
    draw();
  });

  // ── File decode ──────────────────────────────────────────────────────────────
  async function handleFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    loading = true;
    fileName = file.name;
    const key = `${file.name}_${file.size}`; // keep separate marker sets per file
    try {
      const arrayBuf = await file.arrayBuffer();
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = audioCtx ?? new Ctx();
      audioCtx = ctx;
      const buf = await ctx.decodeAudioData(arrayBuf.slice(0));
      buffer = buf;
      duration = buf.duration;
      peaks = computePeaks(buf, 2000);
      position = 0;
      startOffset = 0;
      fileKey = key;
    } catch (err) {
      alert("Couldn't decode that file. Try a WAV, MP3, or M4A.");
      console.error(err);
    } finally {
      loading = false;
    }
  }

  // ── Playback ───────────────────────────────────────────────────────────────────
  function stopSource() {
    if (source) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      source.disconnect();
      source = null;
    }
  }

  function playFrom(offset: number) {
    if (!audioCtx || !buffer) return;
    stopSource();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(audioCtx.destination);
    src.start(0, Math.max(0, offset));
    src.onended = () => {
      if (source === src) playing = false;
    };
    source = src;
    startedAt = audioCtx.currentTime;
    startOffset = offset;
    playing = true;
  }

  function togglePlay() {
    if (!buffer) return;
    if (playing) {
      if (audioCtx) {
        const elapsed = audioCtx.currentTime - startedAt;
        startOffset = startOffset + elapsed;
      }
      stopSource();
      playing = false;
    } else {
      playFrom(position);
    }
  }

  // ── Canvas geometry helpers ──────────────────────────────────────────────────
  const timeAtX = (clientX: number): number | null => {
    if (!canvasEl || !duration) return null;
    const rect = canvasEl.getBoundingClientRect();
    const frac = clamp((clientX - rect.left) / rect.width, 0, 1);
    return frac * duration;
  };

  function seekTo(t: number) {
    position = t;
    if (playing) playFrom(t);
    else startOffset = t;
  }

  function localPt(e: PointerEvent) {
    const rect = canvasEl!.getBoundingClientRect();
    return { px: e.clientX - rect.left, py: e.clientY - rect.top };
  }

  const laneTimeToX = (t: number) => (duration ? (t / duration) * plotWidth : 0);
  const laneXToTime = (x: number) => (duration ? (x / plotWidth) * duration : 0);
  const laneXToBarFloat = (x: number) => barFloatAtTime(laneXToTime(x));

  // Hit-test a marker for grabbing — only the flag label (top band) grabs it.
  function markerAtX(clientX: number, clientY: number | null): Marker | null {
    if (!canvasEl || !duration) return null;
    const rect = canvasEl.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY == null ? null : clientY - rect.top;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return null;
    ctx.font = '11px ui-sans-serif, system-ui';
    if (py == null || py < 0 || py > 18) return null;
    for (const m of markers) {
      const mx = (m.t / duration) * rect.width;
      const flagW = ctx.measureText(m.name).width + 10;
      if (px >= mx - 2 && px <= mx + flagW + 2) return m;
    }
    return null;
  }

  // Which lane index does a y fall in (below the waveform band + gap)? -1 if none.
  function laneIndexAtY(py: number): number {
    const base = WAVE_H + GAP;
    if (py < base) return -1;
    const li = Math.floor((py - base) / (LANE_H + LANE_GAP));
    return li >= 0 && li < lanes.length ? li : -1;
  }

  // Hit-test a block within a lane. Four independent corners:
  //   bottom-left → resizeL (start), bottom-right → resizeR (end)
  //   top-left → fadeIn apex,        top-right → fadeOut apex
  function laneHitTest(px: number, py: number): LaneHit | null {
    const li = laneIndexAtY(py);
    if (li < 0) return null;
    const lane = lanes[li];
    const top = WAVE_H + GAP + li * (LANE_H + LANE_GAP);
    const innerTop = top + 6;
    const bot = top + LANE_H - 6;
    for (const bl of lane.blocks) {
      const x1 = laneTimeToX(timeAtBar(bl.startBar));
      const x2 = laneTimeToX(timeAtBar(bl.endBar));
      if (px < x1 - EDGE_GRAB || px > x2 + EDGE_GRAB) continue;
      const xIn = laneTimeToX(timeAtBar(bl.startBar + bl.fadeInBars));
      const xOut = laneTimeToX(timeAtBar(bl.endBar - bl.fadeOutBars));
      const nearTop = Math.abs(py - innerTop) < FADE_HANDLE;
      const nearBot = Math.abs(py - bot) < FADE_HANDLE;
      // top corners → drag a fade apex
      if (nearTop) {
        if (Math.abs(px - xIn) < FADE_HANDLE) return { laneId: lane.id, blockId: bl.id, mode: 'fadeIn' };
        if (Math.abs(px - xOut) < FADE_HANDLE) return { laneId: lane.id, blockId: bl.id, mode: 'fadeOut' };
      }
      // bottom corners → resize the time edges
      if (nearBot) {
        if (Math.abs(px - x1) < FADE_HANDLE) return { laneId: lane.id, blockId: bl.id, mode: 'resizeL' };
        if (Math.abs(px - x2) < FADE_HANDLE) return { laneId: lane.id, blockId: bl.id, mode: 'resizeR' };
      }
      // either vertical edge anywhere → resize
      if (Math.abs(px - x1) < EDGE_GRAB) return { laneId: lane.id, blockId: bl.id, mode: 'resizeL' };
      if (Math.abs(px - x2) < EDGE_GRAB) return { laneId: lane.id, blockId: bl.id, mode: 'resizeR' };
      if (px >= x1 && px <= x2) return { laneId: lane.id, blockId: bl.id, mode: 'move' };
    }
    return { laneId: lane.id, blockId: null, mode: 'draw', laneIndex: li };
  }

  // ── Pointer handlers ───────────────────────────────────────────────────────────
  function handlePointerDown(e: PointerEvent) {
    if (!duration || !canvasEl) return;
    const { px, py } = localPt(e);
    // ── lane region ──
    if (peaks && py >= WAVE_H + GAP) {
      const hit = laneHitTest(px, py);
      if (!hit) return;
      const lane = lanes.find((l) => l.id === hit.laneId);
      const bl = hit.blockId && lane ? lane.blocks.find((b) => b.id === hit.blockId) : null;
      laneDragRef = {
        ...hit,
        startBarFloat: laneXToBarFloat(px),
        orig: bl ? { ...bl } : null,
        drawFromBar: snapBar(laneXToBarFloat(px)),
      };
      laneArmedDelete = false;
      canvasEl.setPointerCapture(e.pointerId);
      return;
    }
    // ── waveform / marker region ──
    const hit = markerAtX(e.clientX, e.clientY);
    if (hit) {
      dragRef = { id: hit.id };
      dragging = true;
      armedDelete = false;
      canvasEl.setPointerCapture(e.pointerId);
      return;
    }
    const t = timeAtX(e.clientX);
    if (t == null) return;
    if (activeSection) {
      addMarker(t, activeSection);
      seekTo(t);
    } else {
      seekTo(t);
    }
  }

  function handlePointerMove(e: PointerEvent) {
    // ── lane drag in progress ──
    const ld = laneDragRef;
    if (ld) {
      const { px, py } = localPt(e);
      const barF = laneXToBarFloat(px);
      if (ld.mode === 'draw') {
        const fromBar = ld.drawFromBar;
        const toBar = snapBar(barF);
        ld.previewFrom = Math.min(fromBar, toBar);
        ld.previewTo = Math.max(fromBar, toBar);
        lanePreview = { laneId: ld.laneId, from: ld.previewFrom, to: ld.previewTo };
        return;
      }
      // only a whole-block move can be thrown out to delete
      if (ld.mode === 'move') {
        const offEdge =
          px > plotWidth + 28 ||
          py < WAVE_H + GAP - 28 ||
          py > WAVE_H + GAP + lanes.length * (LANE_H + LANE_GAP) + 28;
        if (laneArmedDelete !== offEdge) laneArmedDelete = offEdge;
      }
      const orig = ld.orig;
      if (!orig) return;
      const span = orig.endBar - orig.startBar;
      const deltaBars = barF - ld.startBarFloat;
      if (ld.mode === 'move') {
        const len = span;
        const ns = clamp(snapBar(orig.startBar + deltaBars), 1, totalBars + 1 - len);
        // whole-block move keeps fades relative (corners travel together)
        patchBlock(ld.laneId, ld.blockId!, { startBar: ns, endBar: ns + len });
      } else if (ld.mode === 'resizeL') {
        // bottom-left → start; hold the fade-in apex at its absolute bar
        const ns = clamp(snapBar(orig.startBar + deltaBars), 1, orig.endBar - 1);
        const apexInAbs = orig.startBar + orig.fadeInBars;
        const fadeIn = clamp(apexInAbs - ns, 0, orig.endBar - ns - orig.fadeOutBars);
        patchBlock(ld.laneId, ld.blockId!, { startBar: ns, fadeInBars: fadeIn });
      } else if (ld.mode === 'resizeR') {
        // bottom-right → end; hold the fade-out apex at its absolute bar
        const ne = clamp(snapBar(orig.endBar + deltaBars), orig.startBar + 1, totalBars + 1);
        const apexOutAbs = orig.endBar - orig.fadeOutBars;
        const fadeOut = clamp(ne - apexOutAbs, 0, ne - orig.startBar - orig.fadeInBars);
        patchBlock(ld.laneId, ld.blockId!, { endBar: ne, fadeOutBars: fadeOut });
      } else if (ld.mode === 'fadeIn') {
        // top-left → fade-in apex only; cannot cross the fade-out apex
        const apexBar = Math.round(barF);
        const fadeIn = clamp(apexBar - orig.startBar, 0, span - orig.fadeOutBars);
        patchBlock(ld.laneId, ld.blockId!, { fadeInBars: fadeIn });
      } else if (ld.mode === 'fadeOut') {
        // top-right → fade-out apex only; cannot cross the fade-in apex
        const apexBar = Math.round(barF);
        const fadeOut = clamp(orig.endBar - apexBar, 0, span - orig.fadeInBars);
        patchBlock(ld.laneId, ld.blockId!, { fadeOutBars: fadeOut });
      }
      return;
    }
    // ── marker drag / hover ──
    if (dragRef) {
      if (!canvasEl) return;
      const rect = canvasEl.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const offEdge = px > rect.width + EDGE_DELETE_PX || px < -EDGE_DELETE_PX;
      if (armedDelete !== offEdge) armedDelete = offEdge;
      const t = timeAtX(e.clientX);
      if (t == null) return;
      const id = dragRef.id;
      markers = markers.map((m) => (m.id === id ? { ...m, t } : m));
      return;
    }
    const over = !!markerAtX(e.clientX, e.clientY);
    if (hoverMarker !== over) hoverMarker = over;
  }

  function handlePointerUp(e: PointerEvent) {
    const ld = laneDragRef;
    if (ld) {
      if (ld.mode === 'draw' && ld.previewFrom != null && ld.previewTo != null) {
        if (ld.previewTo - ld.previewFrom >= 1) addBlock(ld.laneId, ld.previewFrom, ld.previewTo);
      } else if (laneArmedDelete && ld.blockId) {
        deleteBlock(ld.laneId, ld.blockId);
      }
      laneDragRef = null;
      laneArmedDelete = false;
      lanePreview = null;
      canvasEl?.releasePointerCapture(e.pointerId);
      return;
    }
    if (dragRef) {
      const id = dragRef.id;
      if (armedDelete) {
        markers = markers.filter((m) => m.id !== id);
      } else {
        markers = [...markers].sort((a, b) => a.t - b.t);
      }
      dragRef = null;
      dragging = false;
      armedDelete = false;
      canvasEl?.releasePointerCapture(e.pointerId);
    }
  }

  function handlePointerLeave() {
    if (!dragRef) hoverMarker = false;
  }

  // ── Markers ──────────────────────────────────────────────────────────────────
  function addMarker(atTime: number, section: Section) {
    const m: Marker = { id: Date.now() + Math.random(), t: atTime, name: section.name, color: section.color };
    markers = [...markers, m].sort((a, b) => a.t - b.t);
  }

  function renameMarker(id: number) {
    const m = markers.find((x) => x.id === id);
    const name = window.prompt('Marker name', m?.name || '');
    if (name != null) markers = markers.map((x) => (x.id === id ? { ...x, name } : x));
  }

  const deleteMarker = (id: number) => (markers = markers.filter((x) => x.id !== id));
  const jumpTo = (t: number) => seekTo(t);

  // ── TSV export ─────────────────────────────────────────────────────────────────
  function exportTSV() {
    const lines: string[] = [];
    lines.push(['Section', 'Time', 'Bar', 'BPM'].join('\t'));
    markers.forEach((m) => lines.push([m.name, fmtTime(m.t), String(barAtTime(m.t)), String(bpm)].join('\t')));
    if (hasBlocks) {
      lines.push('');
      lines.push(['Lane', 'StartBar', 'EndBar', 'FadeInBars', 'FadeOutBars', 'StartTime', 'EndTime'].join('\t'));
      lanes.forEach((l) =>
        l.blocks.forEach((b) =>
          lines.push(
            [
              l.name,
              String(b.startBar),
              String(b.endBar),
              String(b.fadeInBars ?? 0),
              String(b.fadeOutBars ?? 0),
              fmtTime(timeAtBar(b.startBar)),
              fmtTime(timeAtBar(b.endBar)),
            ].join('\t')
          )
        )
      );
    }
    const tsv = lines.join('\n');
    const done = () => {
      copied = true;
      setTimeout(() => (copied = false), 1600);
    };
    try {
      navigator.clipboard.writeText(tsv).then(done, () => fallbackCopy(tsv, done));
    } catch {
      fallbackCopy(tsv, done);
    }
  }

  // ── Lane / block operations ────────────────────────────────────────────────────
  function updateLaneBlocks(laneId: string, updater: (blocks: Block[]) => Block[]) {
    lanes = lanes.map((l) => (l.id === laneId ? { ...l, blocks: updater(l.blocks) } : l));
  }
  function addBlock(laneId: string, startBar: number, endBar: number) {
    const a = Math.min(startBar, endBar);
    const b = Math.max(startBar, endBar);
    if (b - a < 1) return;
    const block: Block = { id: `blk_${blockIdCounter++}_${Date.now()}`, startBar: a, endBar: b, fadeInBars: 0, fadeOutBars: 0 };
    updateLaneBlocks(laneId, (blocks) => [...blocks, block].sort((x, y) => x.startBar - y.startBar));
  }
  function patchBlock(laneId: string, blockId: string, patch: Partial<Block>) {
    updateLaneBlocks(laneId, (blocks) => blocks.map((bl) => (bl.id === blockId ? { ...bl, ...patch } : bl)));
  }
  function deleteBlock(laneId: string, blockId: string) {
    updateLaneBlocks(laneId, (blocks) => blocks.filter((bl) => bl.id !== blockId));
  }
  // Inline lane-name editing (replaces window.prompt — works on touch, and lets a
  // freshly-added lane be named immediately).
  function startEditLane(l: Lane) {
    editingLaneId = l.id;
    editingName = l.name;
  }
  function commitEditLane() {
    if (editingLaneId == null) return;
    const name = editingName.trim();
    if (name) lanes = lanes.map((x) => (x.id === editingLaneId ? { ...x, name } : x));
    editingLaneId = null;
  }
  const cancelEditLane = () => (editingLaneId = null);
  function autofocus(node: HTMLInputElement) {
    node.focus();
    node.select();
  }
  const removeLane = (laneId: string) => (lanes = lanes.filter((x) => x.id !== laneId));
  function addLane() {
    const palette = ['#c45b5b', '#d4915d', '#9a7bb8', '#4a8fb8', '#7b9e7e', '#8f8f6b', '#b8709e', '#5fb0a8'];
    const color = palette[lanes.length % palette.length];
    const lane = makeLane(`Lane ${lanes.length + 1}`, color);
    lanes = [...lanes, lane];
    startEditLane(lane); // open the name for editing right away
  }

  // ── BPM / grid controls ──────────────────────────────────────────────────────
  function onBpmInput(e: Event) {
    const v = +(e.target as HTMLInputElement).value || 0;
    bpm = Math.min(300, Math.max(40, v));
  }
  const nudgeFirstBeat = (d: number) => (firstBeat = Math.max(0, +(firstBeat + d).toFixed(3)));

  function tapTempo() {
    const now = performance.now();
    const taps = tapsRef.filter((t) => now - t < 2500);
    taps.push(now);
    tapsRef = taps;
    if (taps.length >= 2) {
      const intervals: number[] = [];
      for (let i = 1; i < taps.length; i++) intervals.push(taps[i] - taps[i - 1]);
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const detected = Math.round(60000 / avg);
      if (detected >= 40 && detected <= 300) bpm = detected;
    }
  }

  function clearAll() {
    if (confirmClear) {
      markers = [];
      lanes = lanes.map((l) => ({ ...l, blocks: [] }));
      confirmClear = false;
    } else {
      confirmClear = true;
      setTimeout(() => (confirmClear = false), 3000);
    }
  }

  // ── Canvas draw ──────────────────────────────────────────────────────────────
  function draw() {
    const canvas = canvasEl;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = plotWidth;
    const lanesH = lanes.length * (LANE_H + LANE_GAP);
    const laneTop0 = WAVE_H + GAP;
    const cssH = WAVE_H + (peaks ? GAP + lanesH : 0);
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const tx = (t: number) => (duration ? (t / duration) * cssW : 0);

    // ── waveform box ──
    ctx.fillStyle = '#16151a';
    ctx.fillRect(0, 0, cssW, WAVE_H);
    const mid = WAVE_H / 2;
    if (peaks) {
      ctx.fillStyle = '#5a93b8';
      const n = peaks.length;
      for (let i = 0; i < n; i++) {
        const x = (i / n) * cssW;
        const [mn, mx] = peaks[i];
        const y1 = mid - mx * (mid - 8);
        const y2 = mid - mn * (mid - 8);
        ctx.fillRect(x, y1, Math.max(1, cssW / n), Math.max(1, y2 - y1));
      }
    }

    // ── arrangement box ──
    if (peaks) {
      ctx.fillStyle = '#0f0e14';
      ctx.fillRect(0, laneTop0, cssW, lanesH);
      lanes.forEach((_lane, li) => {
        const top = laneTop0 + li * (LANE_H + LANE_GAP);
        ctx.fillStyle = '#15141b';
        ctx.fillRect(0, top, cssW, LANE_H);
      });
    }

    // ── bar grid ──
    if (showGrid && duration && secPerBar > 0) {
      let bar = 1;
      for (let t = firstBeat; t < duration; t += secPerBar) {
        const x = Math.round((t / duration) * cssW) + 0.5;
        const isFour = (bar - 1) % 4 === 0;
        ctx.strokeStyle = isFour ? 'rgba(240,233,216,0.42)' : 'rgba(240,233,216,0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, WAVE_H);
        ctx.stroke();
        if (peaks) {
          ctx.beginPath();
          ctx.moveTo(x, laneTop0);
          ctx.lineTo(x, cssH);
          ctx.stroke();
        }
        if (isFour && cssW > 360) {
          ctx.fillStyle = 'rgba(240,233,216,0.85)';
          ctx.font = '10px ui-monospace, monospace';
          ctx.fillText(String(bar), x + 3, 12);
        }
        bar++;
      }
    }

    // ── arrangement blocks + lane labels ──
    if (peaks) {
      const blkDrag = laneDragRef;
      lanes.forEach((lane, li) => {
        const top = laneTop0 + li * (LANE_H + LANE_GAP);
        const innerTop = top + 6;
        const bot = top + LANE_H - 6;
        lane.blocks.forEach((bl) => {
          const x1 = tx(timeAtBar(bl.startBar));
          const x2 = tx(timeAtBar(bl.endBar));
          const xIn = tx(timeAtBar(bl.startBar + bl.fadeInBars));
          const xOut = tx(timeAtBar(bl.endBar - bl.fadeOutBars));
          const bw = x2 - x1;
          const isArmed = laneArmedDelete && blkDrag && blkDrag.laneId === lane.id && blkDrag.blockId === bl.id;

          ctx.save();
          ctx.beginPath();
          ctx.moveTo(x1, bot); // bottom-left
          ctx.lineTo(xIn, innerTop); // up the fade-in ramp
          ctx.lineTo(xOut, innerTop); // across the top
          ctx.lineTo(x2, bot); // down the fade-out ramp
          ctx.closePath();
          ctx.fillStyle = isArmed ? '#c45b5b' : lane.color;
          ctx.globalAlpha = isArmed ? 0.3 : 0.85;
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.strokeStyle = isArmed ? '#c45b5b' : lighten(lane.color);
          ctx.lineWidth = 1.5;
          ctx.stroke();
          if (bw > 24) {
            // bottom corners = resize grips (start / end)
            ctx.fillStyle = 'rgba(240,233,216,0.92)';
            ctx.fillRect(x1 - 3, bot - 3, 6, 6);
            ctx.fillRect(x2 - 3, bot - 3, 6, 6);
            // top corners = fade apex grips
            ctx.fillStyle = 'rgba(212,145,93,0.95)';
            ctx.fillRect(xIn - 3, innerTop - 3, 6, 6);
            ctx.fillRect(xOut - 3, innerTop - 3, 6, 6);
          }
          ctx.restore();
        });

        if (lanePreview && lanePreview.laneId === lane.id) {
          const px1 = tx(timeAtBar(lanePreview.from));
          const px2 = tx(timeAtBar(lanePreview.to));
          ctx.save();
          ctx.globalAlpha = 0.5;
          ctx.fillStyle = lane.color;
          ctx.fillRect(px1, top + 6, Math.max(2, px2 - px1), LANE_H - 12);
          ctx.restore();
        }

        // lane label
        ctx.save();
        ctx.font = '600 10px ui-sans-serif, system-ui';
        ctx.textBaseline = 'middle';
        const nm = lane.name.length > 10 ? lane.name.slice(0, 10) + '…' : lane.name;
        const tw = ctx.measureText(nm).width;
        ctx.fillStyle = 'rgba(13,12,16,0.72)';
        ctx.fillRect(0, top, tw + 12, 16);
        ctx.fillStyle = lane.color;
        ctx.fillText(nm, 6, top + 8);
        ctx.restore();
      });
    }

    // ── markers ──
    const draggingId = dragRef?.id;
    markers.forEach((m) => {
      const x = (m.t / duration) * cssW;
      const isArmed = armedDelete && m.id === draggingId;
      ctx.save();
      if (isArmed) ctx.globalAlpha = 0.3;
      ctx.strokeStyle = isArmed ? '#c45b5b' : m.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, WAVE_H);
      ctx.stroke();
      if (peaks) {
        ctx.beginPath();
        ctx.moveTo(x, laneTop0);
        ctx.lineTo(x, cssH);
        ctx.stroke();
      }
      ctx.fillStyle = isArmed ? '#c45b5b' : m.color;
      const label = isArmed ? 'release to delete' : m.name;
      ctx.font = '11px ui-sans-serif, system-ui';
      const w = ctx.measureText(label).width + 10;
      ctx.fillRect(x, 0, w, 16);
      ctx.fillStyle = isArmed ? '#fff' : '#0d0c10';
      ctx.fillText(label, x + 5, 12);
      ctx.restore();
    });

    // ── playhead ──
    if (duration) {
      const px = (position / duration) * cssW;
      ctx.strokeStyle = '#f0e9d8';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, WAVE_H);
      ctx.stroke();
      if (peaks) {
        ctx.beginPath();
        ctx.moveTo(px, laneTop0);
        ctx.lineTo(px, cssH);
        ctx.stroke();
      }
    }
  }
</script>

<div class="app">
  <header class="topbar">
    <div class="topbar-row">
      <div class="titleblock">
        <div class="kicker">SECTION MAP</div>
        <h1 class="title">{fileName || 'Load a track to begin'}</h1>
      </div>
      <label class="loadBtn">
        {loading ? 'Decoding…' : fileName ? 'Replace' : 'Load audio'}
        <input type="file" accept="audio/*" onchange={handleFile} style="display:none" />
      </label>
    </div>
    <div class="toolbar">
      <div class="tgroup">
        <button class="playBtn" onclick={togglePlay} disabled={!peaks}>{playing ? '❚❚' : '▶'}</button>
        <div class="timeReadout">
          <span class="timeNow">{fmtTime(position)}</span>
          <span class="timeTotal">/ {fmtTime(duration)}</span>
        </div>
        <div class="barReadout">bar <strong style="color:#d4915d">{currentBar > 0 ? currentBar : '–'}</strong></div>
      </div>
      <div class="tgroup">
        <button class="exportBtn" onclick={exportTSV} disabled={!showFooter}>{copied ? 'Copied ✓' : 'Copy TSV'}</button>
        <button class="clearAll" class:armed={confirmClear} onclick={clearAll} disabled={!showFooter}>
          {confirmClear ? 'Confirm?' : 'Clear all'}
        </button>
      </div>
    </div>
  </header>

  <!-- BPM / grid controls -->
  <div class="gridPanel">
    <div class="gridControl">
      <label class="lbl" for="bpm-input">BPM</label>
      <div class="stepperRow">
        <button class="step" onclick={() => (bpm = Math.max(40, bpm - 1))}>−</button>
        <input id="bpm-input" class="numInput" type="number" value={bpm} oninput={onBpmInput} />
        <button class="step" onclick={() => (bpm = Math.min(300, bpm + 1))}>+</button>
      </div>
    </div>
    <button class="tapBtn" onclick={tapTempo}>TAP</button>
    <div class="gridControl">
      <span class="lbl">Bar 1 offset</span>
      <div class="stepperRow">
        <button class="step" onclick={() => nudgeFirstBeat(-0.05)}>−</button>
        <span class="offsetVal">{firstBeat.toFixed(2)}s</span>
        <button class="step" onclick={() => nudgeFirstBeat(0.05)}>+</button>
      </div>
    </div>
    <button class="toggle" class:on={showGrid} onclick={() => (showGrid = !showGrid)}>
      Grid {showGrid ? 'on' : 'off'}
    </button>
    <button
      class="alignBtn"
      onclick={() => (firstBeat = +position.toFixed(3))}
      disabled={!peaks}
      title="Set the current playhead as the downbeat of bar 1"
    >
      Set bar 1 = playhead
    </button>
  </div>

  <!-- Section palette -->
  <div class="sectionRow">
    {#each SECTIONS as sec (sec.name)}
      {@const on = activeSection?.name === sec.name}
      <button
        class="sectionChip"
        onclick={() => (activeSection = on ? null : sec)}
        style="border-color:{sec.color}; background:{on ? sec.color : 'transparent'}; color:{on ? '#0d0c10' : sec.color};"
        disabled={!peaks}
        title={on ? `${sec.name} selected — tap again for seek mode` : `Select ${sec.name}`}
      >
        {sec.name}
      </button>
    {/each}
  </div>

  <!-- Waveform + arrangement canvas -->
  <div class="canvasWrap" bind:this={wrapEl}>
    <canvas
      bind:this={canvasEl}
      class="canvas"
      style="cursor:{cursor}"
      onpointerdown={handlePointerDown}
      onpointermove={handlePointerMove}
      onpointerup={handlePointerUp}
      onpointerleave={handlePointerLeave}
    ></canvas>
    {#if !peaks}
      <div class="placeholder">{loading ? 'Reading waveform…' : 'Waveform appears here'}</div>
    {/if}
  </div>

  <!-- Arrangement lane controls -->
  {#if peaks}
    <div class="listHead">
      <span>Arrangement</span>
      <button class="addLaneBtn" onclick={addLane}>+ lane</button>
    </div>
    <div class="laneChips">
      {#each lanes as l (l.id)}
        <div class="laneChip" style="border-color:{l.color}55">
          <span class="laneDot" style="background:{l.color}"></span>
          {#if editingLaneId === l.id}
            <input
              class="laneNameEdit"
              value={editingName}
              oninput={(e) => (editingName = e.currentTarget.value)}
              onkeydown={(e) => {
                if (e.key === 'Enter') commitEditLane();
                else if (e.key === 'Escape') cancelEditLane();
              }}
              onblur={commitEditLane}
              use:autofocus
            />
          {:else}
            <button class="laneName" title="Rename lane" onclick={() => startEditLane(l)}>{l.name}</button>
          {/if}
          <button class="laneRemove" title="Remove lane" onclick={() => removeLane(l.id)}>✕</button>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Marker list -->
  <div class="listHead">
    <span>Markers</span>
    <span class="count">{markers.length}</span>
  </div>
  {#if markers.length === 0}
    <div class="empty">No markers yet. Play the track and tap a section as each part begins.</div>
  {:else}
    <ul class="list">
      {#each markers as m (m.id)}
        <li class="listItem">
          <span class="dot" style="background:{m.color}"></span>
          <button class="jump" onclick={() => jumpTo(m.t)}>
            <strong style="color:#e8e4da">{m.name}</strong>
            <span class="itemTime">{fmtTime(m.t)} · bar {barAtTime(m.t)}</span>
          </button>
          <button class="iconBtn" onclick={() => renameMarker(m.id)} title="Rename">✎</button>
          <button class="iconBtn" onclick={() => deleteMarker(m.id)} title="Delete">✕</button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .app {
    --mono: ui-monospace, 'SF Mono', Menlo, monospace;
    --sans: ui-sans-serif, system-ui, -apple-system, sans-serif;
    background: #0d0c10;
    color: #cfcad9;
    font-family: var(--sans);
    min-height: 100vh;
    padding: 20px 16px 40px;
    max-width: 760px;
    margin: 0 auto;
    box-sizing: border-box;
  }

  .topbar {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-bottom: 18px;
  }
  .topbar-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 12px;
  }
  .titleblock {
    min-width: 0;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 10px 14px;
    padding: 8px 12px;
    background: #131218;
    border: 1px solid #1f1d28;
    border-radius: 10px;
  }
  .tgroup {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .kicker {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.28em;
    color: #8e89a3;
    margin-bottom: 4px;
  }
  .title {
    font-size: 19px;
    font-weight: 600;
    margin: 0;
    color: #e8e4da;
    word-break: break-word;
    line-height: 1.2;
  }
  .loadBtn {
    flex-shrink: 0;
    background: #d4915d;
    color: #0d0c10;
    border: none;
    border-radius: 8px;
    padding: 9px 14px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    align-self: center;
  }

  .gridPanel {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 10px;
    margin: 18px 0;
    padding: 14px;
    background: #131218;
    border-radius: 10px;
    border: 1px solid #1f1d28;
  }
  .gridControl {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .lbl {
    font-size: 10px;
    font-family: var(--mono);
    letter-spacing: 0.1em;
    color: #8e89a3;
    text-transform: uppercase;
  }
  .stepperRow {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .step {
    width: 30px;
    height: 32px;
    border-radius: 6px;
    border: 1px solid #2c2a38;
    background: #1c1b22;
    color: #cfcad9;
    font-size: 16px;
    cursor: pointer;
  }
  .numInput {
    width: 54px;
    height: 32px;
    text-align: center;
    background: #0d0c10;
    border: 1px solid #2c2a38;
    border-radius: 6px;
    color: #e8e4da;
    font-size: 15px;
    font-family: var(--mono);
  }
  .offsetVal {
    min-width: 52px;
    text-align: center;
    font-family: var(--mono);
    font-size: 14px;
    color: #e8e4da;
  }
  .tapBtn {
    height: 32px;
    padding: 0 16px;
    border-radius: 6px;
    border: 1px solid #3a3850;
    background: #1c1b22;
    color: #d4915d;
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.1em;
    cursor: pointer;
  }
  .toggle {
    height: 32px;
    padding: 0 12px;
    border-radius: 6px;
    border: 1px solid #2c2a38;
    background: #1c1b22;
    color: #a8a3bd;
    font-size: 12px;
    cursor: pointer;
    font-family: var(--mono);
  }
  .toggle.on {
    border-color: #4a8fb8;
    color: #4a8fb8;
  }
  .alignBtn {
    height: 32px;
    padding: 0 12px;
    border-radius: 6px;
    border: 1px solid #2c2a38;
    background: #1c1b22;
    color: #a8a3bd;
    font-size: 12px;
    cursor: pointer;
  }

  .sectionRow {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    margin-top: 6px;
  }
  .sectionChip {
    border: 1.5px solid;
    border-radius: 7px;
    padding: 8px 12px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    flex: 1 1 auto;
    min-width: 64px;
  }

  .canvasWrap {
    position: relative;
    width: 100%;
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid #262433;
    margin-top: 16px;
  }
  .canvas {
    display: block;
    width: 100%;
    touch-action: none;
  }
  .placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #6a6780;
    font-size: 13px;
    font-family: var(--mono);
    pointer-events: none;
  }

  .playBtn {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 1px solid #3a3850;
    background: #1c1b22;
    color: #e8e4da;
    font-size: 15px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .timeReadout {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-family: var(--mono);
  }
  .timeNow {
    font-size: 18px;
    color: #e8e4da;
  }
  .timeTotal {
    font-size: 12px;
    color: #8e89a3;
  }
  .barReadout {
    font-family: var(--mono);
    font-size: 13px;
    color: #a8a3bd;
  }

  .listHead {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.2em;
    color: #8e89a3;
    text-transform: uppercase;
    border-bottom: 1px solid #1f1d28;
    padding-bottom: 8px;
    margin-bottom: 4px;
    margin-top: 22px;
  }
  .count {
    color: #d4915d;
  }
  .addLaneBtn {
    background: #1c1b22;
    border: 1px solid #3a3850;
    color: #4a8fb8;
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    text-transform: none;
    letter-spacing: 0;
  }

  .laneChips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .laneChip {
    display: flex;
    align-items: center;
    gap: 4px;
    background: #16151a;
    border: 1px solid;
    border-radius: 6px;
    padding: 3px 4px 3px 8px;
  }
  .laneDot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .laneName {
    background: none;
    border: none;
    color: #cfcad9;
    font-size: 12px;
    cursor: pointer;
    font-family: var(--sans);
  }
  .laneNameEdit {
    width: 84px;
    background: #0d0c10;
    border: 1px solid #3a3850;
    border-radius: 4px;
    color: #e8e4da;
    font-size: 12px;
    font-family: var(--sans);
    padding: 1px 4px;
  }
  .laneRemove {
    background: none;
    border: none;
    color: #8e89a3;
    font-size: 13px;
    cursor: pointer;
    padding: 0 2px;
  }

  .exportBtn {
    background: #1c1b22;
    border: 1px solid #3a3850;
    color: #4a8fb8;
    border-radius: 7px;
    padding: 8px 16px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .clearAll {
    background: transparent;
    border: 1px solid #3a2828;
    color: #a86b6b;
    border-radius: 7px;
    padding: 8px 14px;
    font-size: 12px;
    cursor: pointer;
  }
  .clearAll.armed {
    background: #c45b5b;
    border: 1px solid #c45b5b;
    color: #0d0c10;
    font-weight: 600;
  }

  .empty {
    font-size: 13px;
    color: #8e89a3;
    padding: 16px 4px;
  }
  .list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .listItem {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 4px;
    border-bottom: 1px solid #161520;
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .jump {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: none;
    border: none;
    text-align: left;
    cursor: pointer;
    padding: 0;
    font-family: var(--sans);
  }
  .itemTime {
    font-size: 11.5px;
    color: #8e89a3;
    font-family: var(--mono);
  }
  .iconBtn {
    width: 30px;
    height: 30px;
    border-radius: 6px;
    border: 1px solid #262433;
    background: transparent;
    color: #a8a3bd;
    cursor: pointer;
    font-size: 13px;
  }

  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
