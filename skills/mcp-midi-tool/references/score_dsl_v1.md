# Score DSL v1 仕様（音楽記法レイヤー）

## 1. 概要

### 1.1 目的
音楽家に親和的な表現（小節・拍・音価・アーティキュレーション・拍子・キー）でJSONを記述し、既存の JSON MIDI v1（tick/ppqベース）へ確定的にコンパイルする。

### 1.2 適用範囲
- **対象**: 記譜的なフレーズ入力、作曲・編集、ルールベースの変換（人間味/クオンタイズ/移調）
- **非対象**: DAW/音源固有のキースイッチ/CCプリセット（将来の拡張ポイント）

## 2. データモデル

### 2.1 ルート構造
`scoreV1`:
- `ppq?`: number（既定: 480）
- `meta`: メタ情報
- `tracks`: Array<Track>

### 2.2 メタ情報
`meta`:
- `timeSignature`: 拍子情報
- `keySignature`: 調号情報
- `tempo`: テンポ情報
- `title?`: string
- `composer?`: string
- `autoCcPresets?`: Array<AutoCcPreset>

#### 2.2.1 拍子情報
`timeSignature`:
- `numerator`: number
- `denominator`: 1|2|4|8|16

#### 2.2.2 調号情報
`keySignature`:
- `root`: "C|G|D|A|E|B|F#|C#|F|Bb|Eb|Ab|Db|Gb|Cb"
- `mode`: "major|minor"

#### 2.2.3 テンポ情報
`tempo`:
- `{ bpm: number }` または
- `{ changes: Array<{ bar:number, beat:number, bpm:number }> }`

#### 2.2.4 自動CCプリセット
`AutoCcPreset`:
- `sustain_from_slur`: slur/legato区間にCC64自動付与
- `crescendo_to_expression`: dynamic変化点にCC11ランプ生成

### 2.3 トラック構造
`Track`:
- `name?`: string
- `channel?`: 1-16（外部表記、内部では0-15にマップ、デフォルトは1=ch1）
- `program?`: 0-127（GM音色）
- `events`: Array<イベント>

### 2.4 イベント型

#### 2.4.1 ノートイベント
`NoteEvent`:
- `type`: "note"
- `pitch?`: number（0-127） | `note?`: string（例: "C4", "F#3", "Bb5"）
- `start`: Position
- `duration`: DurationSpec
- `velocity?`: 1-127 | `dynamic?`: "pp|p|mp|mf|f|ff"
- `tie?`: boolean（前の音と結合）
- `slur?`: boolean（レガート群の一部）
- `articulation?`: "staccato|tenuto|legato|accent|marcato"

#### 2.4.2 コントロールイベント
`ControlEvent`（将来拡張; v1は最小）:
- `type`: "cc" | "pitchBend"
- `cc?`: number, `value?`: number | `bend?`: number
- `at`: Position

#### 2.4.3 マーカーイベント
`MarkerEvent`:
- `type`: "marker" | "trackName"
- `text`: string
- `at`: Position

### 2.5 位置指定
`Position`（基準: 小節/拍/サブ拍）:
- `bar`: 1..N （v1では 0 小節=アップビート表記は未対応。アウフタクトは「最初の小節を短縮」するか、コンパイル前の素材段階で調整してください。将来バージョンで `bar:0` を検討）
- `beat`: 1..numerator
- `unit?`: number（拍をさらに1/unitに分割）
- `offset?`: number（unit単位のオフセット）

### 2.6 音価指定
`DurationSpec`:
- `value`: NotationValue | RationalValue
- `dots?`: 0|1|2
- `tuplet?`: { `inSpaceOf`: number, `play`: number }

#### 2.6.1 記譜音価
`NotationValue`: "1|1/2|1/4|1/8|1/16|1/32"

**注意**: 全音符は "1" を指定（"1/1" は無効・非対応）。
無効理由: `NotationValue` リストに列挙されたシンボルのみを許容し、分数形式は基本的に分母が 2,4,8,16,32 に限定されるため。`"1/1"` を与えるとスキーマ検証で `Invalid enum value. Expected '1|1/2|1/4|1/8|1/16|1/32'` のエラーとなる。→ "1" に置き換えてください。

