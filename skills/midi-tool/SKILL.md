---
name: midi-tool
description: Compose, inspect, edit, play, and record MIDI using local commands. Use for MIDI files, Score DSL composition, MIDI device sessions, and simulated note capture.
---

Use this skill's `scripts/midi.mjs` with Node 20 or later. Install this directory's dependencies with `npm ci` before first use; no MCP setup is required. If native build tools are unavailable, `npm ci --ignore-scripts` enables file conversion, editing, dry-run, and simulated capture; real MIDI remains unavailable until the native dependency is built. Resolve the script against this skill directory, independent of the working directory.

Read [JSON MIDI](references/json_midi_schema_v1.md) for tick-based events or [Score DSL](references/score_dsl_v1.md) for composition. Read [workflows](references/workflows.md) for editing and device sessions.

Pass song JSON through `--input FILE` or stdin (`--input -`). `--args-file FILE` supplies complete operation arguments. Responses are JSON; nonzero exit means failure. Inspect `error.code` before retrying. A connection timeout can leave a stateful operation running; inspect runtime status rather than blindly starting another recording.

Choose a stable `--data-dir DIR` when IDs must be reused. Otherwise `MIDI_TOOL_DATA_DIR`, then this skill's `data/`, is used. Keep returned fileId/playbackId/captureId/recordingId values; names do not identify sessions. External channels are 1–16; JSON MIDI channels are 0–15.

Start with `compose`, `decode`, and `play --dry-run` to verify a composition. Enumerate devices with `devices list --direction input|output`, then specify an actual `--port`. `doctor` only diagnoses devices and does not emit notes. Playback and notes wait by default; `--background` returns an ID. Capture and recording use a local runtime shared across commands. Stop active recording explicitly to obtain its saved result; `runtime stop` disposes sessions and releases ports.

Use `--help` for command names. Every engine operation is also available through `run --operation NAME --args-file FILE`; see [operation arguments](references/operations.md).
