import test from 'node:test';
import assert from 'node:assert/strict';
import {hostCallFor,receiptFromHost,observationFromWait} from '../../src/adapters/codex-desktop/index.mjs';
const workerRef={threadId:'worker-1',hostId:'local'};
const action={id:'action-1',type:'create',projectId:'p',taskId:'t',runId:'r',hostProjectId:'desktop-p',projectRoot:'F:/project',controllerRef:{threadId:'controller',hostId:'local'},profile:{model:'test-model',thinking:'high'},prompt:'Check the fixture'};
const envelope = payload => ({content: [{type: 'text', text: JSON.stringify(payload)}], isError: false});
const terminalPoll = {
  thread: {id: workerRef.threadId, hostId: workerRef.hostId, status: {type: 'idle'}},
  cursor: 'c2',
  latestTurn: {id: 'turn-1', status: 'completed'}
};
const completedResult = {
  runId: 'r', status: 'completed', summary: 'done',
  verification: {status: 'passed', evidenceRefs: ['worker-evidence']}, pendingRequests: []
};
const finalMessage = result => ({
  text: JSON.stringify(result), turnId: terminalPoll.latestTurn.id, phase: 'final_answer'
});

test('creates a local project conversation with explicit execution settings',()=>{
 const call=hostCallFor(action); assert.equal(call.arguments.target.projectId,'desktop-p'); assert.equal(call.arguments.model,'test-model');assert.equal(call.arguments.thinking,'high');assert.match(call.arguments.prompt,/runId: r/);
});
test('MCP envelope creates a worker; setup-in-progress remains unknown',()=>{
 assert.deepEqual(receiptFromHost(action,envelope(workerRef)),{outcome:'succeeded',receipt:{workerRef}});
 assert.deepEqual(receiptFromHost(action,envelope({clientThreadId:'setup-1'})),
   {outcome:'unknown',receipt:{clientThreadId:'setup-1'}});
 assert.throws(()=>receiptFromHost(action,{isError:true,content:[]}),{code:'HOST_ERROR'});
 assert.throws(()=>receiptFromHost(action,{threadId:'worker-1',hostId:17}),{code:'HOST_CONTRACT'});
 assert.throws(()=>receiptFromHost(action,envelope({...workerRef,hostId:'other-host'})),{code:'WORKER_MISMATCH'});
});
test('raw acknowledgements require the shape of the planned mutation', () => {
  const send = {...action, type: 'send', workerRef};
  const archive = {...action, type: 'archive', workerRef};
  const unarchive = {...action, type: 'unarchive', workerRef};
  const messageSent = {threadId: workerRef.threadId};
  const archived = {...messageSent, archived: true};
  const restored = {...messageSent, archived: false};
  assert.deepEqual(receiptFromHost(send, envelope(messageSent)), {outcome: 'succeeded', receipt: {workerRef}});
  assert.deepEqual(receiptFromHost(send, envelope({...messageSent, turnId: 'turn-2'})).receipt,
    {workerRef, turnId: 'turn-2'});
  assert.equal(receiptFromHost(archive, envelope(archived)).receipt.archived, true);
  assert.equal(receiptFromHost(unarchive, envelope(restored)).receipt.archived, false);
  for (const payload of [messageSent, archived, restored, {...workerRef, archived: false}, {...workerRef, turnId: 'turn-2'}]) {
    assert.throws(() => receiptFromHost(action, envelope(payload)), {code: 'HOST_CONTRACT'});
  }
  for (const payload of [workerRef, archived, restored, {clientThreadId: 'setup-1'}, {thread: {id: workerRef.threadId}}]) {
    assert.throws(() => receiptFromHost(send, envelope(payload)), {code: 'HOST_CONTRACT'});
  }
  assert.throws(() => receiptFromHost(archive, envelope(workerRef)), {code: 'HOST_CONTRACT'});
});
test('rejects archive receipts for another worker or wrong archive state',()=>{
 const archive={...action,type:'archive',workerRef};
 assert.throws(()=>receiptFromHost(archive,{threadId:'other',archived:true}),{code:'WORKER_MISMATCH'});
 assert.throws(()=>receiptFromHost(archive,{threadId:'worker-1',archived:false}),{code:'HOST_CONTRACT'});
 assert.equal(receiptFromHost(archive,{threadId:'worker-1',archived:true}).receipt.archived,true);
});
test('idle alone is not completed and attention takes precedence over a previous completed turn',()=>{
 const base={thread:{id:'worker-1',hostId:'local',status:{type:'idle'}},cursor:'c1'};
 assert.equal(observationFromWait({polls:[base]},workerRef,'r','evidence').status,'unknown');
 const waiting={...base,thread:{...base.thread,status:{type:'active',activeFlags:['waitingOnApproval']}},latestTurn:{id:'turn-1',status:'completed'}};
 assert.equal(observationFromWait({polls:[waiting]},workerRef,'r','evidence').status,'waiting_approval');
});
test('completed result stays observation evidence and never claims verification', () => {
  const message = finalMessage(completedResult);
  const raw = envelope({polls: [{...terminalPoll, latestAssistantMessage: message}]});
  const observation = observationFromWait(raw, workerRef, 'r', 'evidence');
  assert.equal(observation.status, 'completed');
  assert.deepEqual(observation.result, {success: true, summary: message.text});
  assert.equal(observation.verification, undefined);
});
test('a completed model turn with failed work or pending questions is not successful work', () => {
  const observe = result => observationFromWait(
    {polls: [{...terminalPoll, latestAssistantMessage: finalMessage(result)}]}, workerRef, 'r', 'evidence'
  );
  const failed = observe({...completedResult, status: 'failed', summary: 'tests failed'});
  assert.equal(failed.status, 'failed');
  assert.equal(failed.result.success, false);
  const waiting = observe({...completedResult, pendingRequests: [{id: 'question-1', kind: 'input', summary: 'Answer required'}]});
  assert.equal(waiting.status, 'waiting_input');
  assert.equal(waiting.waitId, 'question-1');
  assert.equal(waiting.result, undefined);
});
test('malformed or nonfinal worker replies cannot become terminal results', () => {
  const request = {id: 'approval-1', kind: 'approval', summary: 'Approval required'};
  const valid = finalMessage(completedResult);
  const malformed = [
    ['missing requests', finalMessage({...completedResult, pendingRequests: undefined})],
    ['requests as an object', finalMessage({...completedResult, pendingRequests: request})],
    ['null request', finalMessage({...completedResult, pendingRequests: [null]})],
    ['invalid request id', finalMessage({...completedResult, pendingRequests: [{...request, id: ''}]})],
    ['invalid request kind', finalMessage({...completedResult, pendingRequests: [{...request, kind: 'other'}]})],
    ['missing request summary', finalMessage({...completedResult, pendingRequests: [{...request, summary: undefined}]})],
    ['wait without requests', finalMessage({...completedResult, status: 'waiting_approval'})],
    ['invalid verification', finalMessage({...completedResult, verification: {status: 'passed'}})],
    ['missing summary', finalMessage({...completedResult, summary: undefined})],
    ['unexpected result field', finalMessage({...completedResult, extra: true})],
    ['commentary', {...valid, phase: 'commentary'}],
    ['different turn', {...valid, turnId: 'previous-turn'}],
    ['truncated JSON', {...valid, text: valid.text.slice(0, -1)}]
  ];
  for (const [label, latestAssistantMessage] of malformed) {
    const observation = observationFromWait(
      {polls: [{...terminalPoll, latestAssistantMessage}]}, workerRef, 'r', 'evidence'
    );
    assert.equal(observation.status, 'unknown', label);
    assert.equal(observation.result, undefined, label);
  }
});
test('observation identity includes the run and final evidence at the same cursor', () => {
  const observe = (poll, runId = 'r', evidenceRef = 'evidence') =>
    observationFromWait({polls: [poll]}, workerRef, runId, evidenceRef);
  const compact = {...terminalPoll, changed: false};
  const full = {...terminalPoll, changed: true, latestAssistantMessage: finalMessage(completedResult)};
  const incomplete = observe(compact);
  const complete = observe(full);
  assert.equal(incomplete.status, 'unknown');
  assert.equal(complete.status, 'completed');
  assert.equal(incomplete.hostCursor, complete.hostCursor);
  assert.notEqual(incomplete.eventId, complete.eventId);
  assert.equal(observe(compact).eventId, incomplete.eventId);
  assert.equal(observe({...full, changed: false}, 'r', 'same-evidence-copy').eventId, complete.eventId);
  assert.notEqual(observe(compact, 'next-run').eventId, incomplete.eventId);
  const updated = {...full, latestAssistantMessage: finalMessage({...completedResult, summary: 'updated'})};
  assert.notEqual(observe(updated).eventId, complete.eventId);
});
test('a stale completed turn cannot complete a newly dispatched run',()=>{
 const poll={...terminalPoll,latestAssistantMessage:finalMessage({...completedResult,runId:'old-run'})};
 assert.equal(observationFromWait({polls:[poll]},workerRef,'new-run','evidence').status,'unknown');
 assert.equal(observationFromWait({polls:[{...poll,latestTurn:{...poll.latestTurn,status:'failed'}}]},workerRef,'new-run','evidence').status,'unknown');
 assert.equal(observationFromWait({polls:[{...poll,latestTurn:{...poll.latestTurn,status:'interrupted'}}]},workerRef,'new-run','evidence').status,'unknown');
});
