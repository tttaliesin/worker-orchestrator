import { createHash } from 'node:crypto';

const THINKING = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const RESULT_STATUSES = new Set(['running', 'waiting_approval', 'waiting_input', 'completed', 'failed', 'unknown']);
const VERIFICATION_STATUSES = new Set(['passed', 'failed', 'not_run', 'unknown']);

export class HostContractError extends Error {
  constructor(code, message) { super(message); this.name = 'HostContractError'; this.code = code; }
}

function isNonemptyText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function requireText(value, field) {
  if (!isNonemptyText(value)) throw new HostContractError('HOST_CONTRACT', `${field} must be nonempty text`);
  return value;
}

export function unwrapHostResult(raw) {
  if (!raw || typeof raw !== 'object') throw new HostContractError('HOST_CONTRACT', 'A host tool result object is required');
  if (raw.isError === true) throw new HostContractError('HOST_ERROR', 'The host tool reported an error; inspect its evidence before retrying');
  if (raw.structuredContent && typeof raw.structuredContent === 'object') return raw.structuredContent;
  if (Array.isArray(raw.content)) {
    const blocks = raw.content.filter(x => x.type === 'text' && typeof x.text === 'string');
    for (const block of blocks) {
      try { const parsed = JSON.parse(block.text); if (parsed && typeof parsed === 'object') return parsed; } catch {}
    }
    throw new HostContractError('HOST_CONTRACT', 'No structured JSON was returned by the host tool');
  }
  return raw;
}

export function capabilityDescription() {
  return {
    adapter: 'codex-desktop', protocolVersion: 1, execution: 'controller-mediated',
    requiredTools: ['list_projects', 'create_thread', 'send_message_to_thread', 'wait_threads', 'read_thread', 'set_thread_archived'],
    optionalTools: ['list_threads'],
    projectTarget: 'existing-project-local-checkout',
    model: { requestField: 'model', reasoningField: 'thinking', supportedThinking: [...THINKING], catalog: 'host-provided', appliedSettings: 'require-host-evidence' },
    permissions: 'Direct human authorization and host policy govern every conversation mutation',
    supports: ['create', 'send', 'archive', 'unarchive', 'wait', 'observe'],
    limitations: ['No private Desktop API or database access', 'No automatic approval decisions', 'No background wakeup guarantee', 'No nested worker creation in this MVP']
  };
}

export function validateProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new HostContractError('MODEL_SETTINGS', 'An execution profile is required');
  requireText(profile.model, 'profile.model');
  if (!THINKING.has(profile.thinking)) throw new HostContractError('MODEL_SETTINGS', 'Unsupported reasoning effort');
  return profile;
}

export function hostCallFor(action, project = {}) {
  if (!action) return null;
  if (action.status === 'unknown' || action.outcome === 'unknown') return null;
  const worker = action.workerRef;
  const ref = () => ({ threadId: requireText(worker?.threadId, 'workerRef.threadId'), ...(worker.hostId ? {hostId: worker.hostId} : {}) });
  const settings = () => {
    const profile = validateProfile(action.profile);
    return { ...(profile.model ? {model: requireText(profile.model, 'profile.model')} : {}), ...(profile.thinking ? {thinking: profile.thinking} : {}) };
  };
  const workerPrompt = () => [
    `작업 실행: ${action.taskId}`,
    `runId: ${action.runId}`,
    `프로젝트 작업 범위: ${action.projectRoot ?? project.projectRoot ?? '(등록된 프로젝트 범위)'}`,
    '사용자가 위임한 요청 범위에서 작업하세요. 승인·사용자 답변 대기는 호스트 절차를 따르세요.',
    '최종 응답에 이 runId, 결과, 실제 검증 증거, 미처리 요청을 명시하세요.',
    '추가 대화를 만들거나 다른 대화에 메시지를 보내거나 스스로 보관하지 마세요.',
    '', requireText(action.prompt, 'action.prompt')
  ].join('\n');
  switch (action.type) {
    case 'create': return { tool: 'mcp__codex_app__create_thread', arguments: {
      target: {type: 'project', projectId: requireText(action.hostProjectId ?? project.hostProjectId, 'hostProjectId'), environment: {type: 'local'}},
      title: `worker-orchestrator · ${action.taskId}`.slice(0, 160), prompt: workerPrompt(), ...settings()
    }};
    case 'send': return { tool: 'mcp__codex_app__send_message_to_thread', arguments: {...ref(), prompt: workerPrompt(), ...settings()} };
    case 'archive': return { tool: 'mcp__codex_app__set_thread_archived', arguments: {...ref(), archived: true, source: 'codex'} };
    case 'unarchive': return { tool: 'mcp__codex_app__set_thread_archived', arguments: {...ref(), archived: false, source: 'codex'} };
    default: throw new HostContractError('HOST_CONTRACT', `Unknown action type: ${action.type}`);
  }
}

