# R6: play_smf 仕様（最新版）

## ツール: play_smf
- パラメータ:
  - fileId (string, required): `store_midi` で保存したSMFのID
  - portName (string, optional): 出力ポート名の部分一致候補（大文字小文字無視）。未指定時は IAC/Network/Virtual を優先、なければ先頭ポート。
  - startMs (number, optional): 再生開始位置ms（既定0）
  - stopMs (number, optional): 再生停止位置ms（既定: 曲末）
  - dryRun (boolean, optional): 解析のみで送出しない（既定: false）
  - schedulerLookaheadMs (number, optional): ルックアヘッド窓（10..1000ms）
  - schedulerTickMs (number, optional): スケジューラのtick間隔（5..200ms）
- 返り値:
  - ok: boolean
  - playbackId: string（進捗照会/停止に使用）
  - scheduledEvents: number（スケジュールしたイベント数）
  - totalDurationMs: number（概算総尺ms）
  - warnings?: string[]（解析/出力に関する注意）

## 関連ツール
- get_playback_status(playbackId):
  - フィールド: { ok, type('smf'), fileId, scheduledEvents, totalDurationMs, cursor, lastSentIndex, lastSentAt, lookahead, tickInterval, portIndex, portName, activeNotes: string[], done: boolean }
- stop_playback(playbackId):
  - 動作: スケジューラ停止、未消音ノートに Note On velocity 0 を送出、各アクティブCHへ CC123(All Notes Off) を送出、ポートをクローズ。ok を返す。

## 内部仕様（実装準拠）
- SMF解析: `@tonejs/midi` を用い tempo 変化を反映し、各ノートの on/off をmsに展開。
- スケジューラ: ルックアヘッド窓で `setTimeout` を発行、順序は時刻昇順・同時刻は Off→On を優先。
- NoteOffポリシー: 互換性重視のため「Note On(status 0x90) + velocity 0」をNoteOffとして送出。
- 範囲切出し補完: start/stopでクリップ後にOnだけ残った場合、欠落Offを末尾近傍に合成しバランスを担保。
- 再生完了時の安全フラッシュ:
  - CC64(Sustain)=0 を全使用CHへ送出
  - 残留アクティブノートに Note On vel0 を送出
  - CC123(All Notes Off) を送出
  - 出力ポートをクローズ

## デバイス選択
- `portName` で部分一致。指定なし時は IAC/Network/Virtual を優先、それも無ければ index 0。
- 実使用名は `get_playback_status.portName` に反映。

## テスト（Vitest観点）
- 固定/可変テンポ: tick→ms、順序、総尺の妥当性
- クリップ時: 欠落Off合成の有無
- 停止: stop_playback での CC123/vel0 消音
- 互換性: NoteOffをvel0で送ること

## 非目標（本R6）
- 高精度オーディオ同期（必要なら将来AudioWorklet/Worker検討）
- MIDI 2.0 専用機能
