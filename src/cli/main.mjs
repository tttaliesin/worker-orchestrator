#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { Orchestrator } from '../core/orchestrator.mjs';
import { SCHEMA_VERSION } from '../state/sqlite-store.mjs';
import { capabilityDescription, hostCallFor, receiptFromHost, observationFromWait, validateProfile } from '../adapters/codex-desktop/index.mjs';
import { assessControllerCandidate, resolveControllerScope, validateProjectBinding } from '../adapters/codex-desktop/controller-candidate.mjs';

const commands = ['candidate', 'project', 'sync-project', 'dispatch', 'record', 'observe', 'resolve', 'verify', 'evaluate', 'accept', 'archive', 'status'];

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

export function main(argv = process.argv.slice(2), packagedVersion) {
  let app;
  try {
    const opts = options(argv);
    const version = packagedVersion ?? JSON.parse(
      fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    ).version;
    if (opts.command === '--version' || opts.command === 'version') { console.log(JSON.stringify({name:'worker-orchestrator',version,schemaVersion:SCHEMA_VERSION})); return 0; }
    if (opts.command === '--help' || !opts.command) { console.log(JSON.stringify({usage:'node dist/cli.mjs <command> --state-dir <absolute-directory> --input <json-file|->',commands:[...commands, 'capabilities'],hostExecution:'The authorized controller performs returned hostCall, then records the real result.'})); return 0; }
    if (opts.command === 'capabilities') { console.log(JSON.stringify({ok:true,...capabilityDescription()})); return 0; }
    if (!commands.includes(opts.command)) throw Object.assign(new Error(`Unknown command: ${opts.command}`),{code:'INPUT'});
    if (!opts['--input']) throw Object.assign(new Error('--input is required'),{code:'INPUT'});
    let input = JSON.parse(fs.readFileSync(opts['--input'] === '-' ? 0 : opts['--input'], 'utf8').replace(/^\uFEFF/, ''));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('Input must be a JSON object'),{code:'INPUT'});
    if (opts.command === 'dispatch') validateProfile(input.profile);
    const threadId = process.env.CODEX_THREAD_ID?.trim();
    const hostId = process.env.CODEX_HOST_ID?.trim() || null;
    let caller = threadId ? { threadId, hostId } : null;
    const stateDir = opts['--state-dir'] ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'), 'WorkerOrchestrator', 'state');
    if (!path.isAbsolute(stateDir)) throw Object.assign(new Error('--state-dir must be absolute'),{code:'INPUT'});
    if (opts.command === 'candidate') {
      if (Object.hasOwn(input, 'claim') && typeof input.claim !== 'boolean') {
        throw Object.assign(new Error('claim must be a boolean.'), {code:'INPUT'});
      }
      if (Object.hasOwn(input, 'includeStatus') && typeof input.includeStatus !== 'boolean') {
        throw Object.assign(new Error('includeStatus must be a boolean.'), {code:'INPUT'});
      }
      const scope = threadId ? resolveControllerScope(input.projectRoot ?? process.cwd()) : null;
      let result = { decision: 'undetermined', reason: threadId ? 'SCOPE_UNAVAILABLE' : 'MISSING_CURRENT_THREAD',
        claimed: false, project: null };
      if (scope) {
        app = new Orchestrator(stateDir);
        const request = { ...scope, caller, claim: input.claim ?? false, includeStatus: input.includeStatus ?? false };
        result = app.execute('candidate', request);
        if (result.reason === 'DISCOVERY_REQUIRED' && (Object.hasOwn(input, 'threadPages') || Object.hasOwn(input, 'projects'))) {
          const assessment = assessControllerCandidate(scope, threadId, hostId, input.projects, input.threadPages);
          result = app.execute('candidate', { ...request, assessment });
        }
      }
      console.log(JSON.stringify({ ok: true, version, ...result }, null, 2));
      return 0;
    }
    app = new Orchestrator(stateDir);
    if (opts.command === 'sync-project') {
      const { project } = app.execute('status', { projectId: input.projectId });
      input = validateProjectBinding(project, caller, input.projects, input.threadPages);
      // Desktop shells may only export CODEX_THREAD_ID.
      caller = { ...caller, hostId: input.hostId };
    }
    let hostIssue;
    let readThread;
    const recordingHostResult = opts.command === 'record' && Object.hasOwn(input, 'hostResult');
    if (recordingHostResult) {
      if (input.outcome === 'rejected') throw Object.assign(new Error(
        'Record confirmed rejection with outcome and evidenceRef, without hostResult'), {code:'INPUT'});
      const {recordAction} = app.execute('status', {
        projectId:input.projectId, taskId:input.taskId, actionId:input.actionId
      });
      let normalized;
      try { normalized = receiptFromHost(recordAction, input.hostResult); }
      catch (error) {
        hostIssue = {code:error.code ?? 'HOST_CONTRACT',message:error.message};
        normalized = {outcome:'unknown',receipt:{}};
      }
      if (!hostIssue && input.outcome && input.outcome !== normalized.outcome) throw Object.assign(new Error('Host result and requested outcome disagree'),{code:'HOST_CONTRACT'});
      Object.assign(input, normalized);
      delete input.hostResult;
    }
    if (opts.command === 'observe') {
      const hasWaitResult = Object.hasOwn(input, 'hostResult');
      const hasReadResult = Object.hasOwn(input, 'readThreadResult');
      let readBack;
      if (hasReadResult || Object.hasOwn(input, 'readThreadEvidenceRef')) {
        if (!hasReadResult || !hasWaitResult || typeof input.readThreadEvidenceRef !== 'string'
          || !input.readThreadEvidenceRef.trim()) {
          throw Object.assign(new Error('Read recovery requires hostResult, readThreadResult, and readThreadEvidenceRef'), {code:'INPUT'});
        }
        readBack = {hostResult: input.readThreadResult, evidenceRef: input.readThreadEvidenceRef};
      }
      if (hasWaitResult) {
        const snapshot = app.execute('status', {projectId:input.projectId,taskId:input.taskId});
        const workerRef = snapshot.task?.workerRef ?? snapshot.task?.worker;
        if (!workerRef) throw Object.assign(new Error('No worker is bound to this task'),{code:'WORKER_MISMATCH'});
        const {readThread: lookup, ...observation} = observationFromWait(
          input.hostResult, workerRef, input.runId, input.evidenceRef, readBack);
        readThread = lookup;
        Object.assign(input, observation);
        delete input.hostResult;
        delete input.readThreadResult;
        delete input.readThreadEvidenceRef;
      }
    }
    let result;
    try { result = app.execute(opts.command, input, caller); }
    catch (error) {
      if (!recordingHostResult || input.outcome !== 'succeeded'
        || !['WORKER_IDENTITY_CONFLICT', 'INVALID_RECEIPT'].includes(error.code)) throw error;
      // The call may already have had an external effect even when the local
      // domain rejects its receipt (e.g. duplicate worker identity).
      hostIssue = {code:error.code ?? 'HOST_CONTRACT',message:error.message};
      result = app.execute('record', {projectId:input.projectId,taskId:input.taskId,actionId:input.actionId,outcome:'unknown',receipt:{},evidenceRef:input.evidenceRef}, caller);
    }
    const response = {ok:true,version,...result};
    if (hostIssue) { response.ok=false; response.hostError=hostIssue; }
    if (result.action && !result.needsReconciliation) response.hostCall = hostCallFor(result.action, result.project);
    if (readThread && (result.needsReconciliation || result.task.hostStatus?.startsWith('waiting_'))) {
      response.hostCall = {tool:'mcp__codex_app__read_thread', arguments:readThread};
    }
    console.log(JSON.stringify(response, null, 2));
    return hostIssue ? 1 : 0;
  } catch (error) {
    console.log(JSON.stringify({ok:false,error:{code:error.code ?? 'INTERNAL',message:error.message}}, null, 2));
    return error.code ? 2 : 1;
  } finally { app?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
