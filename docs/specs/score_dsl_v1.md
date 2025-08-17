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
- `tracks`: Array<Track>

Track:
- `name?`: string
- `channel?`: 0-15（デフォルト0）
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

RationalValue: { `numerator`: number, `denominator`: number }（正確な有理数指定）

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
- `accent`: ベロシティ +15（上限127）。`marcato`: +25。
- `tie`: 直前ノートと同pitch連続なら結合し、noteOffを延長（新たなnoteOnは生成しない）。

5) 制御系（最小）
- `cc`/`pitchBend` は `at`位置をtick化してそのままJSON MIDI v1のイベントに転写。

6) 安定性・順序
- 既存エンコーダの順序規則（meta→program/cc→notes）に合流。tick/チャンネル/種別で安定ソート。

---

## エラーモデル（簡易）
- 妥当性: Zodによるスキーマ検証。位置/音価/連符の不整合、tie対象不在、ピッチ未解決などを集約して返却。
- 丸め: tick丸め誤差が±1tick内に収まらない連鎖がある場合は警告。

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
      "channel": 0,
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

## 拡張余地
- ダイナミクス記号→ベロシティ曲線（クレッシェンド/デクレッシェンド）
- 表現記号→CC（サステイン/モジュレーション）自動付与のプリセット
- スウィング（シャッフル比）
- キー変化・拍子変化の途中挿入
