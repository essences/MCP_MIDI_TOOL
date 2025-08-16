# ADR-0001: node-midi 採用によるクロスプラットフォーム化

日付: 2025-08-16

## 状況
- DAW受信確認済み。現状は単発ノート送出のみ。
- SMF再生（スケジューリング）を実装予定。

## 決定
- 実デバイスI/Oライブラリとして `node-midi`（RtMidiラッパー）を採用する。
- SMFパーサは `@tonejs/midi` を採用、自作のルックアヘッドスケジューラで再生。
- 対応OS: macOS(CoreMIDI)/Windows(MME)/Linux(ALSA)。

## 根拠
- node-midi はRtMidiベースで主要OSをカバーし、既存の list_devices/playback_midi と親和性が高い。
- @tonejs/midi はTSで扱いやすく、TDDで時間変換・テンポ変化対応を進めやすい。

## 影響
- ネイティブビルド環境が必要（CI設定と開発環境手順が増える）。
- 既存の playback_midi はnode-midi Outputへ統一。
- 追加タスク: Windows/Linuxの実機検証、CIで各OSのビルド/スモークテスト。

## 代替案
- JZZ + jzz-midi-smf: 実装短縮だが、Nodeでのハードウェア出力の確実性を要検証。

## 後続タスク
- ユニットテスト: tick→ms 変換、テンポ変化、停止時の全ノート消音。
- `play_smf` ツールの追加（fileId/portName/startMs/stopMs）。
- node-midi のoptional依存/動的importとフォールバック動作の整備。
