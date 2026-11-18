#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { Orchestrator } from '../core/orchestrator.mjs';
import { capabilityDescription, hostCallFor, receiptFromHost, observationFromWait, validateProfile } from '../adapters/codex-desktop/index.mjs';

function options(argv) {
  const [command, ...args] = argv;
  const opts = {command};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (!['--state-dir', '--input', '--format'].includes(name) || !args[i + 1]) throw Object.assign(new Error(`Unknown or incomplete option: ${name}`), {code: 'INPUT'});
    if (Object.hasOwn(opts, name)) throw Object.assign(new Error(`Duplicate option: ${name}`), {code: 'INPUT'});
    opts[name] = args[++i];
  }
  if (opts['--format'] && opts['--format'] !== 'json') throw Object.assign(new Error('Only JSON output is supported'), {code:'INPUT'});
  return opts;
}

export function main(argv = process.argv.slice(2)) {
  let app;
  try {
    const opts = options(argv);
    if (opts.command === '--version' || opts.command === 'version') { console.log(JSON.stringify({name:'worker-orchestrator',version:'0.1.0',schemaVersion:1})); return 0; }
    if (opts.command === '--help' || !opts.command) { console.log(JSON.stringify({usage:'node dist/cli.mjs <command> --state-dir <absolute-directory> --input <json-file|->',commands:['project','dispatch','record','observe','resolve','verify','accept','archive','status','capabilities'],hostExecution:'The authorized controller performs returned hostCall, then records the real result.'})); return 0; }
    if (opts.command === 'capabilities') { console.log(JSON.stringify({ok:true,...capabilityDescription()})); return 0; }
    const supported = ['project','dispatch','record','observe','resolve','verify','accept','archive','status'];
    if (!supported.includes(opts.command)) throw Object.assign(new Error(`Unknown command: ${opts.command}`),{code:'INPUT'});
    if (!opts['--input']) throw Object.assign(new Error('--input is required'),{code:'INPUT'});
    const input = JSON.parse(fs.readFileSync(opts['--input'] === '-' ? 0 : opts['--input'], 'utf8').replace(/^\uFEFF/, ''));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('Input must be a JSON object'),{code:'INPUT'});
    if (opts.command === 'dispatch') validateProfile(input.profile);
    const stateDir = opts['--state-dir'] ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'), 'WorkerOrchestrator', 'state');
    if (!path.isAbsolute(stateDir)) throw Object.assign(new Error('--state-dir must be absolute'),{code:'INPUT'});
    app = new Orchestrator(stateDir);
    let hostIssue;
    const recordingHostResult = opts.command === 'record' && Object.hasOwn(input, 'hostResult');
    if (opts.command === 'record' && Object.hasOwn(input, 'hostResult')) {
      const snapshot = app.execute('status', {projectId:input.projectId,taskId:input.taskId});
      const pending = snapshot.task?.pendingAction;
      if (!pending || pending.id !== input.actionId) throw Object.assign(new Error('Host result must match the current pending action'),{code:'ACTION_MISMATCH'});
      let normalized;
      try { normalized = receiptFromHost(pending, input.hostResult); }
      catch (error) {
        hostIssue = {code:error.code ?? 'HOST_CONTRACT',message:error.message};
        normalized = {outcome:'unknown',receipt:{}};
      }
      if (!hostIssue && input.outcome && input.outcome !== normalized.outcome) throw Object.assign(new Error('Host result and requested outcome disagree'),{code:'HOST_CONTRACT'});
      Object.assign(input, normalized);
      delete input.hostResult;
    }
    if (opts.command === 'observe' && Object.hasOwn(input, 'hostResult')) {
      const snapshot = app.execute('status', {projectId:input.projectId,taskId:input.taskId});
      const workerRef = snapshot.task?.workerRef ?? snapshot.task?.worker;
      if (!workerRef) throw Object.assign(new Error('No worker is bound to this task'),{code:'WORKER_MISMATCH'});
      Object.assign(input, observationFromWait(input.hostResult, workerRef, input.runId, input.evidenceRef));
      delete input.hostResult;
    }
    let result;
    try { result = app.execute(opts.command, input); }
    catch (error) {
      if (!recordingHostResult || input.outcome !== 'succeeded') throw error;
      // The call may already have had an external effect even when the local
      // domain rejects its receipt (e.g. duplicate worker identity).
      hostIssue = {code:error.code ?? 'HOST_CONTRACT',message:error.message};
      result = app.execute('record', {projectId:input.projectId,taskId:input.taskId,actionId:input.actionId,outcome:'unknown',receipt:{},evidenceRef:input.evidenceRef});
    }
    const response = {ok:true,version:'0.1.0',...result};
    if (hostIssue) { response.ok=false; response.hostError=hostIssue; }
    if (result.action && !result.needsReconciliation) response.hostCall = hostCallFor(result.action, result.project);
    console.log(JSON.stringify(response, null, 2));
    return hostIssue ? 1 : 0;
  } catch (error) {
    console.log(JSON.stringify({ok:false,error:{code:error.code ?? 'INTERNAL',message:error.message}}, null, 2));
    return error.code ? 2 : 1;
  } finally { app?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
