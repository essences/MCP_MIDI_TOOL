# 受信側セットアップ・チェックリスト（macOS）

- [ ] IACドライバ: オンラインにチェック
- [ ] IACポート名: 用途が分かる名前で作成（例: Logic->DP, バス 2）
- [ ] DAWでIAC入力: 有効化済み（設定画面）
- [ ] トラック入力: 対象IACポート or すべて
- [ ] トラックのモニタ/レコード有効: ON
- [ ] ソフト音源/外部音源: 正しく割当
- [ ] node-midi: 有効（`list_devices` で実デバイス列挙）
- [ ] `playback_midi`: durationMs=800以上、portNameにIACを指定
- [ ] メータ振れ・音出し確認
- [ ] うまくいかない場合: docs/setup/macos_coremidi_receiver.md のT/Sを参照
