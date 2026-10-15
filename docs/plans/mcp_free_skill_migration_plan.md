# MCPを使わないMIDIスキルへの移行計画

作成日: 2026-10-15（日本時間）  
状態: MCP非依存の標準CLI・新スキル実装と検証完了（2026-10-15、v0.2.0）。既存データの実運用切替は未実施。  
対象: MCP MIDI TOOLと`skills/mcp-midi-tool/`

## 1. 目的と完了条件

既存の作曲・編集・再生・録音機能を、MCPの登録、MCP SDK、MCPサーバー、MCPプロトコルに依存せず利用できるスキルにする。AIはスキルの説明を読み、通常のローカルコマンドを実行する。

本計画は既存機能を維持することを前提にする。移行先の名称は`midi-tool`を提案する。既存MCP版は比較検証用に移行期間中だけ維持し、最終的にリポジトリの標準実行経路もMCP非依存へ切り替える。

完了条件:

- スキル単体を別フォルダへコピーし、依存関係を導入すれば利用できる。
- 配布物の実行コードと依存関係に`@modelcontextprotocol/sdk`が存在しない。
- `initialize`、`tools/call`、`tools/list`、MCPの`content`ラッピングを実行経路から除去する。
- 既存のファイル操作、編集、再生、単発キャプチャ、継続録音に相当する操作を提供する。
- 別々のCLI実行から再生・録音の開始、状態確認、停止ができる。
- 既存MIDIと採用したマニフェストを、fileIdを保って移行できる。
- 実機がない環境では変換・編集・dry-runを実行でき、実機操作は明確な利用不可エラーを返す。
- フェーズごとの自動検証に加え、macOSの実MIDI入出力で再生・録音を確認する。

2026-10-15に実装開始の指示を受領。以下の体制で実装・検証を進める。既存データの移動と外部クライアントのMCP登録解除は、実装とは分離して扱う。

## 実行体制・並行実行方針（2026-10-15追記）

[agent-team-orchestrator](../../.codex/skills/agent-team-orchestrator/SKILL.md)の書き込み境界、実装と品質判断の分離、サイクルごとの記録を採用する。ユーザー指定により、オーケストレーターが計画・設計・指示・レビュー・最終判定を兼任し、作業エージェントは`gpt-6.1-sol`、`reasoning_effort: low`で実行する。

| 責任領域 | オーケストレーター | 作業エージェント |
|---|---|---|
| 計画、契約、優先順位、作業境界 | R/A | C |
| 実装、担当範囲の検証、実行報告 | A | R |
| コードレビュー、追加検証、採用／差戻し | R/A | C |
| 進捗と判断の記録、次サイクルの指示 | R/A | C |

- 同時稼働は原則2〜3作業エージェントまで。同一ファイルや共通設定を並行編集しない。
- 独立モジュールの実装と、読み取り専用の調査・基準整理を並行する。API契約の確定後に呼出側を実装する。
- 各依頼に目的、許可ファイル、禁止範囲、成功条件、必須検証、記録先を明示する。実装者自身の合格報告だけで採用しない。
- 実装者は無断で範囲を拡大せず、問題は根拠と選択肢を添えて返す。設計が必要な再作業はオーケストレーターが判断する。
- 全履歴を渡さず、計画・契約・担当ファイルへの参照を渡す。小さすぎるタスク分割や重複した全テスト実行は避ける。
- 担当テストは作業エージェント、統合ビルドと横断検証はオーケストレーターが調整する。実機テストは環境条件を明記する。
- コミット、既存データ削除、外部アプリ設定変更は作業エージェントの担当外。既存の未コミットファイルを保持する。
- 各サイクルの判定は`pass / pass_with_notes / rework`で記録し、次の依存作業を解放する。
- 使用量と手戻りを見て分割粒度を調整する。推論を軽くしても総コスト削減や同等品質が自動的に保証されるとは扱わない。

実行状況、レビュー結果、残件は[実行記録](mcp_free_skill_execution_log.md)に記録する。

## 実装結果と計画からの調整（2026-10-15）

