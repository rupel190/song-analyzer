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
  const beatsPerBar = 4;
  const MARKER_LABEL_H = 16; // marker label box height (only this band grabs a marker)
  const MARKER_ROW_DY = 18; // vertical pitch between staggered label rows
  const DEFAULT_BLOCK_BARS = 4; // length of a block created by tapping a lane

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
  let volume = $state(1); // 0–1 output gain (playback only; not part of the map)
  let activeSection = $state<Section | null>(null);
  let loading = $state(false);
  let copied = $state(false);
  let lanes = $state<Lane[]>([]);
  let plotWidth = $state(600); // shared canvas width for waveform + lanes
  let confirmClear = $state(false);
  let editingLaneId = $state<string | null>(null);
  let editingName = $state('');
  // Selection (tap-to-edit) — at most one of these is set at a time.
  let selectedBlock = $state<{ laneId: string; blockId: string } | null>(null);
  let selectedMarkerId = $state<number | null>(null);
  // True while a block is being drawn by dragging — used to hide its edit popups
  // so they don't jump around mid-drag.
  let creating = $state(false);

  // ── Non-reactive refs ───────────────────────────────────────────────────────
  let audioCtx: AudioContext | null = null;
  let buffer: AudioBuffer | null = null;
  let source: AudioBufferSourceNode | null = null;
  let gainNode: GainNode | null = null; // sits between source and destination
  let startedAt = 0; // ctx time when playback began
  let startOffset = 0; // buffer offset when playback began
  let raf = 0;
  let canvasEl = $state<HTMLCanvasElement>();
  let wrapEl = $state<HTMLDivElement>();
  let tapsRef: number[] = [];
  // In-flight drag for creating a block: armed on pointerdown over an empty lane,
  // promoted to a real block on the first bar of horizontal movement.
  let pendingCreate: {
    laneId: string;
    anchorBar: number;
    pointerId: number;
    blockId: string | null;
  } | null = null;
  // Set when a drag created a block so the trailing click doesn't also fire.
  let suppressClick = false;

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
  const cursor = $derived(activeSection ? 'copy' : 'pointer');

  const selectedLane = $derived.by(() => {
    const s = selectedBlock;
    if (!s) return null;
    return lanes.find((l) => l.id === s.laneId) ?? null;
  });
  const selectedBlockData = $derived.by(() => {
    const s = selectedBlock;
    if (!s) return null;
    const lane = lanes.find((l) => l.id === s.laneId);
    return lane?.blocks.find((b) => b.id === s.blockId) ?? null;
  });
  const selectedMarker = $derived.by(() => {
    const id = selectedMarkerId;
    return id == null ? null : (markers.find((m) => m.id === id) ?? null);
  });
  // Screen-space box of the selected block (canvas CSS px = overlay coords), used
  // to anchor the floating edit popups above and below it.
  const selectedBlockRect = $derived.by(() => {
    const s = selectedBlock;
    const b = selectedBlockData;
    if (!s || !b) return null;
    const li = lanes.findIndex((l) => l.id === s.laneId);
    if (li < 0) return null;
    const x1 = laneTimeToX(timeAtBar(b.startBar));
    const x2 = laneTimeToX(timeAtBar(b.endBar));
    const top = WAVE_H + GAP + li * (LANE_H + LANE_GAP);
    return { centerX: (x1 + x2) / 2, top, bottom: top + LANE_H };
  });
  // Anchor point for the marker popup: on the marker line, just under its label.
  const selectedMarkerRect = $derived.by(() => {
    const m = selectedMarker;
    if (!m || !duration) return null;
    return { centerX: (m.t / duration) * plotWidth, top: 22 };
  });
  // Assign each marker (in time order) to label row 0 or 1 so close labels don't
  // overlap — greedy: reuse a row whose previous label has already ended. Shared
  // by draw() and markerAt() so the hit-boxes always match what's painted.
  const markerRows = $derived.by(() => {
    const rows = new Map<number, number>();
    if (!duration) return rows;
    const rowRight = [-Infinity, -Infinity];
    for (const m of markers) {
      const x = (m.t / duration) * plotWidth;
      const w = markerLabelWidth(m.name);
      let row = 0;
      if (x < rowRight[0] && x < rowRight[1]) row = rowRight[0] <= rowRight[1] ? 0 : 1;
      else if (x < rowRight[0]) row = 1;
      rowRight[row] = x + w;
      rows.set(m.id, row);
    }
    return rows;
  });

  // Hoisted so the derived values above can reference them.
  function barAtTime(t: number) {
    return Math.floor((t - firstBeat) / secPerBar) + 1;
  }
  function barFloatAtTime(t: number) {
    return (t - firstBeat) / secPerBar + 1;
  }
  function timeAtBar(bar: number) {
    return firstBeat + (bar - 1) * secPerBar;
  }
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

  // Position tracking: one rAF loop for the lifetime of the component.
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

  // Canvas draw — auto-tracks every reactive value it reads.
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
    const key = `${file.name}_${file.size}`;
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
      deselect();
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
    if (!gainNode) {
      gainNode = audioCtx.createGain();
      gainNode.connect(audioCtx.destination);
    }
    gainNode.gain.value = volume;
    src.connect(gainNode);
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
      if (audioCtx) startOffset = startOffset + (audioCtx.currentTime - startedAt);
      stopSource();
      playing = false;
    } else {
      playFrom(position);
    }
  }
  // Jump the playhead by whole bars for quick re-listen: from bar 42, three taps
  // of «bar lands you at the start of bar 39. seekTo restarts playback if playing.
  function skipBars(d: number) {
    if (!buffer || !duration) return;
    const target = clamp(barAtTime(position) + d, 1, totalBars + 1);
    seekTo(clamp(timeAtBar(target), 0, duration));
  }

  // ── Canvas geometry ──────────────────────────────────────────────────────────
  const timeAtX = (clientX: number): number | null => {
    if (!canvasEl || !duration) return null;
    const rect = canvasEl.getBoundingClientRect();
    return clamp((clientX - rect.left) / rect.width, 0, 1) * duration;
  };
  function seekTo(t: number) {
    position = t;
    if (playing) playFrom(t);
    else startOffset = t;
  }
  const laneTimeToX = (t: number) => (duration ? (t / duration) * plotWidth : 0);
  const laneXToBarFloat = (x: number) => barFloatAtTime((duration ? (x / plotWidth) * duration : 0));

  function laneIndexAtY(py: number): number {
    const base = WAVE_H + GAP;
    if (py < base) return -1;
    const li = Math.floor((py - base) / (LANE_H + LANE_GAP));
    return li >= 0 && li < lanes.length ? li : -1;
  }
  function blockAt(px: number, li: number): { laneId: string; blockId: string } | null {
    const lane = lanes[li];
    if (!lane) return null;
    for (const bl of lane.blocks) {
      const x1 = laneTimeToX(timeAtBar(bl.startBar));
      const x2 = laneTimeToX(timeAtBar(bl.endBar));
      if (px >= x1 - 4 && px <= x2 + 4) return { laneId: lane.id, blockId: bl.id };
    }
    return null;
  }
  // Measure a label the same way draw() does, so the hit-box matches what's drawn.
  function markerLabelWidth(name: string): number {
    const ctx = canvasEl?.getContext('2d');
    if (!ctx) return name.length * 6.5 + 10;
    ctx.font = '11px ui-sans-serif, system-ui';
    return ctx.measureText(name).width + 10;
  }
  // Only a label box grabs a marker — taps elsewhere on the line seek instead.
  // Labels are staggered across two rows (see markerRows), so check each marker's row.
  function markerAt(px: number, py: number): number | null {
    if (!duration || py < 0 || py > MARKER_ROW_DY + MARKER_LABEL_H) return null;
    for (const m of markers) {
      const x = (m.t / duration) * plotWidth;
      const ly = (markerRows.get(m.id) ?? 0) * MARKER_ROW_DY;
      if (py >= ly && py <= ly + MARKER_LABEL_H + 2 && px >= x - 2 && px <= x + markerLabelWidth(m.name))
        return m.id;
    }
    return null;
  }

  // ── Tap handling (everything is a tap; drags scroll the page) ──────────────────
  function handleCanvasClick(e: MouseEvent) {
    if (suppressClick) {
      suppressClick = false; // this "click" was the tail of a drag-create
      return;
    }
    if (!duration || !canvasEl) return;
    const rect = canvasEl.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    // ── lane region: blocks ──
    if (peaks && py >= WAVE_H + GAP) {
      const li = laneIndexAtY(py);
      if (li < 0) {
        deselect();
        return;
      }
      const hit = blockAt(px, li);
      if (hit) {
        selectBlock(hit.laneId, hit.blockId);
      } else if (selectedBlock || selectedMarkerId != null) {
        deselect(); // tap out of a selection applies + exits
      } else {
        createBlockAt(li, px);
      }
      return;
    }

    // ── waveform region: markers + seek ──
    // A marker is grabbed only by its label (see markerAt); tapping anywhere else
    // seeks — even with a marker selected — so you can re-listen while adjusting.
    // Markers then move by whole bars via the popup's ◀ ▶.
    const mk = markerAt(px, py);
    if (mk != null) {
      selectMarker(mk);
      const m = markers.find((x) => x.id === mk);
      if (m) seekTo(m.t); // jump the playhead to the section you tapped
      return;
    }
    const t = timeAtX(e.clientX);
    if (t == null) return;
    if (activeSection) {
      const id = addMarker(t, activeSection);
      activeSection = null; // exit place-mode so the new marker is editable
      selectMarker(id); // auto-select it
      seekTo(t);
      return;
    }
    if (selectedBlock) deselect(); // tapping the waveform drops a block selection
    seekTo(t);
  }

  function selectBlock(laneId: string, blockId: string) {
    selectedBlock = { laneId, blockId };
    selectedMarkerId = null;
  }
  function selectMarker(id: number) {
    selectedMarkerId = id;
    selectedBlock = null;
  }
  function deselect() {
    selectedBlock = null;
    selectedMarkerId = null;
  }

  function createBlockAt(laneIndex: number, px: number) {
    const lane = lanes[laneIndex];
    if (!lane || totalBars < 1) return;
    const startBar = clamp(snapBar(laneXToBarFloat(px)), 1, totalBars);
    const endBar = Math.min(totalBars + 1, startBar + DEFAULT_BLOCK_BARS);
    if (endBar - startBar < 1) return;
    const block: Block = {
      id: `blk_${blockIdCounter++}_${Date.now()}`,
      startBar,
      endBar,
      fadeInBars: 0,
      fadeOutBars: 0,
    };
    lanes = lanes.map((l) =>
      l.id === lane.id ? { ...l, blocks: [...l.blocks, block].sort((x, y) => x.startBar - y.startBar) } : l
    );
    selectBlock(lane.id, block.id);
  }

  // ── Drag-to-create a block (size it by dragging from the start) ──────────────────
  // touch-action: pan-y on the canvas lets a vertical drag scroll the page while a
  // horizontal drag is delivered to us here. A plain tap still makes a default block.
  function onCanvasPointerDown(e: PointerEvent) {
    if (!duration || !canvasEl || !peaks) return;
    const rect = canvasEl.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (py < WAVE_H + GAP) return; // waveform region: seeking/markers go through click
    const li = laneIndexAtY(py);
    if (li < 0) return;
    if (blockAt(px, li)) return; // pressing an existing block: let click select it
    const anchorBar = clamp(snapBar(laneXToBarFloat(px)), 1, totalBars + 1);
    pendingCreate = { laneId: lanes[li].id, anchorBar, pointerId: e.pointerId, blockId: null };
  }
  function onCanvasPointerMove(e: PointerEvent) {
    const pc = pendingCreate;
    if (!pc || e.pointerId !== pc.pointerId || !canvasEl) return;
    const rect = canvasEl.getBoundingClientRect();
    const curBar = clamp(snapBar(laneXToBarFloat(e.clientX - rect.left)), 1, totalBars + 1);
    let lo = Math.min(pc.anchorBar, curBar);
    let hi = Math.max(pc.anchorBar, curBar);
    if (hi - lo < 1) hi = Math.min(totalBars + 1, lo + 1); // never thinner than one bar
    if (hi - lo < 1) lo = hi - 1;
    if (pc.blockId == null) {
      if (Math.abs(curBar - pc.anchorBar) < 1) return; // wait for a full bar before creating
      const block: Block = {
        id: `blk_${blockIdCounter++}_${Date.now()}`,
        startBar: lo,
        endBar: hi,
        fadeInBars: 0,
        fadeOutBars: 0,
      };
      lanes = lanes.map((l) =>
        l.id === pc.laneId
          ? { ...l, blocks: [...l.blocks, block].sort((x, y) => x.startBar - y.startBar) }
          : l
      );
      pc.blockId = block.id;
      creating = true;
      selectBlock(pc.laneId, block.id);
      canvasEl.setPointerCapture(pc.pointerId);
    } else {
      patchBlock(pc.laneId, pc.blockId, { startBar: lo, endBar: hi });
    }
  }
  function endCanvasPointer(e: PointerEvent) {
    const pc = pendingCreate;
    if (!pc || e.pointerId !== pc.pointerId) return;
    if (pc.blockId != null) suppressClick = true; // a real drag happened; swallow the click
    creating = false;
    pendingCreate = null;
    try {
      canvasEl?.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer wasn't captured */
    }
  }

  // ── Block steppers ─────────────────────────────────────────────────────────────
  // Start / End move that edge by ±1 bar and carry the fade rigidly with it: the
  // fade *lengths* never change, so the block's shape is preserved and no fade is
  // ever invented where there was none. The only limit is that the block can't
  // shrink shorter than its two fades combined. Fade In / Out adjust ramp lengths.
  function stepStart(d: number) {
    const s = selectedBlock;
    const b = selectedBlockData;
    if (!s || !b) return;
    const minLen = Math.max(1, b.fadeInBars + b.fadeOutBars);
    const newStart = clamp(b.startBar + d, 1, b.endBar - minLen);
    patchBlock(s.laneId, s.blockId, { startBar: newStart });
  }
  function stepEnd(d: number) {
    const s = selectedBlock;
    const b = selectedBlockData;
    if (!s || !b) return;
    const minLen = Math.max(1, b.fadeInBars + b.fadeOutBars);
    const newEnd = clamp(b.endBar + d, b.startBar + minLen, totalBars + 1);
    patchBlock(s.laneId, s.blockId, { endBar: newEnd });
  }
  function stepFadeIn(d: number) {
    const s = selectedBlock;
    const b = selectedBlockData;
    if (!s || !b) return;
    patchBlock(s.laneId, s.blockId, {
      fadeInBars: clamp(b.fadeInBars + d, 0, b.endBar - b.startBar - b.fadeOutBars),
    });
  }
  function stepFadeOut(d: number) {
    const s = selectedBlock;
    const b = selectedBlockData;
    if (!s || !b) return;
    patchBlock(s.laneId, s.blockId, {
      fadeOutBars: clamp(b.fadeOutBars + d, 0, b.endBar - b.startBar - b.fadeInBars),
    });
  }
  function deleteSelectedBlock() {
    const s = selectedBlock;
    if (!s) return;
    deleteBlock(s.laneId, s.blockId);
    selectedBlock = null;
  }

  // ── Markers ──────────────────────────────────────────────────────────────────
  function addMarker(atTime: number, section: Section): number {
    const id = Date.now() + Math.random();
    markers = [...markers, { id, t: atTime, name: section.name, color: section.color }].sort(
      (a, b) => a.t - b.t
    );
    return id;
  }
  function moveMarkerTo(id: number, t: number) {
    markers = markers
      .map((m) => (m.id === id ? { ...m, t: clamp(t, 0, duration) } : m))
      .sort((a, b) => a.t - b.t);
  }
  // Move the selected marker by whole bars (snaps onto the bar grid). Bar
  // granularity is enough for marking where a section starts.
  function stepMarkerBar(d: number) {
    const m = selectedMarker;
    if (!m) return;
    const bar = clamp(snapBar(barFloatAtTime(m.t) + d), 1, totalBars + 1);
    moveMarkerTo(m.id, timeAtBar(bar));
  }
  function renameMarker(id: number) {
    const m = markers.find((x) => x.id === id);
    const name = window.prompt('Marker name', m?.name || '');
    if (name != null) markers = markers.map((x) => (x.id === id ? { ...x, name } : x));
  }
  function deleteMarker(id: number) {
    markers = markers.filter((x) => x.id !== id);
  }

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

  // ── TSV import ─────────────────────────────────────────────────────────────────
  // Reads the same shape exportTSV writes (a Section block then a Lane block) from
  // the clipboard and rebuilds the map. Marker times come back at second precision
  // (that's all the export carries); block bars are exact.
  function parseTimeStr(s: string): number {
    const parts = s.split(':').map((p) => parseFloat(p));
    if (!parts.length || parts.some((n) => isNaN(n))) return NaN;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }
  async function importTSV() {
    if (!peaks || !duration) {
      alert('Load the track first, then import its map.');
      return;
    }
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = window.prompt('Paste the TSV map here:') ?? '';
    }
    if (text.trim()) applyTSV(text);
  }
  function applyTSV(text: string) {
    const palette = ['#c45b5b', '#d4915d', '#9a7bb8', '#4a8fb8', '#7b9e7e', '#8f8f6b', '#b8709e', '#5fb0a8'];
    const newMarkers: Marker[] = [];
    // Seed with existing lanes so a matching name keeps its id/color; blocks reset.
    const laneMap = new Map<string, Lane>();
    for (const l of lanes) laneMap.set(l.name.toLowerCase(), { ...l, blocks: [] });
    let importedBpm: number | null = null;
    let mode: 'markers' | 'blocks' | null = null;

    for (const raw of text.split(/\r?\n/)) {
      if (!raw.trim()) {
        mode = null;
        continue;
      }
      const cells = raw.split('\t');
      const head = cells[0].trim().toLowerCase();
      if (head === 'section') {
        mode = 'markers';
        continue;
      }
      if (head === 'lane') {
        mode = 'blocks';
        continue;
      }
      if (mode === 'markers') {
        const name = cells[0]?.trim();
        const t = parseTimeStr((cells[1] ?? '').trim());
        if (!name || isNaN(t)) continue;
        const color = SECTIONS.find((s) => s.name.toLowerCase() === name.toLowerCase())?.color ?? '#6b7a8f';
        newMarkers.push({ id: Date.now() + Math.random(), t: clamp(t, 0, duration), name, color });
        const bv = parseFloat(cells[3]);
        if (bv >= 40 && bv <= 300) importedBpm = bv;
      } else if (mode === 'blocks') {
        const laneName = cells[0]?.trim();
        const startBar = parseInt(cells[1], 10);
        const endBar = parseInt(cells[2], 10);
        if (!laneName || isNaN(startBar) || isNaN(endBar) || endBar <= startBar) continue;
        const len = endBar - startBar;
        const fi = clamp(parseInt(cells[3], 10) || 0, 0, len);
        const fo = clamp(parseInt(cells[4], 10) || 0, 0, len - fi);
        const key = laneName.toLowerCase();
        let lane = laneMap.get(key);
        if (!lane) {
          lane = makeLane(laneName, palette[laneMap.size % palette.length]);
          laneMap.set(key, lane);
        }
        lane.blocks.push({
          id: `blk_${blockIdCounter++}_${Date.now()}`,
          startBar,
          endBar,
          fadeInBars: fi,
          fadeOutBars: fo,
        });
      }
    }

    if (importedBpm) bpm = importedBpm;
    markers = newMarkers.sort((a, b) => a.t - b.t);
    // Existing lanes keep their order; lanes only present in the TSV get appended.
    const ordered: Lane[] = [];
    for (const l of lanes) {
      const u = laneMap.get(l.name.toLowerCase());
      if (u) {
        ordered.push(u);
        laneMap.delete(l.name.toLowerCase());
      }
    }
    for (const u of laneMap.values()) ordered.push(u);
    lanes = ordered.map((l) => ({ ...l, blocks: [...l.blocks].sort((x, y) => x.startBar - y.startBar) }));
    deselect();
  }

  // ── Lane / block operations ────────────────────────────────────────────────────
  function updateLaneBlocks(laneId: string, updater: (blocks: Block[]) => Block[]) {
    lanes = lanes.map((l) => (l.id === laneId ? { ...l, blocks: updater(l.blocks) } : l));
  }
  function patchBlock(laneId: string, blockId: string, patch: Partial<Block>) {
    updateLaneBlocks(laneId, (blocks) => blocks.map((bl) => (bl.id === blockId ? { ...bl, ...patch } : bl)));
  }
  function deleteBlock(laneId: string, blockId: string) {
    updateLaneBlocks(laneId, (blocks) => blocks.filter((bl) => bl.id !== blockId));
  }

  // Inline lane-name editing (touch-friendly; new lanes open for naming at once).
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

  // Press-and-hold a stepper to repeat it: one step immediately, then auto-repeat
  // after a short delay so you can hold to move several bars instead of tapping.
  // Used instead of onclick on the popup steppers (so a tap = exactly one step).
  function holdRepeat(node: HTMLElement, fn: () => void) {
    let current = fn;
    let to: ReturnType<typeof setTimeout> | undefined;
    let iv: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      clearTimeout(to);
      clearInterval(iv);
      to = iv = undefined;
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      current();
      to = setTimeout(() => {
        iv = setInterval(() => current(), 80);
      }, 320);
      try {
        node.setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported — pointerup still stops it */
      }
    };
    node.addEventListener('pointerdown', down);
    node.addEventListener('pointerup', stop);
    node.addEventListener('pointercancel', stop);
    return {
      update: (fn2: () => void) => (current = fn2),
      destroy: () => {
        stop();
        node.removeEventListener('pointerdown', down);
        node.removeEventListener('pointerup', stop);
        node.removeEventListener('pointercancel', stop);
      },
    };
  }
  function removeLane(laneId: string) {
    if (selectedBlock?.laneId === laneId) selectedBlock = null;
    lanes = lanes.filter((x) => x.id !== laneId);
  }
  function addLane() {
    const palette = ['#c45b5b', '#d4915d', '#9a7bb8', '#4a8fb8', '#7b9e7e', '#8f8f6b', '#b8709e', '#5fb0a8'];
    const color = palette[lanes.length % palette.length];
    const lane = makeLane(`Lane ${lanes.length + 1}`, color);
    lanes = [...lanes, lane];
    startEditLane(lane);
  }

  // ── BPM / grid controls ──────────────────────────────────────────────────────
  function onBpmInput(e: Event) {
    bpm = Math.min(300, Math.max(40, +(e.target as HTMLInputElement).value || 0));
  }
  function onVolInput(e: Event) {
    volume = clamp(+(e.target as HTMLInputElement).value, 0, 1);
    if (gainNode) gainNode.gain.value = volume; // live while playing
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
      deselect();
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

    // waveform box
    ctx.fillStyle = '#16151a';
    ctx.fillRect(0, 0, cssW, WAVE_H);
    const mid = WAVE_H / 2;
    if (peaks) {
      ctx.fillStyle = '#5a93b8';
      const n = peaks.length;
      for (let i = 0; i < n; i++) {
        const x = (i / n) * cssW;
        const [mn, mx] = peaks[i];
        ctx.fillRect(x, mid - mx * (mid - 8), Math.max(1, cssW / n), Math.max(1, (mx - mn) * (mid - 8)));
      }
    }

    // arrangement box + lane rows
    if (peaks) {
      ctx.fillStyle = '#0f0e14';
      ctx.fillRect(0, laneTop0, cssW, lanesH);
      lanes.forEach((_lane, li) => {
        ctx.fillStyle = '#15141b';
        ctx.fillRect(0, laneTop0 + li * (LANE_H + LANE_GAP), cssW, LANE_H);
      });
    }

    // bar grid
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

    // arrangement blocks + lane labels
    if (peaks) {
      const sel = selectedBlock;
      lanes.forEach((lane, li) => {
        const top = laneTop0 + li * (LANE_H + LANE_GAP);
        const innerTop = top + 6;
        const bot = top + LANE_H - 6;
        lane.blocks.forEach((bl) => {
          const x1 = tx(timeAtBar(bl.startBar));
          const x2 = tx(timeAtBar(bl.endBar));
          const xIn = tx(timeAtBar(bl.startBar + bl.fadeInBars));
          const xOut = tx(timeAtBar(bl.endBar - bl.fadeOutBars));
          const isSel = !!sel && sel.laneId === lane.id && sel.blockId === bl.id;
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(x1, bot);
          ctx.lineTo(xIn, innerTop);
          ctx.lineTo(xOut, innerTop);
          ctx.lineTo(x2, bot);
          ctx.closePath();
          ctx.fillStyle = lane.color;
          ctx.globalAlpha = isSel ? 0.95 : 0.8;
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.strokeStyle = isSel ? '#f0e9d8' : lighten(lane.color);
          ctx.lineWidth = isSel ? 2.5 : 1.5;
          ctx.stroke();
          if (isSel) {
            ctx.fillStyle = '#f0e9d8';
            for (const [hx, hy] of [
              [x1, bot],
              [x2, bot],
              [xIn, innerTop],
              [xOut, innerTop],
            ] as [number, number][]) {
              ctx.beginPath();
              ctx.arc(hx, hy, 3.5, 0, Math.PI * 2);
              ctx.fill();
            }
          }
          ctx.restore();
        });
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

    // markers — labels staggered onto two rows (markerRows) so close ones don't overlap
    ctx.font = '11px ui-sans-serif, system-ui';
    markers.forEach((m) => {
      const x = tx(m.t);
      const ly = (markerRows.get(m.id) ?? 0) * MARKER_ROW_DY;
      const isSel = m.id === selectedMarkerId;
      ctx.save();
      ctx.strokeStyle = isSel ? '#f0e9d8' : m.color;
      ctx.lineWidth = isSel ? 3 : 2;
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
      const w = ctx.measureText(m.name).width + 10;
      ctx.fillStyle = m.color;
      ctx.fillRect(x, ly, w, MARKER_LABEL_H);
      ctx.fillStyle = '#0d0c10';
      ctx.fillText(m.name, x + 5, ly + 12);
      if (isSel) {
        ctx.strokeStyle = '#f0e9d8';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x + 0.5, ly + 0.5, w, MARKER_LABEL_H);
      }
      ctx.restore();
    });

    // playhead
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
        <div class="kicker">SONG MAP</div>
        <h1 class="title">{fileName || 'Load a track to begin'}</h1>
      </div>
      <div class="fileActions">
        <button class="exportBtn" onclick={importTSV} disabled={!peaks}>Import TSV</button>
        <button class="exportBtn" onclick={exportTSV} disabled={!showFooter}>{copied ? 'Copied ✓' : 'Copy TSV'}</button>
        <button class="clearAll" class:armed={confirmClear} onclick={clearAll} disabled={!showFooter}>
          {confirmClear ? 'Confirm?' : 'Clear all'}
        </button>
        <label class="loadBtn">
          {loading ? 'Decoding…' : fileName ? 'Replace' : 'Load audio'}
          <input type="file" accept="audio/*" onchange={handleFile} style="display:none" />
        </label>
      </div>
    </div>
  </header>

  <!-- Transport + grid controls (one combined panel) -->
  <div class="controls">
    <div class="cgroup">
      <button class="skipBtn" onclick={() => skipBars(-1)} disabled={!peaks} title="Back one bar" aria-label="Back one bar">«bar</button>
      <button class="playBtn" onclick={togglePlay} disabled={!peaks}>{playing ? '❚❚' : '▶'}</button>
      <button class="skipBtn" onclick={() => skipBars(1)} disabled={!peaks} title="Forward one bar" aria-label="Forward one bar">bar»</button>
      <div class="timeReadout">
        <span class="timeNow">{fmtTime(position)}</span>
        <span class="timeTotal">/ {fmtTime(duration)}</span>
      </div>
      <div class="barReadout">bar <strong style="color:#d4915d">{currentBar > 0 ? currentBar : '–'}</strong></div>
    </div>
    <div class="cgroup volGroup">
      <span class="lbl">Vol</span>
      <input
        class="volSlider"
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={volume}
        oninput={onVolInput}
        disabled={!peaks}
        aria-label="Volume"
      />
    </div>
    <div class="cgroup">
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
    </div>
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
      onclick={handleCanvasClick}
      onpointerdown={onCanvasPointerDown}
      onpointermove={onCanvasPointerMove}
      onpointerup={endCanvasPointer}
      onpointercancel={endCanvasPointer}
    ></canvas>
    {#if !peaks}
      <div class="placeholder">{loading ? 'Reading waveform…' : 'Waveform appears here'}</div>
    {/if}

    <!-- Floating edit popups, anchored to the selected block: start/end above,
         fades below. pointer-events:none on the layer lets taps fall through to
         the canvas everywhere except on the popups themselves. -->
    {#if selectedBlockRect && selectedLane && selectedBlockData && !creating}
      {@const r = selectedBlockRect}
      {@const cx = Math.max(98, Math.min(plotWidth - 98, r.centerX))}
      <div class="blockPop above" style="left:{cx}px; top:{r.top}px;">
        <div class="popHead">
          <span class="laneDot" style="background:{selectedLane.color}"></span>
          <strong class="popName">{selectedLane.name}</strong>
          <span class="popSub">bars {selectedBlockData.startBar}–{selectedBlockData.endBar}</span>
          <button class="popDel" title="Delete block" onclick={deleteSelectedBlock}>✕</button>
          <button class="popDone" title="Done" onclick={deselect}>✓</button>
        </div>
        <div class="popRow">
          <div class="popCtl">
            <span class="popLbl">Start</span>
            <button class="popStep" use:holdRepeat={() => stepStart(-1)}>−</button>
            <span class="popVal">{selectedBlockData.startBar}</span>
            <button class="popStep" use:holdRepeat={() => stepStart(1)}>+</button>
          </div>
          <div class="popCtl">
            <span class="popLbl">End</span>
            <button class="popStep" use:holdRepeat={() => stepEnd(-1)}>−</button>
            <span class="popVal">{selectedBlockData.endBar}</span>
            <button class="popStep" use:holdRepeat={() => stepEnd(1)}>+</button>
          </div>
        </div>
      </div>
      <div class="blockPop below" style="left:{cx}px; top:{r.bottom}px;">
        <div class="popRow">
          <div class="popCtl">
            <span class="popLbl">Fade in</span>
            <button class="popStep" use:holdRepeat={() => stepFadeIn(-1)}>−</button>
            <span class="popVal">{selectedBlockData.fadeInBars}</span>
            <button class="popStep" use:holdRepeat={() => stepFadeIn(1)}>+</button>
          </div>
          <div class="popCtl">
            <span class="popLbl">Fade out</span>
            <button class="popStep" use:holdRepeat={() => stepFadeOut(-1)}>−</button>
            <span class="popVal">{selectedBlockData.fadeOutBars}</span>
            <button class="popStep" use:holdRepeat={() => stepFadeOut(1)}>+</button>
          </div>
        </div>
      </div>
    {/if}

    <!-- Marker edit popup, anchored on the marker line just below its label. -->
    {#if selectedMarker && selectedMarkerRect}
      {@const cx = Math.max(98, Math.min(plotWidth - 98, selectedMarkerRect.centerX))}
      <div class="blockPop marker" style="left:{cx}px; top:{selectedMarkerRect.top}px;">
        <div class="popHead">
          <span class="laneDot" style="background:{selectedMarker.color}"></span>
          <strong class="popName">{selectedMarker.name}</strong>
          <span class="popSub">{fmtTime(selectedMarker.t)} · bar {barAtTime(selectedMarker.t)}</span>
          <button
            class="popDel"
            title="Delete marker"
            onclick={() => {
              if (selectedMarkerId != null) deleteMarker(selectedMarkerId);
              deselect();
            }}>✕</button
          >
          <button class="popDone" title="Done" onclick={deselect}>✓</button>
        </div>
        <div class="popRow">
          <div class="popCtl">
            <span class="popLbl">Move</span>
            <button class="popStep" use:holdRepeat={() => stepMarkerBar(-1)}>◀</button>
            <span class="popVal wide">bar {barAtTime(selectedMarker.t)}</span>
            <button class="popStep" use:holdRepeat={() => stepMarkerBar(1)}>▶</button>
          </div>
          <button
            class="popRename"
            onclick={() => {
              if (selectedMarkerId != null) renameMarker(selectedMarkerId);
            }}>Rename</button
          >
        </div>
        <div class="popHint">◀ ▶ move by a bar · tap the waveform to seek &amp; re-listen.</div>
      </div>
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
    <div class="hint">Tap an empty lane to add a block · tap a block to edit it.</div>
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
  .fileActions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    flex-shrink: 0;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px 18px;
    margin: 16px 0;
    padding: 10px 14px;
    background: #131218;
    border: 1px solid #1f1d28;
    border-radius: 10px;
  }
  .cgroup {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .volGroup {
    gap: 8px;
  }
  .volSlider {
    width: 96px;
    accent-color: #4a8fb8;
    cursor: pointer;
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
    /* visible (not hidden) so the block edit popups can extend above/below the
       canvas frame; the canvas keeps its own rounded corners. */
    overflow: visible;
    border: 1px solid #262433;
    margin-top: 16px;
  }
  .canvas {
    display: block;
    width: 100%;
    border-radius: 10px;
    /* pan-y: vertical drags still scroll the page; horizontal drags reach our
       pointer handlers to size a new block. pinch-zoom stays available. */
    touch-action: pan-y pinch-zoom;
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

  /* Floating block-edit popups, positioned in canvas pixel coordinates. */
  .blockPop {
    position: absolute;
    z-index: 15;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 10px;
    background: #161520;
    border: 1px solid #3a3650;
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    max-width: 92vw;
  }
  .blockPop.above {
    /* center on the block, sit just above the lane row */
    transform: translate(-50%, calc(-100% - 8px));
  }
  .blockPop.below {
    /* center on the block, sit just below the lane row */
    transform: translate(-50%, 8px);
  }
  .popHead {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .popName {
    color: #e8e4da;
    font-size: 12px;
  }
  .popSub {
    color: #8e89a3;
    font-family: var(--mono);
    font-size: 11px;
  }
  .popDel {
    margin-left: auto;
    background: transparent;
    border: 1px solid #3a2828;
    color: #a86b6b;
    border-radius: 6px;
    padding: 3px 8px;
    font-size: 12px;
    cursor: pointer;
  }
  .popDone {
    background: #1c1b22;
    border: 1px solid #3a3850;
    color: #4a8fb8;
    border-radius: 6px;
    padding: 3px 9px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
  }
  .popRow {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }
  .popCtl {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .popLbl {
    font-size: 9px;
    font-family: var(--mono);
    letter-spacing: 0.06em;
    color: #8e89a3;
    text-transform: uppercase;
    margin-right: 2px;
  }
  .popStep {
    width: 34px;
    height: 34px;
    border-radius: 7px;
    border: 1px solid #3a3850;
    background: #1c1b22;
    color: #e8e4da;
    font-size: 18px;
    cursor: pointer;
  }
  .popVal {
    min-width: 26px;
    text-align: center;
    font-family: var(--mono);
    font-size: 14px;
    color: #e8e4da;
  }
  .popVal.wide {
    min-width: 58px;
  }
  /* The marker popup hangs straight down from its anchor (no vertical flip). */
  .blockPop.marker {
    transform: translateX(-50%);
  }
  .popRename {
    background: #1c1b22;
    border: 1px solid #3a3850;
    color: #cfcad9;
    border-radius: 7px;
    padding: 6px 12px;
    font-size: 13px;
    cursor: pointer;
  }
  .popHint {
    font-size: 10px;
    color: #6a6780;
    font-family: var(--mono);
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
  .skipBtn {
    height: 38px;
    min-width: 44px;
    padding: 0 10px;
    border-radius: 8px;
    border: 1px solid #3a3850;
    background: #1c1b22;
    color: #cfcad9;
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    flex-shrink: 0;
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
  .hint {
    font-size: 11px;
    color: #6a6780;
    font-family: var(--mono);
    margin-top: 8px;
  }

  .laneChips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
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
    flex-shrink: 0;
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

  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
