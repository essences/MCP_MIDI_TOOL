# Claude テスト用プロンプト v4（8秒継続SMF: 生成→dryRun→実再生→停止）

目的: 連続音が8秒続く正しいSMFをその場で生成し、mcp-midi-toolで再生と停止を検証します。
前提: 受信側(IAC/仮想MIDI/DAW)が鳴るように設定済み。
参照: 生成コードは `docs/snippets/continuous_chords_smf_8s.md`

---

## A. 最短ワンショット（1プロンプトで実行）
以下をそのままClaudeに貼り付けてください。

```
次の手順を厳密に順番で実行し、各ステップの結果(JSON/ログ)をそのまま表示してください。

1) code-interpreter で 8秒継続SMF(base64)を生成
   - `docs/snippets/continuous_chords_smf_8s.md` と同等のコードを実行し、出力 base64 を得る

2) mcp-midi-tool: store_midi
   - 入力: { name: "continuous_8s.mid", base64 }
   - 出力の id を FILE_ID として記憶

3) mcp-midi-tool: play_smf (dryRun)
   - 入力: { fileId: FILE_ID, dryRun: true }
   - 出力: scheduledEvents と totalDurationMs を表示（totalDurationMs ≈ 8000 を確認）

4) mcp-midi-tool: list_devices
   - 出力から IAC/Network/Virtual を含む name を1つ選び DEV_NAME として記憶（なければ空でOK）

5) mcp-midi-tool: play_smf（実再生）
   - 入力例: { fileId: FILE_ID, portName: DEV_NAME }
   - 出力の playbackId を PB_ID として記憶

6) 5〜8秒後、mcp-midi-tool: get_playback_status
   - 入力: { playbackId: PB_ID }
   - 出力: cursor/lastSentAt/totalDurationMs/done/activeNotes を表示（cursor が進行し、done=false であることが望ましい）

7) mcp-midi-tool: stop_playback
   - 入力: { playbackId: PB_ID }
   - 出力: ok を確認

補足:
- portName 省略可（IAC/Network/Virtual優先で自動選択）。
- 音が出ない場合は受信側のトラック入力/モニタ/音源割当/チャンネル(通常ch1=0)を確認。
```

---

## B. 段階プロンプト（分割手順）
- 生成: 「code-interpreter で `docs/snippets/continuous_chords_smf_8s.md` のコードを実行し、base64を提示」
- 保存: 「store_midi { name:"continuous_8s.mid", base64 } の JSON を表示。id を FILE_ID に記憶」
- dryRun: 「play_smf { fileId: FILE_ID, dryRun:true } の JSON を表示。scheduledEvents/totalDurationMs を確認」
- デバイス: 「list_devices の JSON を表示。IAC/Network/Virtual を含む name を DEV_NAME として記憶」
- 実再生: 「play_smf { fileId: FILE_ID, portName: DEV_NAME } の JSON を表示。playbackId を PB_ID に記憶」
- 進捗確認: 「get_playback_status { playbackId: PB_ID } の JSON を表示」
- 停止: 「stop_playback { playbackId: PB_ID } の JSON を表示」

---

## C. トラブルシューティング
- totalDurationMs が 8000 に近くない → 生成コードのMTrk長/イベント並びを再確認
- 再生がすぐ止まる → get_playback_status の cursor/lastSentAt/done を確認（送出側/受信側どちらの問題か切り分け）
- デバイスが見つからない → IAC有効化や別ポート名での部分一致を試す（portName省略も可）