- 新スキルは`skills/midi-tool/`。標準の`npm start`、`npm run dev`もMCPを起動せず、通常CLIを実行する。
- 主エージェントが設計・指示・レビュー・統合検証を担当し、3体の作業エージェントをすべてGPT-6.1 Sol／lowで運用した。同一ファイルの編集を分離し、担当完了後に所有範囲を次のタスクへ移した。
- コードは`engine.ts`を共通入口に抽出し、保存・移行・コーデック・再生計画・スケジューラ・CLI・ローカル制御・永続状態・ワークフローを別モジュールにした。旧処理を全面的に書き換えないため、core/servicesへの全ファイル再配置は見送り、エンジン内の編集処理は今後の整理候補とした。
- SMF解析は`midi-file`へ変更し、曲途中のprogram変更によるノート欠落、ピッチベンド中央値、aftertouch、負オクターブの往復変換を修正した。`@tonejs/midi`とMCP SDKは標準実行・新配布物の依存から除去した。
- 新配布物の依存は`midi`、`midi-file`、`zod`のみ。配布コード18モジュールはビルド結果から生成し、既存録音やmanifestを収録しない。
- 旧スキルは移行案内に変更し、旧コード・依存・データをロールバック用アーカイブとして保持した。旧MCP設定例や履歴資料も現行の実行経路には含まれない。ユーザーのMCP登録や既存データは変更していない。
- 旧通信形式のテストを標準対象から明示的に外し、現在のAPI／CLI／配布物／状態継続を検証する回帰テストへ置き換えた。最終標準テストは19ファイル73件が合格。旧テスト群全体の合格を意味しない。
- 別フォルダにコピーした新配布物は、新規の`npm ci --ignore-scripts`後、元リポジトリへのリンクなしで作曲・読戻し・dry-run・別CLIキャプチャ・終了後の結果参照に合格した。
- macOSの既存native環境では、私有仮想ポートによる実CoreMIDI送受信、同時再生録音、CLIの`play-record`と時間指定`record`を確認した。新規nativeビルドはホストのXcodeライセンス未承諾で失敗しており、OS設定は変更していない。

受入判定は`pass_with_notes`。MCP非依存スキルとして利用可能。物理鍵盤・DAW・発音品質、Windows制御、新規nativeビルド、利用者の既存データ切替は未検証／未実施として明記し、機能実装の成功と混同しない。

## 2. 現状と設計上の課題

| 対象 | 確認できた状況 | 移行時の対応 |
|---|---|---|
| `src/index.ts` | 約2,934行。MCP通信と業務処理、再生・録音状態が混在 | 業務処理、状態管理、実行入口を分離 |
| `src/directApi.ts` | 生成、読込、CC挿入、書出、簡易解析を直接実行可能 | 一部を再利用し、サーバー側との仕様差を統合 |
| `skills/mcp-midi-tool/lib/index.js` | 現在ビルドしたサーバー本体と同一 | 配布からMCP入口を除去 |
| `lib/localToolClient.mjs` | 子プロセスとMCP形式のJSON-RPCで通信 | MCPを使わないCLIとローカル制御へ置換 |
| `storage` | 本体は既定でPID別manifest、スキルは固定manifest | 保存方針を一本化し、データを明示移行 |
| 再生・キャプチャ・録音 | `globalThis`上のMap、タイマー、MIDIポートを使用 | ランタイムインスタンスが所有 |
| 録音の定期清掃 | リクエスト処理内でintervalとexitリスナーを登録する構造 | ランタイム起動時に一度だけ登録 |
| テスト | 純粋変換テストとMCP起動前提の統合テストが混在 | 業務API、CLI、状態継続のテストへ移行 |

既存の軽量APIだけをスキルの入口にすると、追記・小節編集・録音などの機能が不足する。軽量APIの`analyzeSmfDryRun`は冒頭のテンポで総時間を計算し、直接再生サンプルも固定テンポによる時間変換を行う。これを全機能の代替として採用すると途中テンポ変更などで退行するため、再生用イベント生成と時間計算を共通化する。

