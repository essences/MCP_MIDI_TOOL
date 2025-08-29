import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function spawnServer(){ return spawn(process.execPath, ['./dist/index.js'], { cwd: process.cwd(), stdio:['pipe','pipe','pipe']}); }
function sendLine(child:any,obj:any){ child.stdin.write(JSON.stringify(obj)+'\n'); }
async function readLine(child:any){ const [buf] = await once(child.stdout,'data') as [Buffer]; return JSON.parse(buf.toString('utf8').split(/\r?\n/)[0]); }

// RED テスト: 2小節構成で bar1 途中にテンポ 120->240 変化, bar2 抽出時に 0tick へ正しい tempo シード(=240) と予定イベント/総時間が "精密抽出" で再計算された状態を期待。
// まだ実装されていないため extractionMode:"precise" 応答や tempo/timeSig シードを検証して失敗(RED)させる。
// 実装完了後: tempo 変化前後の tick->ms 再計算が行われ, bar2 の durationMs が単純比率で短くなることを確認予定。

const SCORE = `#title:TempoCross\n#time:4/4\n#tempo:120\n` +
  // bar1 前半 4分3つ (12拍分) 後半でテンポ変更メタ( #tempo:240 ) を意図: Score DSL v1 が bar内途中テンポ変化をどう表現するか要検討 (仮: 行継続で #tempo:240 )
  // DSLが小節途中テンポに未対応なら後続で JSON 直接投入へ修正。
  `piano: C4 4 C4 4 C4 4 | C4 8 C4 8 C4 8 C4 8`;

// NOTE: 現在 DSL 途中テンポ未サポートの可能性が高いので初回REDは単純に bar2 抽出時に extractionMode:"precise" を要求し失敗させる目的。

describe('play_smf precise bar range tempo crossing (RED)', () => {
  it('bar2 抽出: extractionMode:"precise" として tempo シード(予定) を検証 (未実装で失敗するはず)', async () => {
    const child = spawnServer();
    sendLine(child,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'vitest-client',version:'0.0.1'}}});
    await readLine(child);

    // DSL -> SMF
    sendLine(child,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'json_to_smf',arguments:{ json: SCORE, format:'score_dsl_v1', name:'tempo_cross.mid', overwrite:true }}});
    const smfResp = await readLine(child); expect(smfResp.error).toBeUndefined(); const fileId = smfResp.result?.fileId; expect(typeof fileId).toBe('string');

    // bar2 抽出 (まだ precise 実装途中)
    sendLine(child,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'play_smf',arguments:{ fileId, dryRun:true, startBar:2, endBar:2 }}});
    const resp = await readLine(child);

    // 期待: 将来 resp.result.extractionMode === 'precise' になる（現状は undefined or simplified 想定）
    expect(resp.result?.extractionMode).toBe('precise'); // RED: 現在は失敗する

    child.kill();
  }, 15000);
});
