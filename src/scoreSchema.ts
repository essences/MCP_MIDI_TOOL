import { z } from "zod";

export const zBar = z.number().int().min(0); // allow 0 for upbeat
export const zBeat = z.number().int().min(1);
export const zPPQ = z.number().int().min(24).max(15360).default(480);

export const zPosition = z.object({
  bar: zBar, // 1..N (0 allowed for upbeat)
  beat: zBeat, // 1..numerator
  unit: z.number().int().min(1).optional(), // subdivision per beat
  offset: z.number().int().min(0).optional(), // in unit
});

// Notation values like "1", "1/2", "1/4" etc
export const zNotationValue = z.enum(["1", "1/2", "1/4", "1/8", "1/16", "1/32"]);
export const zRationalValue = z.object({ numerator: z.number().int().min(1), denominator: z.number().int().min(1) });

export const zDurationSpec = z.object({
  value: z.union([zNotationValue, zRationalValue]),
  dots: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  tuplet: z.object({ inSpaceOf: z.number().int().min(1), play: z.number().int().min(1) }).optional(),
});

export const zArticulation = z.enum(["staccato", "tenuto", "legato", "accent", "marcato"]);

const zDyn = z.enum(["pp", "p", "mp", "mf", "f", "ff"]);

export const zNoteEvent = z.object({
  type: z.literal("note"),
  pitch: z.number().int().min(0).max(127).optional(),
  note: z.string().regex(/^[A-Ga-g](#|b)?-?\d+$/).optional(),
  start: zPosition,
  duration: zDurationSpec,
  velocity: z.number().int().min(1).max(127).optional(),
  dynamic: zDyn.optional(),
  tie: z.boolean().optional(),
  slur: z.boolean().optional(),
  articulation: zArticulation.optional(),
});

export const zMarkerEvent = z.object({ type: z.enum(["marker", "trackName"]), text: z.string().max(128), at: zPosition });

export const zControlEvent = z.object({
  type: z.enum(["cc", "pitchBend"]),
  cc: z.number().int().min(0).max(127).optional(),
  value: z.number().int().min(0).max(127).optional(),
  bend: z.number().int().min(-8192).max(8191).optional(),
  at: zPosition,
});

export const zScoreEvent = z.discriminatedUnion("type", [zNoteEvent, zMarkerEvent, zControlEvent]);

export const zTimeSignature = z.object({ numerator: z.number().int().min(1), denominator: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8), z.literal(16)]) });
export const zKeySignature = z.object({ root: z.enum(["C","G","D","A","E","B","F#","C#","F","Bb","Eb","Ab","Db","Gb","Cb"]), mode: z.enum(["major","minor"]) });

export const zTempo = z.union([
  z.object({ bpm: z.number().positive() }),
  z.object({ changes: z.array(z.object({ bar: z.number().int().min(1), beat: z.number().int().min(1), bpm: z.number().positive() })) }),
]);

export const zScoreTrack = z.object({
  name: z.string().optional(),
  channel: z.number().int().min(0).max(15).default(0),
  program: z.number().int().min(0).max(127).default(0),
  events: z.array(zScoreEvent),
});

export const zScore = z.object({
  ppq: zPPQ,
  meta: z.object({
    timeSignature: zTimeSignature,
    keySignature: zKeySignature,
    tempo: zTempo,
    title: z.string().optional(),
    composer: z.string().optional(),
    // 自動CC付与プリセット（最小実装）：sustain_from_slur
    autoCcPresets: z
      .array(
        z.object({
          id: z.enum(["sustain_from_slur"]),
        })
      )
      .optional(),
  }),
  tracks: z.array(zScoreTrack).min(1),
});

export type Score = z.infer<typeof zScore>;
export type Position = z.infer<typeof zPosition>;
export type DurationSpec = z.infer<typeof zDurationSpec>;
export type ScoreEvent = z.infer<typeof zScoreEvent>;
export type ScoreTrack = z.infer<typeof zScoreTrack>;