READMEとBACKLOGには実装済み処理を未実装とする記述もある。移行の仕様はコード、実行結果、回帰テストを突き合わせて確定する。既存テストにも、準備未完了でreturnするものや自動保存の実ファイルを検証しないものがあり、合格数だけで録音品質を判定しない。

## 3. 方式の比較と採用案

| 方式 | 長所 | 制約 | 判断 |
|---|---|---|---|
| 毎回完結するCLIのみ | 構成が小さく、ファイル操作に適する | 別コマンドから進行中の録音を制御できない | ファイル操作に採用 |
| 一つの長時間スクリプトで全操作 | 再生と録音を同時実行できる | 後から任意の状態確認・停止を行いにくい | 専用ワークフローに採用 |
| CLI＋ローカル常駐ランタイム | 別コマンドから状態を継続でき、既存機能を維持 | 起動・停止・異常終了の設計が必要 | 再生・録音の制御に採用 |

推奨は「共通業務API＋CLI＋必要時だけ起動するローカル常駐ランタイム」。この常駐プロセスはMCPサーバーではなく、MIDIポートとセッションを保持するためのローカル実行プロセスである。

常駐処理を一切使わない運用も、完結型の再生／録音／同時実行コマンドで提供する。ただし「録音開始コマンドの終了後、別コマンドから録音を停止する」操作には、どこかに生存するプロセスが必要になる。この機能維持を優先する設計とする。

## 4. 移行後の構成

```text
AI → SKILL.md → scripts/midi.mjs（通常のCLI）
                         ├─ ファイル処理 → 共通業務API
                         └─ セッション処理 → ローカル制御接続
                                               ↓
                                      常駐ランタイム → 共通業務API
                                               ↓
                                          MIDI入出力
```

提案するソース構成:

```text
src/
  core/          # スキーマ、Score変換、SMF変換、清掃、小節計算、時間変換
  services/      # 保存、検索、追記、小節編集、CC編集、再生イベント構築
  runtime/       # MIDIアダプター、再生・録音・キャプチャ、終了処理
  cli/           # 引数解析、コマンド定義、JSON応答
  local/         # 常駐起動、ローカル接続、状態制御
scripts/
  package_skill.mjs
skills/midi-tool/
  SKILL.md
  package.json
  scripts/midi.mjs
  lib/           # ビルドから自動生成する実行コード
  references/    # JSON MIDI、Score DSL、作曲・録音手順
```

ソースは`src/`を唯一の保守対象とし、スキルの`lib/`を手編集しない。配布スクリプトで実行入口、依存関係、必要な仕様書を生成・コピーし、旧MCPファイルが残らないよう空の出力先から組み立てる。

## 5. CLIと業務APIの契約

以下のコマンドは設計案であり、現時点では未実装。

```bash
node scripts/midi.mjs compose --format score_dsl_v1 --input score.json --name song.mid
node scripts/midi.mjs inspect --file-id <id>
node scripts/midi.mjs play --file-id <id> --dry-run
node scripts/midi.mjs play --file-id <id> --port "IACドライバ バス1" --background
node scripts/midi.mjs playback status --id <playback-id>
node scripts/midi.mjs playback stop --id <playback-id>
node scripts/midi.mjs record start --port "入力ポート名"
node scripts/midi.mjs record status --id <recording-id>
node scripts/midi.mjs record stop --id <recording-id> --name take.mid
node scripts/midi.mjs runtime status
node scripts/midi.mjs runtime stop
```

- 共通業務APIは引数を型・スキーマで検証し、通信形式から独立したデータを返す。
- CLIの標準出力は機械可読JSON。ログは標準エラーへ出す。成功は終了コード0、失敗は非0。
- 応答は`{ok:true,...}`または`{ok:false,error:{code,message,details?}}`。既存のfileId、playbackId、recordingId、captureIdは対応を維持する。
- 大きな曲データは`--input`ファイルまたは標準入力から渡す。巨大JSONをシェル文字列へ埋め込まない。
- `--help`とローカルのコマンド定義で操作を確認できる。MCPの探索APIは不要。
- 通常の`play`は終了まで待機し、`--background`時だけ継続制御用のIDを即時返す。録音はstart/status/stopと完結型recordを提供する。
- 外部チャンネルは1〜16、内部JSON MIDIは0〜15を維持。formatは明示指定を基本とする。
- テンポマップ、小節境界、イベント順序、範囲開始時のCC／ピッチベンド状態は、dry-runと実再生で同じ実装を使う。
- 現行の同名保存やoverwrite引数には経路差があるため、Phase 1で実挙動を固定する。新CLIは同名衝突時に明示エラーを返し、上書きは`--overwrite`で指定する方針とし、互換変更を記載する。

