# MCP MIDI TOOL - R1 要件定義（非AI・ローカル機能版）

最終更新: 2025-08-13

## 1. 背景/目的
- MCPサーバー（TypeScript）で、AIは外部クライアントとして利用する前提。
- サーバーは決定論的なローカル処理のみを提供し、AIはMCPツールを呼び出してMIDIの読み書き/再生/変換を行う。

## 2. スコープ（MVP）
提供するMCPツール:
- store_midi: Base64またはサンドボックス内パスからMIDIを保存し、fileIdを発行
- get_midi: fileIdまたはパスからMIDIとメタ情報を取得（任意でBase64同梱）
- list_midi: 保存済みMIDIの一覧取得（ページング）
- export_midi: 保存済みMIDIを配布用ディレクトリにエクスポート
- playback_midi: 指定MIDIをCoreMIDIへ出力して再生
- stop_playback: 再生中のセッションを停止
- list_devices: MIDI出力デバイスの列挙
- transform_midi: 決定論的な変換（transpose/quantizeの最小セット）

除外:
- AIによる生成/分析（AIロジックは内包しない）

## 3. データ/サンドボックス
- 保存先: data/midi
- エクスポート先: data/export
- マニフェスト: data/manifest.json（{ id, name, path, bytes, createdAt }）
- パスはサンドボックス内の相対のみ許可。絶対パスは禁止。

## 4. ツールI/O
共通エラー: { error: true, code: string, message: string, details?: any }
サイズ上限: 10MB

- store_midi
  - inputs: { base64?: string; path?: string; name?: string; overwrite?: boolean }
  - outputs: { fileId: string; path: string; bytes: number; createdAt: string }

- get_midi
  - inputs: { fileId?: string; path?: string; includeBase64?: boolean }
  - outputs: { fileId: string; name: string; path: string; bytes: number; base64?: string; metadata?: { ppq?: number; durationMs?: number } }

- list_midi
  - inputs: { limit?: number; cursor?: string }
  - outputs: { items: Array<{ fileId: string; name: string; bytes: number; createdAt: string }>; nextCursor?: string }

- export_midi
  - inputs: { fileId?: string; path?: string; exportName?: string; overwrite?: boolean }
  - outputs: { exportPath: string; bytes: number }

- playback_midi
  - inputs: { source: { fileId?: string; base64?: string; path?: string }; portName?: string; loop?: boolean; startAtMs?: number }
  - outputs: { playbackId: string; status: "started"; durationEstMs?: number }

- stop_playback
  - inputs: { playbackId: string }
  - outputs: { status: "stopped" }

- list_devices
  - outputs: { outputs: Array<{ id: string; name: string }> }

- transform_midi
  - inputs: { source: any; operations: Array< { type: "transpose"; semitones: number } | { type: "quantize"; grid: "1/4"|"1/8"|"1/16"|"1/32"; strength?: number } > }
  - outputs: { fileId: string; base64?: string; bytes: number }

## 5. 非機能
- 実行タイムアウト: 60秒（再生除く）
- 同時実行: 最大3（設定可能）
- ログ: 構造化ログ、操作ID（fileId/playbackId）でトレース
- セキュリティ: サンドボックス外パス禁止、Base64は閾値超過で省略

## 6. 受入基準
- list_devices がmacOSでMIDI出力を列挙
- store_midi → fileId発行、data/midi に保存
- get_midi → メタとサイズが返る。要求時のみbase64同梱
- export_midi → data/export に出力（overwriteポリシー準拠）
- playback_midi/stop_playback が正常動作
- transform_midi が移調/量子化を適用し、DAWで開けるMIDIを出力

## 7. リスク/制約
- OS依存（CoreMIDI前提）。他OSは次フェーズ。
- 解析精度は機能外（AI側で対応）

## 8. オープン事項
- transform_midi の拡張（tempo/humanize）の投入タイミング
- 既定のポート選択ポリシー（portName未指定時）
