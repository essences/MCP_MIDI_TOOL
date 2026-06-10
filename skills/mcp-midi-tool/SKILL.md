---
name: mcp-midi-tool
description: Use when the user wants to use the full MCP MIDI TOOL feature set from a portable skill folder. Includes direct helper scripts for common compose and inspect workflows, plus a bundled local tool wrapper that exposes the original MCP tools such as append_to_smf, extract_bars, replace_bars, playback, trigger_notes, device enumeration, and recording workflows from inside this skill package.
---

# MCP MIDI TOOL

This skill is for operating MIDI files directly from the bundled code in this skill folder.

Do not depend on an external MCP installation. This skill bundles what it needs locally.

There are two execution paths:

- `lib/directApi.js` for lightweight direct helpers
- `lib/index.js` plus `lib/localToolClient.mjs` for the full original tool surface

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
- `scripts/direct_compose_and_play.mjs`: compose a short tune and send it to a MIDI output port
- `scripts/list_all_tools.mjs`: enumerate the full bundled tool surface
- `scripts/run_tool.mjs`: invoke any original MCP tool by name using `TOOL_NAME` and `TOOL_ARGS_JSON`

The direct scripts import `lib/directApi.js`. The generic tool scripts use `lib/localToolClient.mjs`, which talks to the bundled `lib/index.js` inside this skill folder.

Environment variables:

- `MCP_MIDI_MANIFEST`: optional manifest filename for the managed library state.
- `FILE_ID`: target file for sustain diagnosis.
- `MCP_MIDI_BASE_DIR`: optional base directory override for data resolution.
- `TOOL_NAME`: tool name for `scripts/run_tool.mjs`
- `TOOL_ARGS_JSON`: JSON string arguments for `scripts/run_tool.mjs`
- `PORT_NAME`: output port hint for note or SMF playback scripts

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
- For everything else from the original MCP surface, use `scripts/run_tool.mjs`

## Full Tool Coverage

The bundled local tool wrapper exposes the original tool names from `src/index.ts`, including:

- `store_midi`, `get_midi`, `list_midi`, `find_midi`, `export_midi`
- `json_to_smf`, `smf_to_json`, `clean_midi`, `append_to_smf`
- `insert_sustain`, `insert_cc`, `extract_bars`, `replace_bars`
- `list_devices`, `list_input_devices`, `trigger_notes`, `playback_midi`
- `play_smf`, `get_playback_status`, `stop_playback`
- `start_single_capture`, `feed_single_capture`, `get_single_capture_status`
- `start_continuous_recording`, `get_continuous_recording_status`, `stop_continuous_recording`, `list_continuous_recordings`

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