## 6. 機能の移行対応

| 現行操作 | 新CLIの操作群 | 実行場所 |
|---|---|---|
| store_midi / get_midi / list_midi / find_midi / export_midi | import / inspect / list / find / export | 直接実行 |
| json_to_smf / smf_to_json / clean_midi | compose / decode / clean | 直接実行 |
| append_to_smf / extract_bars / replace_bars | append / bars extract / bars replace | 直接実行 |
| insert_cc / insert_sustain | cc insert / sustain insert | 直接実行 |
| list_devices / list_input_devices | devices list --direction output\|input | MIDIアダプター経由 |
| play_smf / get_playback_status / stop_playback | play / playback status / playback stop | dry-runは直接、実再生はランタイム |
| trigger_notes | notes | ランタイム、終了待機も可能 |
| playback_midi | playback-poc（暫定） | 現行は単音PoCのため、SMF再生と混同せず移行後に廃止検討 |
| start_single_capture / feed_single_capture / get_single_capture_status | capture start --source simulated / capture feed / capture status | ランタイム。feedはテスト・擬似入力用 |
| start_device_single_capture | capture start --source device | ランタイム |
| start/get/stop/list_continuous_recording(s) | record start / status / stop / list | ランタイム |
| play_and_record_together.mjs | play-record | 同一ランタイム内で調整 |

MCPのpromptsは必要な演奏・記法ガイドを`references/`へ移す。resources/listの空応答、MCP初期化、MCP ready通知は移行しない。運用上必要な診断情報は`doctor`と`runtime status`で提供する。

## 7. 状態管理と終了処理

- macOSを初期検証対象とし、ローカル制御はUnixドメインソケットを使う。Windowsの名前付きパイプ対応は別途検証する。TCP待受は初期実装に含めない。
- 接続内容はバージョン、要求ID、操作名、引数と応答を持つ小さな専用JSON形式にする。MCPやJSON-RPCの互換層は作らない。
- ユーザーとデータディレクトリごとにランタイムを一つ起動する。短いソケットパス、所有者限定の権限、起動ロック、疎通確認で多重起動と残骸を処理する。
- CLIとランタイムの版が異なる場合は明確にエラーを返す。起動、要求、停止には期限を設ける。
- status/stopはランタイムがなければNOT_RUNNING等を返す。ID操作で無意味な新規ランタイムを起動しない。
- `globalThis`を廃止し、再生・録音・キャプチャのレジストリをRuntimeContextへ集約する。清掃タイマーは一度だけ作成し、disposeで解除する。
- 停止と完了処理は冪等にする。タイムアウトと手動停止が競合しても、録音保存とfileId発行を一度だけ実行する。
- MIDIポートの共有／競合規則を定め、同時利用可能なセッションだけ開始する。再生と録音の同時実行を実機で検証する。
- 明示停止、SIGINT、SIGTERM時は、再生中のNoteOffとサスティン解除、タイマー破棄、可能な録音保存、ポート閉鎖を行う。非同期保存はexitイベントに任せない。
- 稼働セッションがなく一定時間経過したら自動終了する。録音や再生が進行中なら自動終了しない。
- SIGKILLや電源断後に演奏や入力ポートを復元することは保証しない。保存済み結果は残し、残存セッション情報はinterruptedとして扱う。録音中データの継続ジャーナルは初期範囲外。
- ステータスと結果のスナップショットは原子的に保存し、CLIの終了とセッションの終了を区別する。録音完了結果には保存成功／失敗も記録する。

## 8. データ保存と移行

