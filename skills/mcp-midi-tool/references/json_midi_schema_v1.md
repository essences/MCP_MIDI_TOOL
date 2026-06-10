# JSON MIDI Schema v1（ドラフト）

目的: LLM/人間双方にとって生成・レビュー・差分管理しやすいJSON表現でMIDIコンテンツを記述し、決定論的にSMF(Standard MIDI File)へコンパイルできる“契約”を定義する。

関連: ADR-0002 JSONファースト作曲フローの採用（`docs/adr/ADR-0002-json-first-composition.md`）

---

## ゴール / 非ゴール
- ゴール
  - JSON→SMFの決定論的コンパイル（順序・境界条件の明確化）
  - LLMが安全に出力しやすいデータ形（値域・単位・必須性）
  - バリデーション（Zod）での厳格チェック
- 非ゴール
  - 全MIDI仕様の完全網羅（v1は代表イベントに集中）
  - エディタUI/DAW機能

---

## 時間と単位
- tick（非負の整数）を標準とする。
- PPQ（Pulses Per Quarter note）はヘッダで指定（例: 480）。
- テンポはusPerQuarter（マイクロ秒/四分音符）で指定。

---

## データモデル（概念）
- Header
  - format: 0 または 1（既定: 1）
  - ppq: 正の整数（例: 480）
- Track
  - name?: 文字列
  - channel?: 0..15（省略時はイベント側のchannelを必須とするか、トラックchannelを既定にする方針のどちらか。v1は「イベント側優先、なければtrack.channel」を許容）
  - events: Event[]
  - 注意（外部表記との対応）: 外部からチャンネルを指定するAPI/DSLでは 1〜16 を使用し、内部JSONでは 0..15 に正規化します（ch1→0）。ドキュメントやプロンプトでは“0”というチャンネル番号を推奨しません。
- Event（代表）
  - note: { type:"note", tick, pitch(0..127), velocity(1..127), duration(>=1), channel? }
  - cc: { type:"cc", tick, controller(0..127), value(0..127), channel? }
  - program: { type:"program", tick, program(0..127), channel? }
  - pitchBend: { type:"pitchBend", tick, value(-8192..8191), channel? }
  - aftertouch.channel: { type:"aftertouch.channel", tick, pressure(0..127), channel? }
  - aftertouch.poly: { type:"aftertouch.poly", tick, pitch(0..127), pressure(0..127), channel? }
  - meta.tempo: { type:"meta.tempo", tick, usPerQuarter(>0) }
  - meta.timeSignature: { type:"meta.timeSignature", tick, numerator(>0), denominator(oneof 1|2|4|8|16|32) }
  - meta.keySignature: { type:"meta.keySignature", tick, sf(-7..7), mi(0|1) }  // sf: 調号、mi: 0=major,1=minor
  - meta.marker: { type:"meta.marker", tick, text(string<=128) }
  - meta.trackName: { type:"meta.trackName", tick, text(string<=128) }
  - raw?（将来）: { type:"raw", tick, status(0..255), data:number[] (0..255) }

---

## 正規化（Normalization）と順序ルール
- tickは非負の整数。無効（小数/負）の場合はバリデーションエラー。
- コンパイル前にイベントは以下で安定ソートする。
  1) tick 昇順
  2) 同tick内の種別優先度（低いほど先）:
     - noteOff（生成される仮想種別） → noteOn(note) → cc → program → pitchBend → aftertouch → meta.* → raw
  3) note系の同tick内は pitch 昇順、ccは controller 昇順、metaはtype名昇順
- noteはコンパイル時に On/Off へ分解。
  - velocity=0は使用しない（NoteOffと等価だが混乱を避けるため）。
- フォーマットは既定1（複数トラック対応）。format=0も許容だがv1では同一トラック集約と等価に扱う。

---

