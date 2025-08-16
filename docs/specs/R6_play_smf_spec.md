# R6: play_smf 仕様（TDDベース）

## ツール: play_smf
- パラメータ:
  - fileId (string, required): `store_midi` で保存したSMFのID
  - portName (string, optional): 出力ポート名の部分一致候補
  - startMs (number, optional): 再生開始位置ms（既定0）
  - stopMs (number, optional): 再生停止位置ms（既定: 曲末）
- 返り値:
  - ok: boolean
  - startedAt: number(ms)
  - scheduledEvents: number（スケジュールしたイベント数の概算）
  - warnings?: string[]（node-midi未利用など）

## 内部要件
- SMFを `@tonejs/midi` で解析し、テンポ変化を反映して各イベントの絶対時刻tMsを算出
- ルックアヘッド方式で node-midi Output にメッセージ送出
- stop_playback 呼び出しで: 予約タイマ解除、未消音ノートへNoteOff送出
- 例外・障害はツール応答にwarningsを付与（継続可能な範囲）

## テスト（Vitest想定）
- 固定テンポ: tick→ms変換、NoteOn/Off順序
- テンポ変化: SetTempoの反映（2テンポ切替）
- 停止: 中途停止時にNoteOffが送られる
- port選択: 部分一致が最も近いポートにマップされる

## 非目標（本R6）
- 高精度オーディオ同期（必要なら将来AudioWorklet/Worker検討）
- MIDI 2.0 専用機能