保存先は明示的な`--data-dir`、次に`MIDI_TOOL_DATA_DIR`、未指定ならスキル内の`data/`とする。現行のベースディレクトリとdataディレクトリは意味が違うため、旧環境変数を単純に読み替えない。

新規保存の標準は固定の`manifest.json`。MIDI、書出、セッション記録、ロックを同じデータ領域内で管理する。直接CLIと常駐ランタイムの双方が保存するため、プロセス間ロックでread-modify-write全体を保護し、一時ファイルとrenameでマニフェストを更新する。MIDI実体は登録前に書き終え、失敗時の孤立ファイルを検出可能にする。

移行手順:

1. 稼働中の旧再生・録音を終了し、採用するデータ領域をバックアップする。
2. `manifest.json`と`manifest.*.json`を列挙し、参照先の存在、重複ID、同名別内容、絶対／相対パスを診断する。未登録MIDIも一覧化する。
3. dry-runで対象件数、競合、欠損、移行先を報告する。異なる内容が同じIDを持つ場合は自動統合しない。
4. 明示選択されたデータをコピーし、IDを保ちながら移行先に対する相対パスへ変換する。同一実体の重複登録は勝手に消さず報告する。
5. 件数、ファイルサイズ、内容ハッシュ、読込可能性、fileId解決を照合する。
6. スキルの保存先を切り替える。元データと移行レポートはロールバック用に保持する。

生成データ、過去の録音、既存manifest、ネイティブnode_modulesをスキルの配布物へ混入させない。配布先での依存導入を再現できるロックファイルを用意する。

## 9. 実装プロセスと各段階の成果物

| 段階 | 作業 | 成果物・終了条件 | 依存 |
|---|---|---|---|
| Phase 1: 現状固定 | 全操作の入出力と副作用を棚卸し。既存テストを実行し、機器依存・スキップ・既存不具合を区別 | 機能対応表、比較用入力と期待結果、既知制約 | なし |
| Phase 2: 業務処理抽出 | core/services/runtimeを抽出。旧MCP入口は薄いアダプターへ変更 | 共通API、RuntimeContext、共有イベント生成。新APIからMCPをimportしない | 1 |
| Phase 3: 保存と単発CLI | 保存設定統一、プロセス間ロック、移行dry-run、ファイル操作コマンド | 作曲→読込→編集→書出がCLIだけで完結。別CLI間でfileIdが有効 | 2 |
| Phase 4: 継続実行 | 常駐起動、ソケット接続、再生・キャプチャ・録音、終了処理 | 別CLIの開始→状態→停止が成功。自動保存と同時実行を確認 | 2・3 |
| Phase 5: スキル配布 | 新SKILL.md、汎用CLI、参照資料、配布スクリプト、依存ロック | 空の場所へコピーしたスキル単体で全経路が動く | 3・4 |
| Phase 6: 切替と撤去 | 統合テスト移行、実データ移行、MCPファイル・SDK削除、標準npmスクリプト更新 | MCPのない状態で検証合格。手順とバックアップから復旧可能 | 5 |

Phase 2での優先順序は、変換・保存、編集、デバイス診断、再生、単発キャプチャ、継続録音。既存の計算やイベント順序をまず抽出し、挙動改善は仕様差がある箇所に絞る。途中で軽量APIとフルAPIを別々に増改築しない。

Phase 5ではスキル本体を短く保ち、入力形式、コマンド選択、状態IDの扱い、保存先、検証方法を記載する。詳細なJSON例と録音手順はreferencesへ分ける。標準のnpm start/dev/build/testも新CLI中心に整理する。

旧`src/index.ts`、`index_old.ts`、`index_new.ts`、スキル内の旧入口とlocalToolClient、旧MCPスクリプト／設定例は、比較検証後に削除または履歴参照へ置き換える。旧スキルフォルダの廃止はデータ移行と配布検証の完了後に行う。

## 10. 検証計画

