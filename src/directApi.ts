import { createMidiEngine } from './engine.js';

export type SupportedFormat = 'json_midi_v1' | 'score_dsl_v1';
export type ControllerRangeInput = {
  startTick: number;
  endTick: number;
  channel?: number;
  trackIndex?: number;
  valueOn?: number;
  valueOff?: number;
  removeExisting?: boolean;
};

/** Convenience API uses the same operations, storage and playback plans as the CLI. */
async function withEngine<T>(work: (call: (name: string, args?: Record<string, any>) => Promise<any>) => Promise<T>): Promise<T> {
  const engine = createMidiEngine();
  try {
    return await work(async (name, args) => {
      const result = await engine.call(name, args);
      if (!result.ok) throw Object.assign(new Error(result.error?.message || 'MIDI operation failed'), result.error);
      return result;
    });
  } finally { await engine.dispose(); }
}

export function saveSongAsSmf(params: {json: unknown; format?: SupportedFormat; name?: string; overwrite?: boolean}) {
  return withEngine(call => call('json_to_smf', params));
}

export function loadSmfAsJson(fileId: string) {
  return withEngine(async call => ({fileId, ...await call('smf_to_json', {fileId})}));
}

/** Generic CC insertion follows the engine's additive semantics; removeExisting is honored by sustain insertion. */
export function insertControllerRanges(params: {fileId: string; controller: number; ranges: ControllerRangeInput[]; outputName?: string}) {
  return withEngine(async call => ({...await call('insert_cc', params), controller: params.controller, rangeCount: params.ranges.length}));
}

export function insertSustainRanges(params: {fileId: string; ranges: ControllerRangeInput[]; outputName?: string}) {
  return withEngine(async call => ({...await call('insert_sustain', params), controller: 64, rangeCount: params.ranges.length}));
}

export function exportMidiFile(fileId: string, outputName?: string) {
  return withEngine(call => call('export_midi', {fileId, outputName}));
}

export function analyzeSmfDryRun(fileId: string) {
  return withEngine(async call => {
    const loaded = await call('smf_to_json', {fileId});
    const analysis = await call('play_smf', {fileId, dryRun: true});
    return {...analysis, fileId, ppq: loaded.json.ppq, trackCount: loaded.trackCount};
  });
}
