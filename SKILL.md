---
name: audio-log-viewer
description: Work on the Electron React TypeScript CSV Audio Log Viewer for Total Phase Data Center USB audio logs. Use when modifying parser/cache logic, PCM waveform rendering, timeline/glitch behavior, Electron IPC, or local verification for this project.
---

# Audio Log Viewer

## Project Shape

This repo is an Electron desktop app with a React/Vite renderer.

- Main process: `src/main/`
- CSV parsing and SQLite cache: `src/main/services/`
- Shared IPC/data types: `src/shared/types.ts`
- Renderer UI and canvases: `src/renderer/`
- Sample CSVs may exist under `samples/`, but they are intentionally ignored by git because large captures can exceed GitHub limits.

## Core Behavior

Preserve the four-panel workflow:

1. Summary shows file metadata, duration, row count, audio packet count, PCM format, and glitch count.
2. Audio Data renders only the selected time window as PCM waveform.
3. Timeline spans from 0 to capture duration, shows a yellow 10-second window, and marks glitches as red vertical lines.
4. Detail shows the nearest CSV row to the selected time, including audio metadata when applicable.

Use `Record = OUT txn` rows with hex `Data` as audio packets. Decode PCM as auto-detected when possible; fallback is `48kHz / 24-bit signed LE / stereo`.

## Development Workflow

Use `npm.cmd` on Windows PowerShell because `npm.ps1` may be blocked by execution policy.

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd run build
npm.cmd run dev
```

If Electron starts but `better-sqlite3` fails with a Node module ABI mismatch, rebuild it for Electron:

```powershell
npx.cmd electron-rebuild -f -w better-sqlite3
```

If Electron binary is incomplete, rerun Electron install or rebuild before changing app code.

After every code change, commit the completed source changes to git with a clear message. Do not commit ignored generated artifacts such as `samples/`, `node_modules/`, `dist/`, or SQLite cache files.

## Parser And Cache Rules

- Parse Total Phase CSV comments until the `# Level,Sp,Index,m:s.ms.us,...` header is found.
- Convert `m:s.ms.us` to microseconds for all indexing and UI calculations.
- Cache by absolute path, file size, and modified time.
- Store parsed rows, audio packets, and glitches in SQLite.
- Query only the current visible time range for waveform rendering.
- Keep initial parsing streaming/batched so large files such as 300MB captures do not load fully into memory.

## Glitch Rules

Detect glitches from consecutive audio packet timestamps:

- Estimate expected interval using the median of early positive packet intervals.
- Mark any interval significantly above the expected gap as a glitch.
- Long gaps with no audio packets count as glitches.
- Timeline marker count, Summary glitch count, and Previous/Next navigation must agree.

## UI Rules

- Render waveform and timeline with canvas.
- Do not draw all audio packets for the full file in the renderer.
- Mouse wheel over the waveform changes zoom.
- Clicking waveform or timeline updates selected time and detail.
- Keep controls compact and utilitarian; this is a diagnostic tool, not a landing page.

## Verification

Before considering changes complete, run:

```powershell
npm.cmd run typecheck
npm.cmd run build
```

For parser/cache changes, smoke-test at least one sample through `CsvCache` directly and verify:

- First open builds cache.
- Second open is a cache hit.
- Timeline duration is nonzero.
- Window query returns bounded data.
- Detail lookup returns the nearest row.

Do not commit `samples/`, `node_modules/`, `dist/`, or SQLite cache files.