| 検証層 | 重要な検証内容 |
|---|---|
| 共通API | Score DSL、JSON検証、調号／拍子／CC／PBの往復変換、同tick順序、CC64境界、追記・小節置換 |
| 時間と範囲 | 複数テンポ、拍子変更、跨ぎノート、開始時の状態復元についてdry-runと送出予定を比較 |
| CLI | JSON出力、非0終了コード、入力ファイル／標準入力、cwd非依存、別プロセス間のfileId継続 |
| 保存 | CLIとランタイムの並行保存、同名衝突、ロック競合、破損manifest、移行競合の報告 |
| ランタイム | 二重起動、版不一致、期限切れ、停止の再実行、同時セッション、SIGTERM、異常終了後の診断 |
| 録音 | idle／silence／maxタイムアウト、手動停止との競合、実SMF作成、fileId登録、読戻し、保存失敗 |
| 配布 | 新規フォルダ、空データ、固定依存導入、MCP SDKなしでビルド・CLI・スキル動作 |
| 実機 | macOSのMIDI列挙、IAC送出、鍵盤入力、再生停止、サスティン解除、再生と録音の同時実行 |

機器なしテストには注入可能なMIDIアダプターと時計を使い、イベント内容と状態遷移を確認する。ハードウェア不足は明示的なskipとして集計し、実機合格とは区別する。実機が必要な合格条件は実行証跡が得られるまで未完了とする。

MCP除去は依存ツリー、配布内容、import、実行プロセスを確認して判定する。履歴説明にMCPという文字があることだけで不合格にはしない。

## 11. 見積もりと主要リスク

以下は現在のコード確認に基づく計画上の概算。1人で実装・検証し、実機を使用できる前提で、Phase 1が0.5〜1日、Phase 2が2〜4日、Phase 3が1〜2日、Phase 4が3〜5日、Phase 5が1〜2日、Phase 6が1〜2日。合計8.5〜16作業日を目安とし、Phase 1の結果で再見積もりする。

| リスク | 対応 |
|---|---|
| 大きなMCPハンドラーからの抽出で挙動が変わる | 同じ入力に対する旧アダプターと新APIの結果を比較。ID・日時を除き意味的に照合 |
| 再生・録音終了の競合やポートリーク | 状態機械と一度だけの確定処理、dispose、停止系のテスト |
| manifest統合でIDや参照が失われる | 先に診断とdry-run、競合時停止、コピー移行、ハッシュ照合 |
| 配布物に旧MCP依存が残る | 空の出力先へ配布生成し、依存検査とクリーン環境テスト |
| node-midiの導入・ABI差 | 実行環境で検証し、doctorでネイティブロード原因を表示。ファイル操作から遅延ロードを分離 |
| 切替後に実機退行が見つかる | 移行前のGitリビジョンとデータのバックアップへ戻す。新旧から同じデータを同時更新しない |

## 12. 範囲外と次の着手点

移行の初期範囲に、Web UI、クラウド同期、音声合成エンジン、音声ファイル録音、transpose／quantize／humanizeの新機能、電源断からの録音完全復元は含めない。現在のMIDI機能の維持とMCP依存の除去を優先する。

次に着手する作業はPhase 1。全操作の仕様と検証基準を固定し、状態管理と保存競合を最初に設計確定する。その後、共通業務APIを抽出してからCLIとスキルの入口を置き換える。

## 参照したプロジェクト内資料

- [サーバー本体](../../src/index.ts)、[直接API](../../src/directApi.ts)、[保存処理](../../src/storage.ts)
- [既存スキル](../../skills/mcp-midi-tool/SKILL.md)、[ローカルMCPクライアント](../../skills/mcp-midi-tool/lib/localToolClient.mjs)
- [既存スキルの利用手順](../../skills/mcp-midi-tool/references/README.md)
- [JSONファーストの設計判断](../adr/ADR-0002-json-first-composition.md)
- [JSON MIDI仕様](../specs/json_midi_schema_v1.md)、[Score DSL仕様](../specs/score_dsl_v1.md)
- [継続録音仕様](../specs/continuous_midi_recording_interface_spec.md)
- [録音自動保存テスト](../../tests/continuous_recording_auto_save.test.ts)、[MCPテストヘルパー](../../tests/helpers/mcpServer.ts)
