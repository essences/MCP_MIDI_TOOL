# Private CoreMIDI loopback verification — 2026-10-15

Status: PASS. `npm run build` and the opt-in native script completed successfully on macOS (darwin), Node v23.5.0, on 2026-10-15.

The reusable opt-in command is:

```bash
npm run build
node scripts/verify_native_midi.mjs --run
```

The script creates one uniquely named virtual input destination (`MIDI-TOOL-QA-SINK-<pid>-<time>`) and virtual output source (`MIDI-TOOL-QA-SOURCE-<pid>-<time>`). It verifies exact discovery names before engine operations. It never opens IAC, a default port, a hardware port, or a pre-existing DAW port. Every generated MIDI and manifest lives under a temporary directory removed in `finally`, after engine disposal and closing both private ports.

The engine records from the private source while playing to the private sink. Sink observations must include program, controller, pitch bend, note on/off on internal channel 3 (external channel 4), followed by sustain release and all-notes-off. The source sends a separate note and expressive state; the saved recording is decoded to verify channel, duration, CC, program, and pitch bend. Success emits machine-readable evidence, including both simultaneous activity counters and the actual sink byte messages.

Related software checks: `tests/engine_editing.test.ts` passes four cases covering distinct tracks/channels after append, bar extraction/replacement to a new ID without source mutation, CC channel mapping to a new output, concurrent append preservation, and safe cleaning copies. These tests inject an empty MIDI adapter and emit no device messages.

Read-only finding: overlapping `insert_cc` ranges are currently stored as independent start/end edges. A range ending while another remains active can therefore emit an early OFF value; the engine owner has been notified. This report does not claim interval-union behavior.

The host's existing native MIDI installation is separate from fresh-install reproducibility. The parent investigation reports that fresh native building is blocked by the local Xcode license state; a successful loopback using the installed module would not validate a clean native build.

## Native execution evidence

Private endpoints were `MIDI-TOOL-QA-SINK-90884-1792030196379` and `MIDI-TOOL-QA-SOURCE-90884-1792030196379`. The simultaneous activity snapshot was `{playbacks:1, recordings:1, captures:0}`.

The virtual sink actually received these byte arrays, in order:

```json
[[195,9],[179,1,70],[227,0,68],[147,60,90],[131,60,0],[179,64,0],[179,123,0]]
```

These are program 9, CC1=70, pitch bend +512, note 60 on/off, CC64=0, and CC123=0, all on internal channel 3. The recorded private-source note decoded with duration **179.17 ms**; the saved SMF was **57 bytes** and contained **6 decoded events**. Assertions also verified recorded program 12, CC1=75, pitch bend +512, and internal channel 3. The result reported `usedExistingPorts:false`.

All assertions passed and the script exited zero. Engine disposal, private-port closure, and temporary-directory removal ran in `finally`. No existing user MIDI was read or changed. This validates actual CoreMIDI software routing and concurrent playback/recording on this host; it does not claim physical keyboard/audio-interface or DAW integration coverage.

## CLI workflow verification by the orchestrator

After final integration, separate compiled CLI processes ran `play-record` with 200ms preroll/postroll and `record --duration-ms 1000` against new private virtual SOURCE/SINK endpoints. Both returned success and retained the requested names: `workflow.mid` and `timed.mid`, each 45 bytes. The timed recording decoded with one channel-3 note of positive duration; the private sink received seven actual MIDI messages including centered pitch bend. Both sessions used a temporary data directory. The runtime, private ports and temporary files were closed/removed in `finally`. No existing hardware, IAC or DAW endpoints were opened.

## Independent review rerun

The parent reviewer independently reran the same private-port script successfully. The saved note measured **182.29 ms**, the recording remained **57 bytes / 6 decoded events**, and the result again reported `usedExistingPorts:false`. This is separate confirmation of the native assertions above.
