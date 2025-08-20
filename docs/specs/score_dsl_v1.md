# Score DSL v1 仕様（音楽記法レイヤー）

目的: 音楽家に親和的な表現（小節・拍・音価・アーティキュレーション・拍子・キー）でJSONを記述し、既存の JSON MIDI v1（tick/ppqベース）へ確定的にコンパイルする。

- 対象: 記譜的なフレーズ入力、作曲・編集、ルールベースの変換（人間味/クオンタイズ/移調）
- 非対象: DAW/音源固有のキースイッチ/CCプリセット（将来の拡張ポイント）

---

## データモデル（ハイレベル）

ルート: `scoreV1`
- `ppq?`: number（既定: 480）
- `meta`: 
  - `timeSignature`: { `numerator`: number, `denominator`: 1|2|4|8|16 }
  - `keySignature`: { `root`: "C|G|D|A|E|B|F#|C#|F|Bb|Eb|Ab|Db|Gb|Cb", `mode`: "major|minor" }
  - `tempo`: { `bpm`: number } | { `changes`: Array<{ bar:number, beat:number, bpm:number }> }
  - `title?`: string
  - `composer?`: string
    - `autoCcPresets?`: Array<AutoCcPreset>（スコア→SMF時にCCを自動付与するプリセット。最小: `sustain_from_slur`）
- `tracks`: Array<Track>

Track:
- `name?`: string
- `channel?`: 1-16（外部表記。内部では0-15にマップ／デフォルトは1=ch1）
- `program?`: 0-127（GM音色）
- `events`: Array<NoteEvent | ControlEvent | MarkerEvent>

NoteEvent:
- `type`: "note"
- `pitch?`: number（0-127） | `note?`: string（例: "C4", "F#3", "Bb5"）
- `start`: Position
- `duration`: DurationSpec
- `velocity?`: 1-127 | `dynamic?`: "pp|p|mp|mf|f|ff"
- `tie?`: boolean（前の音と結合して一つの保持音にする）
- `slur?`: boolean（レガート群の一部。CC64や重なりにマッピング可）
- `articulation?`: "staccato|tenuto|legato|accent|marcato"

ControlEvent（将来拡張; v1は最小）:
- `type`: "cc" | "pitchBend"
- `cc?`: number, `value?`: number | `bend?`: number
- `at`: Position

MarkerEvent:
- `type`: "marker" | "trackName"
- `text`: string
- `at`: Position

Position（基準: 小節/拍/サブ拍）:
- `bar`: 1..N（アップビート対応のため0小節も許容可）
- `beat`: 1..numerator
- `unit?`: number（0.., 拍をさらに1/unitに分割。例: unit=480でtick等価）
- `offset?`: number（unit単位のオフセット）

DurationSpec（音価指定）:
- `value`: NotationValue | RationalValue
- `dots?`: 0|1|2
- `tuplet?`: { `inSpaceOf`: number, `play`: number }（例: 3連符 → inSpaceOf:2, play:3）

NotationValue: "1|1/2|1/4|1/8|1/16|1/32"（全/2分/4分/8分...）

注意（重要）: 全音符は "1" を指定してください（"1/1" は無効・非対応）。

RationalValue: { `numerator`: number, `denominator`: number }（正確な有理数指定）

AutoCcPreset（最小）:
- `id`: "sustain_from_slur" — slur もしくは articulation=="legato" が連続する区間に対し、CC64 の 127（開始）/0（終了）を自動付与。
  - 指定例: `meta.autoCcPresets: [ { id: "sustain_from_slur" } ]`

---

## コンパイル規則（Score DSL → JSON MIDI v1）

1) 時間解像度
- `ppq`はルートで指定（既定480）。四分音符=ppq tick。
- 音価→tick: base = ppq * (1 / noteFraction)。
  - 例: 1/4 → 480, 1/8 → 240, 付点は ×1.5, 二重付点 ×1.75。
  - 連符: duration = base * (inSpaceOf / play)。例: 8分3連（拍内）= 240 * (2/3) = 160。
- 端数は四捨五入だが、累積ドリフトを避けるために「有理数総和→最後に丸め」方式を採用。

2) 位置→tick
- 拍子: numerator/denominator。
- 1小節のtick = ppq * 4/denominator * numerator。
- `Position` → tick = barStart + (beat-1)*beatTicks + offsetTicks。

