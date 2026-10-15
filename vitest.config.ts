import { defineConfig } from 'vitest/config';
// Historical MCP protocol/transport assertions remain in tests for reference.
// The default suite explicitly covers the current MCP-free API and entrypoints.
export default defineConfig({test:{include:[
  'tests/engine_*.test.ts',
  'tests/cli_*.test.ts',
  'tests/storage_v2*.test.ts',
  'tests/data_migration*.test.ts',
  'tests/file_store*.test.ts',
  'tests/playback_plan*.test.ts',
  'tests/playback_runtime*.test.ts',
  'tests/session_store*.test.ts',
  'tests/package_skill*.test.ts',
  'tests/codec_*.test.ts',
  'tests/direct_api*.test.ts',
  'tests/workflows*.test.ts',
  'tests/score_to_json_midi*.test.ts',
]}});
