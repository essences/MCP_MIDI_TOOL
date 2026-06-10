---
name: mcp-midi-tool
description: Use when the user wants to compose, inspect, edit, export, or dry-run analyze MIDI directly from this repository without using MCP. Covers JSON MIDI v1 and Score DSL v1 workflows, SMF round-trips, sustain or arbitrary CC insertion, manifest-backed file management, and direct helper scripts that call the local build artifacts instead of the MCP server.
---

# MCP MIDI TOOL

This skill is for operating MIDI files directly from the bundled code in this skill folder.

Do not use the MCP server for this skill unless the user explicitly asks for MCP integration work.

The bundled scripts call `lib/directApi.js` directly. There is no `initialize`, `tools/call`, or stdio JSON-RPC layer in this workflow.

## When To Use

Use this skill when the request involves one or more of these:

- creating MIDI from structured JSON
- creating MIDI from Score DSL v1
- converting existing SMF to JSON and back
- inserting sustain pedal or other CC ranges
- exporting managed SMF files
- estimating playback duration or scheduled event counts without real playback

Before first use in a new location, run `npm install` inside this skill folder.

## Bundled Scripts

Use the bundled scripts when you want deterministic direct execution from the repository code.

- `scripts/direct_compose_and_analyze.mjs`: compile a small Score DSL sample and report file metadata plus dry-run timing
- `scripts/direct_inspect_and_fix_sustain.mjs`: inspect an SMF, infer note range and channel, insert CC64 if missing, export, then report dry-run timing
- `scripts/direct_file_summary.mjs`: load an existing managed file and summarize tracks, events, and duration

All scripts import `lib/directApi.js` directly.

Environment variables:

- `MCP_MIDI_MANIFEST`: optional manifest filename for the managed library state.
- `FILE_ID`: target file for sustain diagnosis.
- `MCP_MIDI_BASE_DIR`: optional base directory override for data resolution.

The default base directory is this skill folder. Managed files are stored under `data/midi`, exports under `data/export`, and the manifest under `data/manifest.json` unless overridden.

## Operating Rules

- Prefer `saveSongAsSmf` for new material.
- Prefer explicit `format` instead of relying on format auto-detection.
- Prefer `analyzeSmfDryRun` before any playback-oriented conclusion.
- Treat external MIDI channel numbers as `1..16`.
- Treat JSON MIDI track `channel` values as internal `0..15` unless the tool explicitly says otherwise.
- When editing existing files, prefer non-destructive flows that return a new `fileId`, then verify with `loadSmfAsJson` or `analyzeSmfDryRun`.

## Default Workflows

### Compose New MIDI

1. Build the source as either JSON MIDI v1 or Score DSL v1.
2. Call `saveSongAsSmf` with explicit `format`.
3. Call `analyzeSmfDryRun`.
4. If the schedule looks correct, hand off to any separate playback path the user wants.
5. If needed, call `exportMidiFile`.

### Inspect Or Repair Existing MIDI

1. Call `loadSmfAsJson`.
2. Inspect tracks, channels, note ranges, tempo, and existing CC events.
3. Apply one of:
   - `insertSustainRanges`
   - `insertControllerRanges`
   - `exportMidiFile`
4. Re-check with `loadSmfAsJson` or `analyzeSmfDryRun`.

## Tool Selection

- `saveSongAsSmf`: compile new JSON MIDI v1 or Score DSL v1 into SMF and register it in the manifest
- `loadSmfAsJson`: inspect an existing managed SMF as structured data
- `insertSustainRanges`: insert CC64 pedal ranges directly into an existing file
- `insertControllerRanges`: insert another controller range directly into an existing file
- `analyzeSmfDryRun`: estimate scheduled event count and duration without playback
- `exportMidiFile`: copy a managed SMF into `data/export`

## Format Guidance

- Use `format: "json_midi_v1"` when the source is tick-based JSON.
- Use `format: "score_dsl_v1"` when the source is bar or beat oriented musical notation.
- For Score DSL, keep `start.beat` integer-only and express subdivisions with `unit` and `offset`.
- Use note names like `C4`, `F#3`, `Bb5` when human readability matters.

## Validation Checklist

- The returned object includes `ok: true` or a valid `fileId`.
- `analyzeSmfDryRun` shows plausible `scheduledEvents` and duration.
- Edited files preserve the intended channel and track targets.
- Sustain or CC edits do not duplicate existing events unintentionally.

## Local References

- Composition workflow: `references/composition_workflow.md`
- Score DSL details: `references/score_dsl_v1.md`
- JSON MIDI schema context: `references/json_midi_schema_v1.md`
- Full tool behavior and caveats: `references/README.md`
