export class InputError extends Error {
}
export const operations = ['store_midi', 'json_to_smf', 'smf_to_json', 'clean_midi', 'append_to_smf', 'insert_sustain', 'insert_cc', 'extract_bars', 'replace_bars', 'get_midi', 'list_midi', 'find_midi', 'export_midi', 'list_devices', 'list_input_devices', 'play_smf', 'get_playback_status', 'stop_playback', 'playback_midi', 'trigger_notes', 'start_single_capture', 'start_device_single_capture', 'feed_single_capture', 'get_single_capture_status', 'start_continuous_recording', 'get_continuous_recording_status', 'stop_continuous_recording', 'list_continuous_recordings'];
const aliases = { compose: 'json_to_smf', decode: 'smf_to_json', import: 'store_midi', inspect: 'get_midi', list: 'list_midi', find: 'find_midi', export: 'export_midi', clean: 'clean_midi', append: 'append_to_smf', 'bars extract': 'extract_bars', 'bars replace': 'replace_bars', 'cc insert': 'insert_cc', 'sustain insert': 'insert_sustain', play: 'play_smf', 'playback status': 'get_playback_status', 'playback stop': 'stop_playback', notes: 'trigger_notes', 'playback-poc': 'playback_midi', 'capture feed': 'feed_single_capture', 'capture status': 'get_single_capture_status', 'record start': 'start_continuous_recording', 'record status': 'get_continuous_recording_status', 'record stop': 'stop_continuous_recording', 'record list': 'list_continuous_recordings' };
const numeric = new Set(['pre-roll-ms', 'post-roll-ms', 'limit', 'offset', 'at-tick', 'gap-ticks', 'track-index', 'controller', 'start-bar', 'end-bar', 'start-ms', 'stop-ms', 'scheduler-lookahead-ms', 'scheduler-tick-ms', 'velocity', 'duration-ms', 'channel', 'program', 'transpose', 'onset-window-ms', 'silence-ms', 'max-wait-ms', 'ppq', 'max-duration-ms', 'idle-timeout-ms', 'silence-timeout-ms']);
const boolean = new Set(['overwrite', 'at-end', 'preserve-track-structure', 'keep-global-meta', 'allow-key-change', 'include-base64', 'dry-run', 'background', 'finalize-on-release', 'apply']);
const arrays = new Set(['ranges', 'track-mapping', 'notes', 'events', 'channel-filter', 'event-type-filter', 'manifests']);
const strings = new Set(['play-port', 'record-port', 'data-dir', 'input', 'args-file', 'operation', 'format', 'name', 'file-id', 'output-name', 'query', 'port-name', 'port', 'id', 'playback-id', 'capture-id', 'recording-id', 'direction', 'source', 'status', 'source-base']);
export function parse(argv) {
    const words = [];
    const options = {};
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith('--')) {
            words.push(token);
            continue;
        }
        const split = token.indexOf('=');
        const key = token.slice(2, split < 0 ? undefined : split);
        if (!numeric.has(key) && !boolean.has(key) && !arrays.has(key) && !strings.has(key))
            throw new InputError(`Unknown option --${key}`);
        if (key in options)
            throw new InputError(`Repeated option --${key}`);
        let value = split < 0 ? undefined : token.slice(split + 1);
        if (boolean.has(key)) {
            if (value === undefined)
                value = true;
            else if (value === 'true')
                value = true;
            else if (value === 'false')
                value = false;
            else
                throw new InputError(`--${key} expects true or false`);
        }
        else {
            if (value === undefined) {
                value = argv[++i];
                if (value === undefined || value.startsWith('--'))
                    throw new InputError(`--${key} needs a value`);
            }
            if (numeric.has(key)) {
                if (!String(value).trim() || !Number.isFinite(Number(value)))
                    throw new InputError(`--${key} expects a finite number`);
                value = Number(value);
            }
            if (arrays.has(key)) {
                try {
                    value = JSON.parse(value);
                }
                catch {
                    throw new InputError(`--${key} expects a JSON array`);
                }
                if (!Array.isArray(value))
                    throw new InputError(`--${key} expects a JSON array`);
            }
        }
        options[key] = value;
    }
    const command = words.join(' ');
    let operation = aliases[command];
    if (command === 'run') {
        operation = options.operation;
        if (!operations.includes(operation))
            throw new InputError('Unknown operation');
    }
    else if (command === 'devices list') {
        if (options.direction && !['input', 'output'].includes(options.direction))
            throw new InputError('direction must be input or output');
        operation = options.direction === 'input' ? 'list_input_devices' : 'list_devices';
    }
    else if (command === 'capture start') {
        if (options.source && !['simulated', 'device'].includes(options.source))
            throw new InputError('source must be simulated or device');
        operation = options.source === 'device' ? 'start_device_single_capture' : 'start_single_capture';
    }
    else if (!operation && !['play-record', 'record', 'runtime status', 'runtime stop', 'doctor', 'migrate analyze', 'migrate import'].includes(command))
        throw new InputError(`Unknown command: ${command || '(empty)'}`);
    const args = {};
    for (const [key, value] of Object.entries(options)) {
        if (['data-dir', 'input', 'args-file', 'operation', 'background', 'direction', 'source', 'apply', 'manifests', 'source-base'].includes(key))
            continue;
        const camel = key === 'port' ? 'portName' : key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        args[camel] = value;
    }
    if (args.id !== undefined) {
        if (operation?.includes('playback'))
            args.playbackId = args.id;
        else if (operation?.includes('capture'))
            args.captureId = args.id;
        else if (operation?.includes('recording'))
            args.recordingId = args.id;
        else
            throw new InputError('--id is only valid for sessions');
        delete args.id;
    }
    return { command, operation, options, args };
}
export const help = `MIDI Tool (MCP-free)\nCommands: compose, import, inspect, decode, list, find, export, clean, append, bars extract|replace, cc insert, sustain insert, devices list, play, play-record, record --duration-ms MS, notes, playback status|stop, capture start|feed|status, record start|status|stop|list, runtime status|stop, doctor, migrate analyze|import.\nUse --data-dir DIR, --input FILE (or - for stdin), --args-file FILE.\nplay/notes wait by default; --background returns a session ID. --dry-run never emits MIDI.\nGeneric: run --operation NAME --args-file FILE\nArrays use JSON. Boolean flags accept --flag or --flag=true|false.\n`;
export function validateRequired(operation, args) {
    const required = { store_midi: ['base64'], json_to_smf: ['json'], smf_to_json: ['fileId'], clean_midi: ['fileId'], append_to_smf: ['fileId', 'json'], insert_sustain: ['fileId', 'ranges'], insert_cc: ['fileId', 'controller', 'ranges'], extract_bars: ['fileId', 'startBar', 'endBar'], replace_bars: ['fileId', 'startBar', 'endBar', 'json'], get_midi: ['fileId'], export_midi: ['fileId'], play_smf: ['fileId'], playback_midi: ['fileId'], trigger_notes: ['notes'], get_playback_status: ['playbackId'], stop_playback: ['playbackId'], feed_single_capture: ['captureId', 'events'], get_single_capture_status: ['captureId'], get_continuous_recording_status: ['recordingId'], stop_continuous_recording: ['recordingId'], find_midi: ['query'] };
    for (const key of required[operation] || [])
        if (args[key] === undefined || args[key] === null || args[key] === '')
            throw new InputError(`Missing required argument: ${key}`);
}
export function validateWorkflow(command, args) {
    const common = ['name', 'overwrite', 'maxDurationMs', 'ppq', 'idleTimeoutMs', 'silenceTimeoutMs', 'channelFilter', 'eventTypeFilter'];
    const allowed = new Set(command === 'play-record' ? [...common, 'fileId', 'playPort', 'recordPort', 'preRollMs', 'postRollMs'] : [...common, 'durationMs', 'portName']);
    for (const key of Object.keys(args))
        if (!allowed.has(key))
            throw new InputError(`Unsupported ${command} argument: ${key}`);
    if (command === 'play-record')
        for (const key of ['fileId', 'playPort', 'recordPort'])
            if (typeof args[key] !== 'string' || !args[key].trim())
                throw new InputError(`Missing required argument: ${key}`);
    for (const key of ['preRollMs', 'postRollMs', 'durationMs', 'maxDurationMs', 'ppq', 'idleTimeoutMs', 'silenceTimeoutMs'])
        if (args[key] !== undefined && (typeof args[key] !== 'number' || !Number.isFinite(args[key]) || args[key] < (key === 'preRollMs' || key === 'postRollMs' ? 0 : 1)))
            throw new InputError(`${key} must be a ${key === 'preRollMs' || key === 'postRollMs' ? 'nonnegative' : 'positive'} finite number`);
    if (args.maxDurationMs !== undefined && (args.maxDurationMs < 1000 || args.maxDurationMs > 3600000))
        throw new InputError('maxDurationMs must be 1000..3600000');
    for (const key of ['preRollMs', 'postRollMs'])
        if (args[key] !== undefined && args[key] > 3600000)
            throw new InputError(`${key} must not exceed 3600000`);
    if (args.durationMs !== undefined && args.durationMs > 3600000)
        throw new InputError('durationMs must not exceed 3600000');
    if (args.overwrite !== undefined && typeof args.overwrite !== 'boolean')
        throw new InputError('overwrite must be boolean');
    for (const key of ['channelFilter', 'eventTypeFilter'])
        if (args[key] !== undefined && !Array.isArray(args[key]))
            throw new InputError(`${key} must be an array`);
}
