import {describe,it,expect} from 'vitest';
import {parse} from '../src/cli/commands.js';
describe('CLI typed arguments',()=>{
 it('maps kebab options and ID aliases without losing JSON arrays',()=>{const result=parse(['capture','feed','--id','session','--events','[{"kind":"on","note":60,"at":0}]']);expect(result.operation).toBe('feed_single_capture');expect(result.args.captureId).toBe('session');expect(result.args.events[0].note).toBe(60);});
 it('rejects unknown flags, nonfinite numbers, wrong arrays and malformed booleans',()=>{for(const args of [['list','--wat'],['list','--limit','Infinity'],['notes','--notes','{}'],['play','--dry-run=maybe'],['run','--operation','unknown'],['capture','start','--source','unknown']])expect(()=>parse(args)).toThrow();});
});