## Zodスキーマ（TypeScript抜粋）
```ts
import { z } from "zod";

export const zTick = z.number().int().min(0);
export const zChan = z.number().int().min(0).max(15);
export const zPitch = z.number().int().min(0).max(127);
export const zVel = z.number().int().min(1).max(127);
export const zDur = z.number().int().min(1);

const zProgram = z.number().int().min(0).max(127);
const zCC = z.object({ controller: z.number().int().min(0).max(127), value: z.number().int().min(0).max(127) });

const zEvtNote = z.object({
  type: z.literal("note"),
  tick: zTick,
  pitch: zPitch,
  velocity: zVel,
  duration: zDur,
  channel: zChan.optional(),
});

const zEvtCC = z.object({ type: z.literal("cc"), tick: zTick, channel: zChan.optional() }).and(zCC);
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
  // rawは将来
]);

export const zTrack = z.object({
  name: z.string().optional(),
  channel: zChan.optional(),
  events: z.array(zEvent),
});

export const zHeader = z.object({
  format: z.union([z.literal(0), z.literal(1)]).default(1),
  ppq: z.number().int().min(24).max(15360).default(480),
});

export const zSong = z.object({ format: zHeader.shape.format, ppq: zHeader.shape.ppq, tracks: z.array(zTrack).min(1) });
export type JsonMidiSong = z.infer<typeof zSong>;
```

---

## 最小例（単音とテンポ）
```json
{
  "format": 1,
  "ppq": 480,
  "tracks": [
    {
      "name": "Piano",
      "channel": 0,
      "events": [
        { "type": "meta.tempo", "tick": 0, "usPerQuarter": 500000 },
        { "type": "program", "tick": 0, "program": 0 },
        { "type": "note", "tick": 0, "pitch": 60, "velocity": 100, "duration": 480 }
      ]
    }
  ]
}
```

---

## ツールI/F（予定）
- json_to_smf
  - 入力: { json: JsonMidiSong, name?: string }
  - 出力: { ok: true, fileId, path, bytes, createdAt }
- smf_to_json
  - 入力: { fileId }
  - 出力: { ok: true, json: JsonMidiSong, stats? }

---

## コンパイル規約（要約）
- イベントを正規化の順でソート→noteをOn/Offへ分解→delta tick→VLQ→MTrk長→終端FF2F00
- channelの決定: event.channel ?? track.channel（なければエラー）
- meta.trackNameは各トラック先頭へ挿入可能（任意）
- velocity0は禁止（NoteOff等価）。duration>=1必須

---

## 今後の拡張
- SysEx/Rawのセーフリスト化、歌詞/テキスト系の拡張
- Key/TimeSigの中間表現整備（全曲共通/トラック局所）
- 巨大曲の分割/圧縮（MCP転送最適化）

---
## 構造化エラー応答ポリシー（実装リファレンス）
MCPツール呼び出し失敗時は以下フォーマットを返します。
```jsonc
{
  "ok": false,
  "error": { "tool": "<toolName>", "code": "<ERROR_CODE>", "message": "...", "hint": "...", "issues": [ { "path": [..], "message": "..." } ] }
}
```
ERROR_CODE 一覧:
| Code | 説明 | 代表的発生条件 | クライアント推奨対処 |
|------|------|----------------|-----------------------|
| MISSING_PARAMETER | 必須引数欠如 | `'<param>' is required` | 送信ペイロードへ追加 |
| NOT_FOUND | 対象リソースなし | 無効 fileId | list/find で再取得 |
| VALIDATION_ERROR | スキーマ/コンパイル失敗 | Zod/DSL 変換失敗 | issues を利用し再生成 |
| INPUT_FORMAT_ERROR | 軽度入力フォーマット誤り | 音名 typo など | 入力正規化/再入力 |
| LIMIT_EXCEEDED | 制限超過 | サイズ/件数超過 | 分割し append で送る |
| DEVICE_UNAVAILABLE | 出力不可 | node-midi 未ロード | dryRun モードへフォールバック |
| INTERNAL_ERROR | 想定外例外 | 予期しない throw | ログ採取 & 再送（再発時報告） |

備考:
- `issues` は Zod の `issues` を `{ path, message }` に縮約したもの。
- message には内部詳細を過剰に含めない（セキュリティ・ノイズ対策）。
- 追加予定: CHANNEL_RANGE_ERROR / TICK_RANGE_ERROR / RATE_LIMITED など。