#### 2.6.2 有理数音価
`RationalValue`: { `numerator`: number, `denominator`: number }

## 3. コンパイル規則（Score DSL → JSON MIDI v1）

### 3.1 時間解像度
- `ppq`はルートで指定（既定480）。四分音符=ppq tick
- 音価→tick: base = ppq * (1 / noteFraction)
- 付点処理: ×1.5（1付点）、×1.75（2付点）
- 連符処理: duration = base * (inSpaceOf / play)
- 丸め方式: 有理数総和→最後に丸め（累積ドリフト回避）

#### 3.1.1 音価変換例
- 1/4 → 480 ticks
- 1/8 → 240 ticks
- 8分3連（拍内）= 240 * (2/3) = 160 ticks

### 3.2 位置変換
- 拍子: numerator/denominator
- 1小節のtick = ppq * 4/denominator * numerator
- Position → tick = barStart + (beat-1)*beatTicks + offsetTicks

### 3.3 メタイベント（track 0）
- `timeSignature`: tick=0に`meta.timeSignature`
- `keySignature`: tick=0に`meta.keySignature`  
- `tempo`: tick=0（固定）または変更点に`meta.tempo`
- `title`/`composer`: `meta.trackName`/`meta.marker`等で補助表現

### 3.4 ノートとアーティキュレーション

#### 3.4.1 基本処理
- 基本: noteOn at startTick, noteOff at startTick + durTicks

#### 3.4.2 ダイナミクス
`dynamic`のベロシティマッピング（既定値、変更可能）:
- pp=32, p=48, mp=64, mf=80, f=96, ff=112

#### 3.4.3 アーティキュレーション処理
- `staccato`: 実長 = dur * 0.5（既定）
- `tenuto`: 実長 = dur * 1.05（次音に食い込まない範囲）
- `legato`/`slur`: 次音と重なり（overlap=+10% or 最小5 ticks）
- `accent`: ベロシティ +15（上限127）
- `marcato`: ベロシティ +25
- `tie`: 直前ノートと同pitch連続時に結合、noteOff延長

#### 3.4.4 サステイン補助
必要に応じてサーバの`insert_sustain`ツールで後処理としてCC64(127/0)を範囲挿入可能

### 3.5 制御系イベント
`cc`/`pitchBend`は`at`位置をtick化してJSON MIDI v1のイベントに転写

### 3.6 安定性・順序
既存エンコーダの順序規則（meta→program/cc→notes）に合流、tick/チャンネル/種別で安定ソート

### 3.7 チャンネル表記原則
- Score DSL: チャンネル1〜16で指定（例: ch1は1）
- 内部処理/SMF: 0〜15使用、入出力時に相互変換
- 仕様では"0"チャンネル指定を使用しない（AI誤選択回避）

補足: v1 のテスト群も DSL 入力では 1 始まりへ統一（以前は一部 `channel:0` を使用していたが仕様と揃えるため修正）。JSON MIDI v1 フォーマット（tick/ppq ベース）を直接与える低レイヤでは内部表現として 0〜15 が現れることは正当。

## 4. エラーモデル

### 4.1 検証範囲
- 妥当性: Zodによるスキーマ検証
- 位置/音価/連符の不整合検出
- tie対象不在、ピッチ未解決等を集約して返却

### 4.2 丸め処理
tick丸め誤差が±1tick内に収まらない連鎖がある場合は警告

## 5. よくある誤解と対処

### 5.1 beat指定の注意点
- **NG**: `{"start": { "bar": 1, "beat": 2.5 }}` → スキーマエラー（Expected integer）
- **OK**: 半拍は`unit`と`offset`を使用

#### 5.1.1 半拍・3連位置指定例
```json
{ "start": { "bar": 1, "beat": 2, "unit": 2, "offset": 1 } }   // 2.5拍（半拍）
{ "start": { "bar": 1, "beat": 1, "unit": 3, "offset": 1 } }   // 3連の2つ目位置
{ "start": { "bar": 1, "beat": 1, "unit": 3, "offset": 2 } }   // 3連の3つ目位置
```