export function receiptFromHost(action, raw) {
  if (!action) throw new HostContractError('HOST_CONTRACT', 'There is no pending action');
  const payload = unwrapHostResult(raw);
  const queued = Object.hasOwn(payload, 'clientThreadId');
  const hasArchiveState = Object.hasOwn(payload, 'archived');
  if (action.type === 'create') {
    if (hasArchiveState || Object.hasOwn(payload, 'turnId')) {
      throw new HostContractError('HOST_CONTRACT', 'Create requires a creation acknowledgement');
    }
    if (queued && payload.threadId == null) {
      return {outcome: 'unknown', receipt: {clientThreadId: requireText(payload.clientThreadId, 'clientThreadId')}};
    }
    const hostId = requireText(payload.hostId, 'hostId');
    if (action.controllerRef?.hostId && hostId !== action.controllerRef.hostId) throw new HostContractError('WORKER_MISMATCH', 'Created worker belongs to a different host');
    return {outcome: 'succeeded', receipt: {workerRef: {threadId: requireText(payload.threadId, 'threadId'), hostId}}};
  }
  if (queued || (action.type === 'send' && (hasArchiveState || Object.hasOwn(payload, 'hostId')))) {
    throw new HostContractError('HOST_CONTRACT', 'Host acknowledgement does not match the requested action');
  }
  const threadId = requireText(payload.threadId, 'threadId');
  const expected = requireText(action.workerRef?.threadId, 'workerRef.threadId');
  if (threadId !== expected) throw new HostContractError('WORKER_MISMATCH', 'Host result belongs to a different conversation');
  if (payload.hostId && action.workerRef.hostId && payload.hostId !== action.workerRef.hostId) throw new HostContractError('WORKER_MISMATCH', 'Host result belongs to a different host');
  if (action.type === 'archive' || action.type === 'unarchive') {
    const archived = action.type === 'archive';
    if (payload.archived !== archived) throw new HostContractError('HOST_CONTRACT', 'Host archive acknowledgement does not match the requested state');
    return {outcome: 'succeeded', receipt: {workerRef: action.workerRef, archived}};
  }
  if (action.type === 'send') {
    return {outcome: 'succeeded', receipt: {workerRef: action.workerRef, ...(payload.turnId ? {turnId: payload.turnId} : {})}};
  }
  throw new HostContractError('HOST_CONTRACT', 'Unsupported receipt type');
}

function hasExactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function readFinalResult(message, turnId, runId) {
  if (!isNonemptyText(message?.text)
    || (message.phase != null && message.phase !== 'final_answer')
    || (message.turnId != null && message.turnId !== turnId)) return;

  let result;
  try {
    result = JSON.parse(message.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch {
    return;
  }
  if (!hasExactKeys(result, ['runId', 'status', 'summary', 'verification', 'pendingRequests'])
    || !isNonemptyText(result.runId) || result.runId !== runId
    || !RESULT_STATUSES.has(result.status) || !isNonemptyText(result.summary)) return;

  const { verification, pendingRequests } = result;
  if (!hasExactKeys(verification, ['status', 'evidenceRefs']) || !VERIFICATION_STATUSES.has(verification.status)
    || !Array.isArray(verification.evidenceRefs) || !verification.evidenceRefs.every(isNonemptyText)) return;
  if (!Array.isArray(pendingRequests) || (result.status.startsWith('waiting_') && pendingRequests.length === 0)
    || !pendingRequests.every(request => hasExactKeys(request, ['id', 'kind', 'summary'])
      && isNonemptyText(request.id) && (request.kind === 'approval' || request.kind === 'input')
      && isNonemptyText(request.summary))) return;
  return result;
}

export function observationFromWait(raw, workerRef, runId, evidenceRef) {
  const payload = unwrapHostResult(raw);
  const poll = payload.polls?.find(x => x.thread?.id === workerRef.threadId && (!workerRef.hostId || !x.thread.hostId || x.thread.hostId === workerRef.hostId));
  if (!poll) throw new HostContractError('HOST_CONTRACT', 'Wait result does not contain the selected worker');
  const turn = poll.latestTurn;
  const flags = poll.thread.status?.activeFlags ?? [];
  const flagNames = flags.map(x => typeof x === 'string' ? x : x.type);
  let status = 'unknown';
  if (flagNames.some(x => /approval/i.test(x))) status = 'waiting_approval';
  else if (flagNames.some(x => /input|question/i.test(x))) status = 'waiting_input';
  else if (turn?.status === 'completed') status = 'completed';
  else if (turn?.status === 'failed' || turn?.status === 'interrupted') status = 'failed';
  else if (poll.thread.status?.type === 'active' || turn?.status === 'inProgress') status = 'running';
  const message = poll.latestAssistantMessage;
  // A previous finished turn is still visible immediately after a new dispatch.
  // Bind completion to the run carried by the worker's structured final result.
  let finalResult;
  if (status === 'completed' || status === 'failed') {
    const hostFailed = status === 'failed';
    finalResult = readFinalResult(message, turn?.id, runId);
    if (!finalResult) status = 'unknown';
    else if (finalResult.pendingRequests.length) {
      status = finalResult.pendingRequests[0].kind === 'approval' ? 'waiting_approval' : 'waiting_input';
    } else status = hostFailed ? 'failed' : finalResult.status;
  }
  const waitId = status.startsWith('waiting_')
    ? finalResult?.pendingRequests[0]?.id ?? `codex:${turn?.id ?? runId}:${status}`
    : undefined;
  const result = status === 'completed' || status === 'failed'
    ? {success: status === 'completed' && !turn?.error, summary: message.text}
    : undefined;
  const hostCursor = poll.cursor;
  const hostTurnId = turn?.id ?? null;
  // The same host cursor can carry a compact snapshot or the final message.
  const evidenceKey = [runId, workerRef.hostId, workerRef.threadId, hostCursor, hostTurnId,
    status, waitId, result?.success, finalResult ? message.text : null];
  const eventId = `codex:${createHash('sha256').update(JSON.stringify(evidenceKey)).digest('hex')}`;
  return {runId, eventId, status, evidenceRef,
    ...(waitId ? {waitId} : {}), ...(result ? {result} : {}), hostCursor, hostTurnId};
}
