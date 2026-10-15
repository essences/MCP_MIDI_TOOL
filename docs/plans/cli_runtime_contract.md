# CLI・ランタイム実装契約（2026-10-15）

本契約は初回実装用。MCP非依存の操作入口を提供し、既存の業務操作名を内部識別子として保持する。

## コードの境界

- `src/engine.ts`: `createMidiEngine(options?)` → `call(name,args)`, `dispose()`, `getActivity()`。
- `src/cli/main.ts`: CLI入口。`src/cli/commands.ts`: 引数と内部操作の対応。
- `src/local/runtime.ts`: 常駐プロセス入口。`src/local/client.ts`: ローカル接続と必要時の起動。
- ソース間でMCP SDKをimportしない。エンジンをMCP応答で包まない。
- リポジトリのpackage設定、配布スクリプトは統合段階で変更する。

## 保存設定

- CLIの`--data-dir` > `MIDI_TOOL_DATA_DIR` > 実行コードの設置先ルートの`data/`。
- `MIDI_TOOL_DATA_DIR`はdata領域そのもの。旧ベースディレクトリと混同しない。
- CLI/daemon子プロセスは固定`manifest.json`を使う。旧MCP環境変数は新CLIの明示設定より優先させない。
- data-dirから一意の短いUnix socketパスを計算し、所有者限定のディレクトリに置く。

## コマンドの対応

| CLI | 業務操作 |
|---|---|
| compose | json_to_smf |
| decode | smf_to_json |
| import | store_midi（--inputのバイナリをbase64変換） |
| inspect | get_midi |
| list / find / export / clean | list_midi / find_midi / export_midi / clean_midi |
| append / bars extract / bars replace | append_to_smf / extract_bars / replace_bars |
| cc insert / sustain insert | insert_cc / insert_sustain |
| devices list --direction input\|output | list_input_devices / list_devices |
| play / playback status / playback stop | play_smf / get_playback_status / stop_playback |
| notes | trigger_notes |
| playback-poc | playback_midi |
| capture start --source simulated\|device / feed / status | start_single_capture / start_device_single_capture / feed_single_capture / get_single_capture_status |
| record start / status / stop / list | start_continuous_recording / get_continuous_recording_status / stop_continuous_recording / list_continuous_recordings |
| runtime status / stop | ローカルランタイムの管理 |
| run --operation NAME --args-file FILE | 全業務操作を直接指定する汎用入口 |
| doctor | Node・データ領域・実MIDIロード／列挙の診断 |

`--args-file`は操作引数全体、`--input`は曲のJSON（compose/append/bars replace）、SMF（import）、その他の操作では引数JSONとして扱う。`-`は標準入力。JSONの解析失敗と未知オプションは入力エラー。kebab-caseオプションを既存のcamelCase引数へ対応させ、数値／真偽値／配列は型に応じて厳密に解析する。便利なフラグで表せない引数もargs-fileで渡せる。

## 応答と状態

- stdoutは1つのJSON結果、ログはstderr。`--help`だけは説明文を許可。
- 成功はexit 0、業務エラーはexit 1、CLI入力エラーはexit 2。
- play/notesは既定で完了待機、`--background`で開始IDを返す。dry-runは直接実行し、daemonを作らない。
- capture/recordのstartとstatus/stop/listは同じdaemonへ接続する。simulated captureも別CLIからfeed可能。
- getActivityが0の状態が継続するとdaemonは自動終了。稼働中セッションは終了させない。
- runtime status/stopとID指定の状態確認・停止はdaemonがいなければNOT_RUNNING。勝手に起動しない。
- daemon停止時はengine.dispose()をawaitし、結果の保存とポート解放後に応答・終了する。
- 接続中断で処理を自動再送しない。重複保存や録音開始を起こさない。

## ローカル制御

- Unix domain socket、JSON 1行。`{version:1,id,operation,args}`に`{version:1,id,result}`または構造化エラーを応答する。
- 起動ロック、実プロセス疎通、明示バージョン照合、接続・要求の期限、サイズ上限を設ける。
- 二重起動時は既存ランタイムへ接続し、他プロセスのsocketを安易にunlinkしない。
- CLI要求はdaemon内部で順番にdispatchする。タイマーとMIDI入力は非同期に進行する。
- socketパス、PID、ログの管理情報をユーザーのdata領域とは分離してよい。PIDだけで停止対象を判断しない。
- SIGINT/SIGTERMとruntime stopは共通の終了処理を呼ぶ。SIGKILLでの未保存データ復元は保証しない。

## 初回の検証条件

1. 一時data-dirでcompose→別CLI inspect/decode→play dry-runが成立する。
2. 別CLIのcapture start simulated→feed→statusが同じcaptureIdを解決する。
3. runtime status→stopで確実に終了し、同じdata-dirで再起動できる。
4. daemonなしのstatusはNOT_RUNNING。未知コマンドと不正JSONは非0で終了する。
5. すべてのテストは一時領域を使い、実デバイスへ発音しない。
