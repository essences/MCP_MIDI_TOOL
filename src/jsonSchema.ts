import { z } from "zod";

export const zTick = z.number().int().min(0);
export const zChan = z.number().int().min(0).max(15);
export const zPitch = z.number().int().min(0).max(127);
export const zVel = z.number().int().min(1).max(127);
export const zDur = z.number().int().min(1);

const zProgram = z.number().int().min(0).max(127);
const zCCNum = z.number().int().min(0).max(127);

const zEvtNote = z.object({
  type: z.literal("note"),
  tick: zTick,
  pitch: zPitch,
  velocity: zVel,
  duration: zDur,
  channel: zChan.optional(),
});

const zEvtCC = z.object({
  type: z.literal("cc"),
  tick: zTick,
  controller: zCCNum,
  value: zCCNum,
  channel: zChan.optional(),
});
const zEvtProgram = z.object({ type: z.literal("program"), tick: zTick, program: zProgram, channel: zChan.optional() });
const zEvtPB = z.object({ type: z.literal("pitchBend"), tick: zTick, value: z.number().int().min(-8192).max(8191), channel: zChan.optional() });
const zEvtATCh = z.object({ type: z.literal("aftertouch.channel"), tick: zTick, pressure: z.number().int().min(0).max(127), channel: zChan.optional() });
const zEvtATPoly = z.object({ type: z.literal("aftertouch.poly"), tick: zTick, pitch: zPitch, pressure: z.number().int().min(0).max(127), channel: zChan.optional() });

const zEvtTempo = z.object({ type: z.literal("meta.tempo"), tick: zTick, usPerQuarter: z.number().int().min(1) });
const zEvtTS = z.object({ type: z.literal("meta.timeSignature"), tick: zTick, numerator: z.number().int().min(1), denominator: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8), z.literal(16), z.literal(32)]) });
const zEvtKS = z.object({ type: z.literal("meta.keySignature"), tick: zTick, sf: z.number().int().min(-7).max(7), mi: z.union([z.literal(0), z.literal(1)]) });
const zEvtMarker = z.object({ type: z.literal("meta.marker"), tick: zTick, text: z.string().max(128) });
const zEvtTrackName = z.object({ type: z.literal("meta.trackName"), tick: zTick, text: z.string().max(128) });

export const zEvent = z.discriminatedUnion("type", [
  zEvtNote, zEvtCC, zEvtProgram, zEvtPB, zEvtATCh, zEvtATPoly,
  zEvtTempo, zEvtTS, zEvtKS, zEvtMarker, zEvtTrackName,
]);

export const zTrack = z.object({
  name: z.string().optional(),
  channel: zChan.optional(),
  events: z.array(zEvent),
});

export const zSong = z.object({
  format: z.union([z.literal(0), z.literal(1)]).default(1),
  ppq: z.number().int().min(24).max(15360).default(480),
  tracks: z.array(zTrack).min(1),
});

export type JsonMidiSong = z.infer<typeof zSong>;
