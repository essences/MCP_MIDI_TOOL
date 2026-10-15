# MIDI Tool

MIDIの作曲・読込・編集・再生・録音を行うローカルCLIです。Node.js 20以上が必要です。標準の実行経路と新しい配布スキルはMCP登録・サーバー・プロトコル・SDKを使用しません。

```sh
npm ci
npm run build
npm start -- --help
node scripts/midi.mjs compose --format score_dsl_v1 --input score.json --name song.mid --data-dir ./my-midi-data
node scripts/midi.mjs decode --file-id FILE_ID --data-dir ./my-midi-data
node scripts/midi.mjs play --file-id FILE_ID --dry-run --data-dir ./my-midi-data
```

返された`fileId`は次のコマンドでも使えます。保存先は`--data-dir`、`MIDI_TOOL_DATA_DIR`、インストール先の`data/`の順で決まり、固定の`manifest.json`でIDを管理します。標準出力はJSON、診断は標準エラーです。終了コードは成功0、操作失敗1、CLI入力エラー2です。`--input -`で標準入力、`--args-file FILE`で操作引数のJSONファイルを受け取ります。`run --operation NAME --args-file FILE`でも全操作を呼び出せます。

入力形式は[Score DSL](skills/midi-tool/references/score_dsl_v1.md)と[JSON MIDI](skills/midi-tool/references/json_midi_schema_v1.md)を参照してください。数値音高は`pitch`、音名は`note: "C4"`です。JSON MIDIのチャンネルは0〜15、外部操作の明示チャンネルは1〜16です。追記、小節抽出・置換、CC・サスティン挿入、清掃の引数は[操作一覧](skills/midi-tool/references/operations.md)にあります。同名の新規保存はエラーになり、`--overwrite`で既存IDを保って上書きします。編集前の原本を保管してください。

実再生は`doctor`と`devices list --direction output`で確認した実在ポートを指定します。

```sh
node scripts/midi.mjs doctor
node scripts/midi.mjs play --file-id FILE_ID --port 'Actual output' --data-dir ./my-midi-data
node scripts/midi.mjs notes --notes '["C4","E4","G4"]' --port 'Actual output'
```

通常の再生は完了まで待ち、`--background`は状態確認・停止用の`playbackId`を即時返します。テンポ変更、CC、プログラム変更、ピッチベンド、アフタータッチを共通の再生計画から送出します。仮想バスで音を出すには接続先の音源が必要です。`doctor`は列挙のみでMIDIを送出しません。

再生・キャプチャ・録音の継続状態は所有者限定のUnixソケットを使うローカルランタイムが保持します。同じデータ領域を指定して操作します。

```sh
node scripts/midi.mjs devices list --direction input
node scripts/midi.mjs record start --port 'Actual input' --data-dir ./my-midi-data
node scripts/midi.mjs record status --id RECORDING_ID --data-dir ./my-midi-data
node scripts/midi.mjs record stop --id RECORDING_ID --name take.mid --data-dir ./my-midi-data
node scripts/midi.mjs runtime status --data-dir ./my-midi-data
node scripts/midi.mjs runtime stop --data-dir ./my-midi-data
```

機器なしの和音入力テストは`capture start --source simulated`、`capture feed`、`capture status`を使います。録音は固定120 BPMでtickへ変換し、NoteOffまでの長さを保存します。開始時の`--name`はタイムアウトによる自動保存にも使います。録音の保存名が既存名と衝突すると、上書き指定がない場合は番号付き名へ変更します。同じ入力ポートを録音とデバイスキャプチャで同時に占有できません。通信タイムアウトは操作取消を意味しないため、再試行前に状態を確認してください。結果はデータ領域内に記録され、再起動後も確認できます。詳しくは[ワークフロー](skills/midi-tool/references/workflows.md)を参照してください。

`npm run package:skill`で[新スキル](skills/midi-tool/SKILL.md)を生成します。生成後にフォルダを任意の場所へコピーし、その中で`npm ci`を実行すれば単体利用できます。`node scripts/package_skill.mjs --output /path/to/copy`も使えます。配布物には実行コード・説明・依存ロックを含め、既存MIDI・manifest・node_modules・旧MCPコードを含めません。ソースは`src/`を編集し、`lib/`は再生成します。

実MIDIにはネイティブ`midi`依存のビルド環境が必要です。macOSではXcodeツールチェーンとライセンス承諾を確認してください。`npm ci --ignore-scripts`なら変換・編集・dry-run・疑似キャプチャを導入できますが、実MIDIにはネイティブ依存のビルドが必要です。

`npm test`と`npm run test:core`は新しいMCP非依存のエンジン・CLI・保存・移行・配布・コーデック・再生・録音テスト、および純粋なScore変換テストを実行します。`vitest.config.ts`で対象を明示しています。旧MCP通信・起動・レスポンス形式を検証するテストは履歴参照用に残し、標準テストから除外しています。旧テスト群の合格を主張するものではありません。`npm run smoke:e2e`はCLIの別プロセス間で作曲・読戻し・dry-run・疑似キャプチャ・停止を確認します。`npm run build`は生成物の`dist/`だけを消してから再ビルドします。

macOSの専用仮想ポートを使った実CoreMIDIの再生・録音同時実行は[検証記録](docs/reports/2026-10-15_native_loopback.md)で確認済みです。既存の機器・IAC・DAWポートは使っていません。物理鍵盤・外部音源・DAW接続・実際の発音品質、およびクリーン環境でのネイティブビルドは別途検証が必要です。

`src/directApi.ts`の既存公開関数も共通エンジンを呼び出します。互換変更として、汎用CC挿入は既存値を保持して開始・終了値を追記します。旧APIの汎用CC用`removeExisting`による削除は行いません。サスティン挿入は引き続き範囲内の既存CC64を既定で除去し、`removeExisting:false`で保持します。

既存データは自動移動しません。`migrate analyze/import`で元manifestを明示し、バックアップを保管してください。[旧スキル](skills/mcp-midi-tool/SKILL.md)のコード・依存・データはロールバック用のアーカイブとして保持し、新配布物には含めません。ユーザーのMCP登録設定は変更しません。

現時点の制限: 小節編集は最初の拍子を使用し、清掃はテンポ・拍子・調号の変化を縮約します。単発キャプチャは1和音単位です。重なるCC範囲は独立した開始・終了値として挿入するため、区間の和集合にはなりません。Windowsのローカル制御は未検証です。SIGKILLや電源断では未保存の録音を失う可能性があります。[移行計画](docs/plans/mcp_free_skill_migration_plan.md)も参照してください。
