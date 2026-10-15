# Workflows

In examples, MIDI is the absolute path to this skill's scripts/midi.mjs and DATA is your chosen data directory.

```sh
node "$MIDI" compose --data-dir "$DATA" --format score_dsl_v1 --input score.json --name song.mid
node "$MIDI" decode --data-dir "$DATA" --file-id FILE_ID
node "$MIDI" play --data-dir "$DATA" --file-id FILE_ID --dry-run
node "$MIDI" devices list --direction output
node "$MIDI" play --data-dir "$DATA" --file-id FILE_ID --port 'Actual device' --background
node "$MIDI" playback status --data-dir "$DATA" --id PLAYBACK_ID
node "$MIDI" playback stop --data-dir "$DATA" --id PLAYBACK_ID
node "$MIDI" record start --data-dir "$DATA" --port 'Actual input'
node "$MIDI" record status --data-dir "$DATA" --id RECORDING_ID
node "$MIDI" record stop --data-dir "$DATA" --id RECORDING_ID --name take.mid
node "$MIDI" runtime stop --data-dir "$DATA"
```

Use append, bars extract/replace, cc insert, or sustain insert for edits. Use args-file when ranges or nested options are needed. New named saves reject existing names unless overwrite is requested. In-place editing operations keep their fileId; derived operations can return a new ID. Check the returned payload.

Simulated capture requires no device: capture start --source simulated, capture feed --id ID --events '[{"kind":"on","note":60,"velocity":100,"at":0},{"kind":"off","note":60,"at":100}]', then capture status --id ID. Event at values are milliseconds relative to capture start. It captures a chord, not a phrase.

Real MIDI needs the native midi dependency and operating-system MIDI ports. A virtual bus routes messages but does not synthesize sound; connect it to a synthesizer. Actual macOS input/output and simultaneous recording/playback need hardware verification in the target environment. SIGKILL and power loss do not guarantee unsaved recording recovery. Windows local control is not yet verified.

Legacy migration is explicit: migrate analyze --source-base OLD_ROOT --manifests '["/absolute/manifest.json"]' --data-dir NEW_DATA. migrate import uses the same options and defaults to dry-run; --apply copies selected files while preserving IDs. Inspect missing/conflicting entries first and retain the old data.


## Foreground recording and play/record

`record` waits in the current command and returns the saved file when the requested duration or an input timeout finishes:

```sh
node "$MIDI" record --data-dir "$DATA" --port 'Actual input' --duration-ms 10000 --name take.mid
node "$MIDI" play-record --data-dir "$DATA" --file-id FILE_ID --play-port 'Actual output' --record-port 'Actual input' --pre-roll-ms 250 --post-roll-ms 500 --max-duration-ms 30000 --name take.mid
```

`play-record` requires both explicit ports, opens recording first, observes preroll, starts playback, and saves after completion plus postroll. Both sessions use the runtime for the same data directory. The maximum duration includes preroll and playback; choose enough time for the entire performance. Default maximum is 30000ms. If recording ends before playback, playback is stopped and the command returns an error with any available saved recording. If playback and recording finish together, the saved result is returned successfully. Automatic timeout saves honor the name requested at start; a collision can produce a numbered recording name unless overwrite is true.

`record --duration-ms` requests a timed recording; explicit --max-duration-ms can impose another cap. Idle/silence timeouts can finish it earlier. Commands poll for the saved result and do not resave an automatically completed recording. SIGINT/SIGTERM clean up only the sessions started by the command and return a cancellation result with available saved recording information. Cleanup is bounded; a disconnected runtime can leave an operation's outcome unknown, so inspect its session ID before retrying. These workflows require functioning native MIDI ports; simulated workflow tests do not establish hardware latency or sound quality.
