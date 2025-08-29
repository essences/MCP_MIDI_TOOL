# MCP MIDI TOOL デモプロンプト

このプロンプトは、MCP MIDI TOOLの素晴らしい機能をデモンストレーションするためのものです。Claude DesktopやCursorなどのMCPクライアントで使用してください。

## 🎵 デモ1: Score DSL v1を使った楽曲作成

「C4, D4, E4, F4, G4の5音からなる4分音符のシンプルなメロディをScore DSL v1形式で作成し、SMFファイルに変換してください。テンポは120 BPMで、4/4拍子でお願いします。」

期待される動作：
- Score DSLを使って構造化された楽譜データを作成
- json_to_smfツールでSMF形式に変換
- ファイルメトリクス（bytes, trackCount, eventCount）を返却

## 🎹 デモ2: リアルタイム演奏とキャプチャ

「MIDI出力デバイスを確認してから、C4-E4-G4の和音を500msで演奏してください。その後、単発キャプチャを開始して、MIDI入力から和音を受け取ってみましょう。」

期待される動作：
- list_devicesで出力ポート一覧表示
- trigger_notesで和音の即時演奏
- start_single_captureでリアルタイム入力キャプチャ
- onsetWindow内での和音検出とresult返却

## 🎼 デモ3: SMF解析と再生

「既存のSMFファイルを読み込んで、dryRunで解析してから実際に再生してみてください。再生進捗も監視したいです。」

期待される動作：
- play_smfでdryRun解析（scheduledEvents, totalDurationMs表示）
- 実再生の開始
- get_playback_statusで進捗監視
- stop_playbackで停止と全ノート消音

## 🎛️ デモ4: 高度な編集機能

「2小節のメロディを作成してから、1小節目だけを抽出し、そこに自動的にクレッシェンド（Expression CC11）を適用して置換してください。」

期待される動作：
- Score DSL v1でautoCcPresetsを使用
- extract_barsで小節範囲抽出
- crescendo_to_expressionプリセットによる自動CC付与
- replace_barsで部分置換

## 🔄 デモ5: 継続的な演奏記録

「5分間の演奏記録セッションを開始して、idleTimeout 30秒、silenceTimeout 10秒で設定してください。記録中はステータスを確認し、最後にSMFファイルとして保存しましょう。」

期待される動作：
- start_continuous_recordingで長時間記録開始
- get_continuous_recording_statusでリアルタイム監視
- 3種類のタイムアウト制御
- 自動SMF生成と保存

## 📊 デモ6: JSONファーストワークフロー

「既存のSMFをJSON形式に変換してから、JSONを直接編集してピッチを1オクターブ上げて、再びSMFに戻してください。」

期待される動作：
- smf_to_jsonでSMF→JSON変換
- JSON内のpitch値を+12して1オクターブアップ
- json_to_smfでJSON→SMF変換
- 変換メトリクスの比較表示

## 🎯 使用のコツ

1. **format指定を推奨**: `json_to_smf`使用時は`format: "score_dsl_v1"`または`format: "json_midi_v1"`を明示
2. **dryRunから開始**: `play_smf`は最初に`dryRun: true`で解析してから実再生
3. **チャンネル表記に注意**: 外部指定は1-16、内部値は0-15
4. **エラーハンドリング**: 構造化エラー（ok:false, error.code, hint, issues）を活用
5. **メトリクス監視**: bytes, eventCount, totalDurationMsで負荷を事前把握

## 🔧 トラブルシューティング

- 音が出ない → 受信側のMIDI設定、チャンネル、音源割当を確認
- カクつく → schedulerLookaheadMs/schedulerTickMsを調整
- ハングノート → stop_playbackで全ノート消音

このツールの真の価値は、AIとの連携で構造化された楽譜データを効率的に作成・編集・再生できることです。ぜひ様々な音楽的アイデアを試してみてください！