3) メタ（track 0）
- `timeSignature` は tick=0 に `meta.timeSignature`。
- `keySignature` は tick=0 に `meta.keySignature`。
- `tempo` は tick=0（固定）または変更点に `meta.tempo` を配置。
- `title`/`composer` は `meta.trackName`/`meta.marker`等で補助表現。

4) ノートとアーティキュレーション
- 基本: noteOn at startTick, noteOff at startTick + durTicks。
- `dynamic`: ベロシティへマッピング（pp=32, p=48, mp=64, mf=80, f=96, ff=112 を既定; 変更可能）。
- `staccato`: 実長 = dur * 0.5（既定）。
- `tenuto`: 実長 = dur * 1.05（ただし次音に食い込まないよう最小(次音開始-1tick)）。
- `legato` or `slur`: 次音と重なりを作る（overlap=+10% or 最小 5 ticks）。必要に応じ `CC64` on/off で補助（オプション）。
  - 補足: 必要に応じてサーバの `insert_sustain` ツールで後処理として CC64(127/0) を範囲挿入できます（既存SMFに対する事後付与）。
- `accent`: ベロシティ +15（上限127）。`marcato`: +25。
- `tie`: 直前ノートと同pitch連続なら結合し、noteOffを延長（新たなnoteOnは生成しない）。

5) 制御系（最小）
- `cc`/`pitchBend` は `at`位置をtick化してそのままJSON MIDI v1のイベントに転写。

6) 安定性・順序
- 既存エンコーダの順序規則（meta→program/cc→notes）に合流。tick/チャンネル/種別で安定ソート。

補足（チャンネル表記の原則）
- Score DSLではチャンネルは1〜16で指定します（例: ch1は1）。
- 内部処理/SMFでは0〜15を用いるため、入出力時に相互変換します。
- 仕様・プロンプト・サンプルで“0”というチャンネル指定は使用しません（AIが0を誤って選ばないように）。

---

## エラーモデル（簡易）
- 妥当性: Zodによるスキーマ検証。位置/音価/連符の不整合、tie対象不在、ピッチ未解決などを集約して返却。
- 丸め: tick丸め誤差が±1tick内に収まらない連鎖がある場合は警告。

---

## よくある誤解と対処（クイックリファレンス）

1) beat は整数（小数不可）
- NG: `{"start": { "bar": 1, "beat": 2.5 }}` → スキーマエラー（Expected integer）
- OK: 半拍を表す場合は `unit` と `offset` を使う。
  - 例: 2.5 拍 → `{"start": { "bar": 1, "beat": 2, "unit": 2, "offset": 1 }}`
  - 例: 3連の1つ目/2つ目 → `unit: 3, offset: 1` / `unit: 3, offset: 2`

2) articulation の許容値
- 許容: `staccato | tenuto | legato | accent | marcato`
- 未対応: `crescendo / diminuendo` などの継続系表現。
  - 回避策A（簡易）: ノートごとの `velocity`/`dynamic(pp..ff)` を段階的に変化させる。
  - 回避策B（発展）: `cc` イベント（例: `cc:11 Expression`）を時間軸に並べて疑似フェーダーを作る。
    - MCPサーバの `insert_cc` ツールを使えば、既存SMFに対して任意のCC番号（例: CC11 Expression, CC1 Modulation等）のON/OFFやフェーダー的な値を範囲で一括挿入できます。
    - 例: crescendo/diminuendoや表現記号をScore DSLで記述→SMF化→`insert_cc`でCC値を範囲挿入→play_smf(dryRun)で確認。

3) 音名の書式
- 許容: `C4, F#3, Bb5, Ab4, Db5` など（`[A-G](#|b)?-?\d+`）。
- 範囲: 0..127 に収まるように（オクターブは -1..9 程度）。

4) 付点と連符
- 付点: `dots: 1`（×1.5）、`dots: 2`（×1.75）。
- 連符: `tuplet: { inSpaceOf, play }`（例: 8分3連 = `value:"1/8"`, `inSpaceOf:2`, `play:3`）。

5) 例（半拍や3連位置の指定）
```json
{ "start": { "bar": 1, "beat": 2, "unit": 2, "offset": 1 } }   // 2.5拍（半拍）
{ "start": { "bar": 1, "beat": 1, "unit": 3, "offset": 1 } }   // 3連の2つ目位置（1/3拍後）
{ "start": { "bar": 1, "beat": 1, "unit": 3, "offset": 2 } }   // 3連の3つ目位置（2/3拍後）
```

6) 全音符の指定
- NG: `{"duration": { "value": "1/1" }}`（未対応）
- OK: `{"duration": { "value": "1" }}`