### 5.2 articulation制限
- **許容**: `staccato | tenuto | legato | accent | marcato`
- **未対応**: `crescendo / diminuendo`等の継続系表現

#### 5.2.1 継続系表現の回避策
- **簡易**: ノートごとの`velocity`/`dynamic(pp..ff)`を段階的変化
- **発展**: `cc`イベント（例: `cc:11 Expression`）を時間軸配置
- **後処理**: MCPサーバの`insert_cc`ツールで範囲一括挿入

### 5.3 音名書式
- **許容**: `C4, F#3, Bb5, Ab4, Db5`等（`[A-G](#|b)?-?\d+`）
- **範囲**: 0..127に収まるよう（オクターブは-1..9程度）

### 5.4 付点・連符
- **付点**: `dots: 1`（×1.5）、`dots: 2`（×1.75）
- **連符**: `tuplet: { inSpaceOf, play }`

#### 5.4.1 連符例
8分3連 = `value:"1/8"`, `inSpaceOf:2`, `play:3`

### 5.5 全音符指定
- **NG**: `{"duration": { "value": "1/1" }}`（未対応）
- **OK**: `{"duration": { "value": "1" }}`

## 6. 使用例

### 6.1 基本例
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

### 6.2 コンパイル後の構造（概念）
- **track 0**: meta.timeSignature@0, meta.keySignature@0, meta.tempo@0, meta.trackName@0("DSL Demo")
- **track 1**: program@0, noteオン/オフ（tick変換: 1/4=480, 付点8分=360, 8分3連=160等; articulation適用: staccato=×0.5, legato=重なり, accent=ベロ+15）

## 7. MCPツール使用方法

Score DSL v1をMCPツール`json_to_smf`に渡す際は、`format: "score_dsl_v1"`を明示（厳密分岐）。

### 7.1 呼び出し例
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

### 7.2 注意点
- `json`はJSON文字列でも可（内部でJSON.parseを実行）
- `format`未指定時は「JSON MIDI v1検証→失敗時Score DSL v1コンパイル」に自動フォールバック
- 誤検出回避のため`format`明示を推奨

## 8. システム整合性

### 8.1 既存システムとの互換性
- 既存のJSON MIDI v1（tickベース）と完全互換
- Score DSLは上位の入力表現としてコンパイルで合流
- `note`（音名）は既存解決器（C4/F#3/Bb5）を再利用

## 9. 将来拡張

### 9.1 予定機能
- ダイナミクス記号→ベロシティ曲線（クレッシェンド/デクレッシェンド）
- 表現記号→CC自動付与プリセット（サステイン/モジュレーション/Expression等）
- スウィング（シャッフル比）
- キー変化・拍子変化の途中挿入

### 9.2 後処理ツール連携
- MCPツール`insert_cc`による任意CCの範囲一括挿入
- 後処理での柔軟な表現制御が可能

## 10. pitch / note フィールド利用指針

`NoteEvent` は以下 2 つの方法でピッチを指定可能:

- `pitch`: 0–127 の数値（MIDI ノート番号）
- `note`: 音名文字列（例: `C4`, `F#3`, `Bb5`）

片方だけ指定しても良い。両方を同時に指定した場合 v1 実装では「優先順位は設けず」両者が同じ音高を指しているかを検証し、不一致ならエラーを返す（整合性確保）。ツールチェーン側でどちらを保持するかは最適化の都合で変わる可能性があるため、生成物を厳密比較するテストを書く際は一方に統一することを推奨。

例（両方一致 OK）:
```json
{ "type":"note", "pitch":60, "note":"C4", "start":{ "bar":1, "beat":1 }, "duration":{ "value":"1/4" } }
```
例（不一致 NG: pitch 61 != C4=60）:
```json
{ "type":"note", "pitch":61, "note":"C4", "start":{ "bar":1, "beat":1 }, "duration":{ "value":"1/4" } }
```
