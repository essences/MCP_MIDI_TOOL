# ADR-0002: JSONファースト作曲フローの採用とSMFコンパイル

- Status: Accepted
- Date: 2025-08-17
- Owners: MCP MIDI TOOL

## 背景 / Context
AI（LLM）に長大なBase64バイナリを直接生成させると、欠損・改行混入・差分レビュー困難などの問題がある。作曲・編集・反復においては、宣言的で検証可能なJSON構造でMIDI内容を表現し、それを決定論的にSMF（Standard MIDI File）へコンパイルする方が堅牢で効率的。

## 決定 / Decision
- 「JSONファースト」モードを採用する。
  - 作曲/編集は構造化JSONを一次成果物とし、サーバ側でSMFへコンパイル。
  - 既存のSMF/外部DLファイルは従来どおり `store_midi` → `play_smf` で扱う（共存）。
- 新規ツール（MCP）を追加する。
  - `json_to_smf { json, name? }`: JSONを検証→SMFへコンパイル→保存し `fileId` を返却。
  - `smf_to_json { fileId }`: 既存SMFを解析し、同等のJSONへデコンパイル（編集→再コンパイル用）。
- JSONはZod等で厳格にバリデーションし、決定論的なエンコード（同tick順序など）ルールを適用する。

## JSONスキーマ（最小案）
単位はtick、ヘッダでPPQを指定。テンポはメタイベントとしてtickに紐付ける。以下は最小例。

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
        { "type": "cc", "tick": 0, "controller": 64, "value": 0 },
        { "type": "note", "tick": 0, "pitch": 60, "velocity": 100, "duration": 480 },
        { "type": "note", "tick": 480, "pitch": 62, "velocity": 100, "duration": 480 }
      ]
    }
  ]
}
```

留意点:
- 時間はtick基準。ms指定は丸め誤差を生むため避けるか、内部変換時に注意。
- 同tickでの順序は `NoteOff → NoteOn → その他` で正規化。
- 未知イベントに備えて `raw`（任意ステータス/バイト列）も将来拡張で許容。

## コンパイル/デコンパイル指針
- JSON→SMF
  - ノートはOn/Offに分解し、delta tick→VLQでエンコード。
  - MTrk長は4バイトBE、終端 `FF 2F 00` を付与。
  - エクスポートは `data/midi` に保存し、manifestに登録。
- SMF→JSON
  - @tonejs/midi 等で解析し、上記スキーマへマッピング。
  - ラウンドトリップ（JSON→SMF→JSON）で同値性に近い性質をテスト。

## 効果 / Consequences
- 生成安定性: Base64直渡しより壊れにくい。
- レビュー性: JSON差分で内容が明確。コードレビュー/Gitにも好適。
- 反復編集: 一部修正が容易。テンポや一節の差し替えに強い。
- バリデーション: Zod/Schemaで早期にエラー箇所を特定可能。

## 代替案
- Base64のみ: 単純だが壊れやすく、デバッグが困難。
- SMF編集専用: LLMとの相性が悪く、宣言的編集が難しい。

## 実装計画 / Plan
1) `docs/specs/json_midi_schema_v1.md` を起草（Zod型定義を含む）。
2) MCPツール `json_to_smf` 実装（TDD: 正常/異常・順序・テンポ）。
3) MCPツール `smf_to_json` 実装（TDD: 代表イベントの往復変換）。
4) プロンプト例とREADME更新（JSONファーストの手順）。
5) 大曲対策（分割/圧縮）の検討をバックログへ登録。

## 関連
- ADR-0001: node-midi 採用
- README: JSONファーストモードの説明