---

## 例（最小）

Score DSL（入力）:
```json
{
  "ppq": 480,
  "meta": {
    "timeSignature": { "numerator": 4, "denominator": 4 },
    "keySignature": { "root": "C", "mode": "major" },
    "tempo": { "bpm": 120 },
    "title": "DSL Demo"
  },
  "tracks": [
    {
      "name": "Lead",
  "channel": 1,
      "program": 0,
      "events": [
        { "type": "note", "note": "C4", "start": { "bar": 1, "beat": 1 }, "duration": { "value": "1/4" }, "articulation": "staccato" },
        { "type": "note", "note": "D4", "start": { "bar": 1, "beat": 2 }, "duration": { "value": "1/8", "dots": 1 }, "articulation": "accent" },
        { "type": "note", "note": "E4", "start": { "bar": 1, "beat": 3 }, "duration": { "value": "1/8", "tuplet": { "inSpaceOf": 2, "play": 3 } }, "slur": true },
        { "type": "note", "note": "F4", "start": { "bar": 1, "beat": 4 }, "duration": { "value": "1/4" }, "articulation": "legato" }
      ]
    }
  ]
}
```

コンパイル後の JSON MIDI v1（概念）:
- track 0: meta.timeSignature@0, meta.keySignature@0, meta.tempo@0, meta.trackName@0("DSL Demo")
- track 1: program@0, noteオン/オフ（tickは ppq=480 に基づき 1/4=480, 付点8分=360, 8分3連=160 等に変換; staccato=×0.5, legato=重なり, accent=ベロ+15）

---

## 実装計画（概要）

1. Zodスキーマ: `scoreSchema.ts`（scoreV1）
2. コンパイラ: `scoreToJsonMidi.ts`（Position/Duration→tick, articulation/dynamic/tie処理, meta集約）
3. ツール: `score_to_smf { score, name? }` もしくは `json_to_smf` を union対応（`{ type: "scoreV1"|"jsonMidiV1", ... }`）。
4. テスト（Vitest）:
   - 音価: 1/4, 1/8, 付点, 3連（ppq=480/960の双方）
   - アーティキュレーション: staccato/legato/tenuto/accents
   - tie/slur の連結
   - メタ: timeSignature/keySignature/tempo 反映
   - 丸め: 複数連符の累積誤差が±1tick以内
5. ドキュメント/プロンプト:
   - READMEへ導入・サンプル追記
   - `docs/prompts/claude_test_prompts_v8_score_dsl.md`（score→SMF→dryRun→再生→逆変換→音価/音名/拍子キー確認）

---

## 既存システムとの整合
- 既存の JSON MIDI v1（tickベース）と完全互換。Score DSLは上位の入力表現としてコンパイルで合流。
- `note`（音名）は既に対応済み。Scoreでも同じ解決器（C4/F#3/Bb5）を再利用。

---

## サーバへの渡し方（json_to_smf / format指定推奨）

Score DSL v1 を MCP ツール `json_to_smf` に渡す際は、`format: "score_dsl_v1"` を明示してください（厳密分岐）。

例（オブジェクトで渡す場合）:
```jsonc
{
  "tool": "json_to_smf",
  "arguments": {
    "json": {
      "ppq": 480,
      "meta": { "timeSignature": { "numerator": 4, "denominator": 4 }, "tempo": { "bpm": 120 } },
      "tracks": [ { "channel": 1, "events": [ { "type": "note", "note": "C4", "start": { "bar": 1, "beat": 1 }, "duration": { "value": "1/4" } } ] } ]
    },
    "format": "score_dsl_v1",
    "name": "from-dsl.mid"
  }
}
```

備考:
- `json` は JSON 文字列として渡しても構いません（内部で JSON.parse を試みます）。
- `format` 未指定時は後方互換のため「JSON MIDI v1 検証→失敗なら Score DSL v1 コンパイル」に自動フォールバックしますが、誤検出回避のため `format` の明示を推奨します。

---

## 拡張余地
- ダイナミクス記号→ベロシティ曲線（クレッシェンド/デクレッシェンド）
- 表現記号→CC（サステイン/モジュレーション/Expression等）自動付与のプリセット（将来: Score DSL→SMF時に自動CC挿入オプション）
- MCPツール `insert_cc` による任意CCの範囲一括挿入（後処理で柔軟な表現制御が可能）
- スウィング（シャッフル比）
- キー変化・拍子変化の途中挿入
