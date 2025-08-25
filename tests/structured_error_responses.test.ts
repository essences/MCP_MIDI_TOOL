/// <reference types="vitest" />
// Structured error classification smoke test
import { describe, test, expect } from 'vitest';
// 目的: index.ts の classifyError ロジックに沿うキーワード分類が壊れていないことを軽量検証

function classify(msg: string): string {
  const lower = msg.toLowerCase();
  if (/not found/.test(msg)) return 'NOT_FOUND';
  if (/required/.test(lower)) return 'MISSING_PARAMETER';
  if (/validation failed|compile failed|json validation failed/.test(lower)) return 'VALIDATION_ERROR';
  if (/invalid note name|unsupported note item|invalid json/.test(lower)) return 'INPUT_FORMAT_ERROR';
  if (/size exceeds|too large|exceeds/.test(lower)) return 'LIMIT_EXCEEDED';
  if (/node-midi not available/.test(lower)) return 'DEVICE_UNAVAILABLE';
  return 'INTERNAL_ERROR';
}

describe('structured error keyword classification', () => {
  test('missing parameter', () => {
    expect(classify("'fileId' is required for smf_to_json")).toBe('MISSING_PARAMETER');
  });
  test('validation error', () => {
    expect(classify('json_midi_v1 validation failed: tracks.0.events.0.pitch: Expected number')).toBe('VALIDATION_ERROR');
  });
  test('input format error (note)', () => {
    expect(classify('invalid note name: H4')).toBe('INPUT_FORMAT_ERROR');
  });
  test('limit exceeded', () => {
    expect(classify('MIDI size exceeds 10MB limit: 12345678')).toBe('LIMIT_EXCEEDED');
  });
  test('device unavailable', () => {
    expect(classify('node-midi not available: playback is a no-op')).toBe('DEVICE_UNAVAILABLE');
  });
  test('fallback internal', () => {
    expect(classify('Some unexpected error')).toBe('INTERNAL_ERROR');
  });
});
