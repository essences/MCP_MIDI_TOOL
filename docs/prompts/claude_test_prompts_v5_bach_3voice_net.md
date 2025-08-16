# Claude テスト用プロンプト v5（ネットDL: バッハ3声インベンション → 保存 → dryRun → 再生 → 停止）

目的: パブリックドメインの安全な出典から「3声のインベンション（= Sinfonia, BWV 787–801）」のMIDIをダウンロードし、mcp-midi-toolで再生・停止を一連で検証します。
前提: 受信側(IAC/仮想MIDI/DAW)が鳴るように設定済み。Claude Desktopで本MCPサーバが登録済み。
注意: かならずパブリックドメイン/適切なライセンスのMIDIを使用してください（例: Mutopia Project, Wikimedia Commons）。商用配布サイトやライセンス不明のMIDIは使用しないこと。

参考（候補URL・いずれもPD/フリーのはず。無効な場合は同等のPDソースを選択）:
- Mutopia Project（Bach Sinfonias のMIDI）
  - https://www.mutopiaproject.org/ （作品ページからダウンロード）
  - 例: BWV 789 などのSinfoniaページにある `.mid` リンク
- Wikimedia Commons（"BWV 789 midi" 等で該当ファイルを検索）
  - https://commons.wikimedia.org/

---

## A. 最短ワンショット（1プロンプトで実行）
以下をそのままClaudeに貼り付けてください。

```
次の手順を厳密に順番で実行し、各ステップの結果(JSON/ログ)をそのまま表示してください。

0) 変数の設定（編集可）
   - MIDI_URL: パブリックドメインの3声インベンション（Sinfonia, BWV 787–801）のMIDI直リンク
     例: https://example.org/path/to/Bach_Sinfonia_BWV789.mid

1) code-interpreter で MIDI をダウンロード
   - HTTP GET: MIDI_URL
   - Content-Type/サイズを確認（>1KB 目安）。SHA-256とバイト長を表示
   - base64へエンコードし BASE64 を得る

2) mcp-midi-tool: store_midi
   - 入力: { name: "bach_sinfonia.mid"（URLからファイル名が取れればそれを使用）, base64: BASE64 }
   - 出力の id を FILE_ID として記憶

3) mcp-midi-tool: play_smf (dryRun)
   - 入力: { fileId: FILE_ID, dryRun: true }
   - 出力: scheduledEvents と totalDurationMs を表示（scheduledEvents>0 を確認）

4) mcp-midi-tool: list_devices
   - 出力から IAC/Network/Virtual を含む name を1つ選び DEV_NAME として記憶（なければ空でOK）

5) mcp-midi-tool: play_smf（実再生）
   - 入力例: { fileId: FILE_ID, portName: DEV_NAME, schedulerLookaheadMs: 200, schedulerTickMs: 20 }
   - 出力の playbackId を PB_ID として記憶

6) 5〜10秒後、mcp-midi-tool: get_playback_status
   - 入力: { playbackId: PB_ID }
   - 出力: cursor/lastSentAt/totalDurationMs/done/activeNotes を表示（cursor が進行し、done=false であることが望ましい）

7) mcp-midi-tool: stop_playback
   - 入力: { playbackId: PB_ID }
   - 出力: ok を確認

補足:
- portName 省略可（IAC/Network/Virtual優先で自動選択）。
- 音が出ない場合は受信側のトラック入力/モニタ/音源割当/チャンネル(通常ch1=0)を確認。
- ライセンスはPD/フリーを厳守（Mutopia, Wikimedia等）。
```

---

## B. 段階プロンプト（分割手順）
- URL選定: 「PDソース(Mutopia/Wikimedia)から3声インベンション(Sinfonia BWV 787–801)のMIDI直リンクを1つ選び MIDI_URL として宣言。URLとライセンス根拠を併記」
- 取得: 「code-interpreter で HTTP GETし、SHA-256/サイズ/Content-Typeを表示。base64を BASE64 として提示」
- 保存: 「store_midi { name, base64: BASE64 } の JSON を表示。id を FILE_ID に記憶」
- dryRun: 「play_smf { fileId: FILE_ID, dryRun:true } の JSON を表示。scheduledEvents/totalDurationMs を確認」
- デバイス: 「list_devices の JSON を表示。IAC/Network/Virtual を含む name を DEV_NAME として記憶」
- 実再生: 「play_smf { fileId: FILE_ID, portName: DEV_NAME, schedulerLookaheadMs:200, schedulerTickMs:20 } の JSON を表示。playbackId を PB_ID に記憶」
- 進捗確認: 「get_playback_status { playbackId: PB_ID } の JSON を表示」
- 停止: 「stop_playback { playbackId: PB_ID } の JSON を表示」

---

## C. トラブルシューティング
- ダウンロードできない/404 → PDソースでURLを変更（Mutopiaの作品ページから`.mid`リンク、Wikimediaの検索）
- totalDurationMs が極端に短い/0 → 別のMIDIを選択（壊れ/別形式の可能性）。dryRunの scheduledEvents を確認
- 再生がすぐ止まる → get_playback_status の cursor/lastSentAt/done を確認し、schedulerLookaheadMs/TickMs を上げて再試行
- デバイスが見つからない → IAC有効化や別ポート名での部分一致を試す（portName省略も可）
- 著作権/ライセンス → バッハ作品自体はPDですが、MIDI打ち込みは著作権がある場合があります。Mutopia/Wikimedia等のPD/自由ライセンスを優先使用
