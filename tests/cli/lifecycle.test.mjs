import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const cli=fileURLToPath(new URL('../../src/cli/main.mjs',import.meta.url));
function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'worker-orchestrator-cli-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=(command,input)=>{
  const r=spawnSync(process.execPath,[cli,command,'--state-dir',path.join(root,'state'),'--input','-'],{input:JSON.stringify(input),encoding:'utf8'});
  assert.equal(r.error,undefined);return {code:r.status,json:JSON.parse(r.stdout)};
 };
 const project={projectId:'p',projectRoot:root,hostProjectId:'host-p',controller:{threadId:'controller',hostId:'local'},authorization:{createWorkers:true,sendFollowups:true,archiveCompleted:true,restoreWorkers:true,source:'test fixture authorized lifecycle'}};
 assert.equal(run('project',project).code,0);
 const dispatch={projectId:'p',taskId:'t',requestId:'req-1',prompt:'Probe',profile:{model:'test-host-model',thinking:'low'}};
 return {root,run,dispatch};
}
test('CLI records real envelope shape and gates archive until verification and acceptance',t=>{
 const {run,dispatch}=fixture(t);
 const planned=run('dispatch',dispatch);assert.equal(planned.code,0);assert.equal(planned.json.hostCall.tool,'mcp__codex_app__create_thread');
 const action=planned.json.action;
 const raw={content:[{type:'text',text:JSON.stringify({threadId:'worker',hostId:'local'})}]};
 const bound=run('record',{projectId:'p',taskId:'t',actionId:action.id,hostResult:raw,evidenceRef:'fixture/create.json'});assert.equal(bound.code,0);
 const scope={projectId:'p',taskId:'t',runId:action.runId};
 assert.notEqual(run('archive',scope).code,0);
 const text=JSON.stringify({runId:action.runId,status:'completed',summary:'done',verification:{status:'not_run',evidenceRefs:[]},pendingRequests:[]});
 const wait={polls:[{thread:{id:'worker',hostId:'local',status:{type:'idle'}},cursor:'c1',latestTurn:{id:'turn',status:'completed'},latestAssistantMessage:{text,turnId:'turn',phase:'final_answer'}}]};
 assert.equal(run('observe',{...scope,hostResult:wait,evidenceRef:'fixture/wait.json'}).code,0);
 assert.notEqual(run('accept',scope).code,0);
 assert.equal(run('verify',{...scope,status:'passed',evidenceRefs:['fixture/verified-marker.json']}).code,0);
 assert.equal(run('accept',scope).code,0);
 const archive=run('archive',scope);assert.equal(archive.json.hostCall.arguments.archived,true);
 assert.equal(run('record',{...scope,actionId:archive.json.action.id,hostResult:{threadId:'worker',archived:true},evidenceRef:'fixture/archive.json'}).code,0);
 const follow=run('dispatch',{...dispatch,requestId:'req-2',prompt:'Follow up'});
 assert.equal(follow.json.action.type,'unarchive');assert.notEqual(follow.json.task.runId,action.runId);assert.equal(follow.json.task.verification.status,'unverified');
 const unarchived=run('record',{projectId:'p',taskId:'t',actionId:follow.json.action.id,hostResult:{threadId:'worker',archived:false},evidenceRef:'fixture/unarchive.json'});
 assert.equal(unarchived.code,0);assert.equal(unarchived.json.action.type,'send');assert.equal(unarchived.json.hostCall.arguments.threadId,'worker');
});
test('unparseable host acknowledgement blocks repeat creation across CLI processes',t=>{
 const {run,dispatch}=fixture(t);const plan=run('dispatch',dispatch).json;
 const bad=run('record',{projectId:'p',taskId:'t',actionId:plan.action.id,hostResult:{isError:true,content:[]},evidenceRef:'fixture/ambiguous.json'});
 assert.equal(bad.code,1);assert.equal(bad.json.needsReconciliation,true);assert.equal(bad.json.action,null);
 const replay=run('dispatch',dispatch);assert.equal(replay.code,0);assert.equal(replay.json.action,null);assert.equal(replay.json.needsReconciliation,true);
});
test('invalid reasoning effort cannot leave an unexecutable persisted creation',t=>{
 const {run,dispatch}=fixture(t);const bad=run('dispatch',{...dispatch,profile:{model:'test',thinking:'invalid'}});
 assert.equal(bad.code,2);assert.equal(bad.json.error.code,'MODEL_SETTINGS');
 const valid=run('dispatch',dispatch);assert.equal(valid.code,0);assert.equal(valid.json.action.type,'create');
});
test('malformed host identity and domain-rejected host receipt both prevent retry creation',t=>{
 const {run,dispatch}=fixture(t);
 const first=run('dispatch',dispatch).json;
 const malformed=run('record',{projectId:'p',taskId:'t',actionId:first.action.id,hostResult:{threadId:'worker',hostId:17},evidenceRef:'fixture/malformed.json'});
 assert.equal(malformed.code,1);assert.equal(malformed.json.needsReconciliation,true);assert.equal(run('dispatch',dispatch).json.hostCall,undefined);
 const confirmed=run('record',{projectId:'p',taskId:'t',actionId:first.action.id,hostResult:{threadId:'worker',hostId:'local'},evidenceRef:'fixture/confirmed.json'});assert.equal(confirmed.code,0);
 const second=run('dispatch',{...dispatch,taskId:'other',requestId:'other-1'}).json;
 const collision=run('record',{projectId:'p',taskId:'other',actionId:second.action.id,hostResult:{threadId:'worker',hostId:'local'},evidenceRef:'fixture/collision.json'});
 assert.equal(collision.code,1);assert.equal(collision.json.needsReconciliation,true);
 assert.equal(run('dispatch',{...dispatch,taskId:'other',requestId:'other-1'}).json.hostCall,undefined);
});
