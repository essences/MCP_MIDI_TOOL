import type { JsonMidiSong } from "./jsonSchema.js";

// Minimal scaffold: encode header and one empty track; NOT production-ready.
// Will be evolved with proper event encoding in subsequent commits.
export function encodeToSmfBinary(song: JsonMidiSong): Uint8Array {
  // Header chunk: 'MThd' + length 6 + format(1) + ntrks + division(ppq)
  const ppq = song.ppq || 480;
  const ntrks = Math.max(1, song.tracks.length);
  const header = new Uint8Array(14);
  header.set([0x4d,0x54,0x68,0x64, 0x00,0x00,0x00,0x06, 0x00,0x01, (ntrks>>8)&0xff, ntrks&0xff, (ppq>>8)&0xff, ppq&0xff]);
  // Minimal one empty tick track with EndOfTrack
  const track = new Uint8Array([0x4d,0x54,0x72,0x6b, 0x00,0x00,0x00,0x04, 0x00, 0xff,0x2f,0x00]);
  const out = new Uint8Array(header.length + track.length);
  out.set(header, 0); out.set(track, header.length);
  return out;
}
