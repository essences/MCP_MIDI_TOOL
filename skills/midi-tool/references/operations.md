# Operation arguments

Use kebab-case flags for simple values, JSON arrays for --ranges/--events/--notes, and --args-file for nested arguments. A complete argument file uses camelCase names. `run --operation NAME --args-file FILE` exposes these engine operations.

| Commands | Operation | Required arguments; useful optional arguments |
|---|---|---|
| compose | json_to_smf | json; format json_midi_v1 or score_dsl_v1, name, overwrite |
| import | store_midi | base64; name, overwrite (named CLI import reads SMF --input) |
| decode / inspect | smf_to_json / get_midi | fileId; inspect includeBase64 |
| list / find / export / clean | list_midi / find_midi / export_midi / clean_midi | list limit/offset; find query; export/clean fileId |
| append | append_to_smf | fileId,json; format,atTick,atEnd,gapTicks,trackIndex,preserveTrackStructure,trackMapping,outputName,overwrite,keepGlobalMeta,allowKeyChange |
| bars extract | extract_bars | fileId,startBar,endBar; format (output is JSON MIDI) |
| bars replace | replace_bars | fileId,startBar,endBar,json; format,outputName,overwrite |
| cc insert | insert_cc | fileId,controller,ranges |
| sustain insert | insert_sustain | fileId,ranges |
| devices list | list_devices / list_input_devices | direction output/input selects operation |
| play | play_smf | fileId; portName,startMs,stopMs,startBar,endBar,dryRun,schedulerLookaheadMs,schedulerTickMs |
| notes | trigger_notes | notes; velocity,durationMs,channel,program,portName,transpose,dryRun |
| playback status / stop | get_playback_status / stop_playback | playbackId |
| capture start | start_single_capture / start_device_single_capture | source simulated/device selects operation; portName,onsetWindowMs,silenceMs,maxWaitMs,finalizeOnRelease |
| capture feed / status | feed_single_capture / get_single_capture_status | captureId; feed events |
| record start | start_continuous_recording | portName,ppq,maxDurationMs,idleTimeoutMs,silenceTimeoutMs,channelFilter,eventTypeFilter |
| record status / stop | get_continuous_recording_status / stop_continuous_recording | recordingId; stop name,overwrite |
| record list | list_continuous_recordings | status active/completed/all,limit |
| playback-poc | playback_midi | fileId; portName,durationMs. Legacy middle-C diagnostic, not SMF playback. |

Ranges use `{startTick,endTick,channel?,trackIndex?,valueOn?,valueOff?}`; sustain ranges also accept removeExisting. Example argument file:

```json
{"fileId":"RETURNED_ID","controller":11,"ranges":[{"startTick":0,"endTick":960,"channel":1,"valueOn":90,"valueOff":0}]}
```

Capture feed events use `{kind:"on"|"off",note:60,velocity:100,at:0}`. Note names are strings such as C4; JSON MIDI numeric pitch uses `pitch`, while trigger_notes accepts an array of numbers or note names.

Bar edits currently use the first time signature, so verify results when the meter changes. Cleaning deliberately reduces tempo/time/key metadata and merges channel tracks; inspect before applying it to music with changes. Cross-command sessions belong to the runtime associated with the selected data directory.
