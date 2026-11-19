import { createHash } from 'node:crypto';

const THINKING = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const RESULT_STATUSES = new Set(['running', 'waiting_approval', 'waiting_input', 'completed', 'failed', 'unknown']);
const VERIFICATION_STATUSES = new Set(['passed', 'failed', 'not_run', 'unknown']);
const TERMINAL_TURN_STATUSES = new Set(['completed', 'failed', 'interrupted']);
const JSON_DECODE_FAILED = Symbol('JSON_DECODE_FAILED');

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
    return JSON_DECODE_FAILED;
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

function decodeObservationEnvelope(raw) {
  // The built-in Desktop tools can return a serialized JSON snapshot.
  return typeof raw === 'string' ? unwrapHostResult({content: [{type: 'text', text: raw}]}) : raw;
}

function recoverFinalResult(readBack, workerRef, correlation, runId) {
  if (!isNonemptyText(readBack?.evidenceRef)) return;

  let payload;
  try {
    payload = unwrapHostResult(decodeObservationEnvelope(readBack.hostResult));
  } catch {
    return;
  }
  const {thread, turns} = payload;
  if (thread?.id !== workerRef.threadId || thread?.hostId !== workerRef.hostId || payload.truncated === true
    || !Array.isArray(turns) || turns.length !== 1) return;

  const [turn] = turns;
  if (!isNonemptyText(turn?.id) || !TERMINAL_TURN_STATUSES.has(turn.status)
    || (correlation.turnId != null && turn.id !== correlation.turnId)
    || (correlation.turnStatus != null && turn.status !== correlation.turnStatus) || turn.truncated === true
    || !Array.isArray(turn.items)) return;

  const messages = turn.items.filter(item => correlation.messageId != null
    ? item?.id === correlation.messageId
    : item?.type === 'agentMessage' && item.phase === 'final_answer');
  const [message] = messages;
  if (messages.length !== 1 || message.type !== 'agentMessage' || message.phase !== 'final_answer'
    || !isNonemptyText(message.id) || message.truncated === true) return;

  const result = readFinalResult(message, turn.id, runId);
  const activeFlags = thread.status?.activeFlags ?? [];
  if (!result || result === JSON_DECODE_FAILED || !Array.isArray(activeFlags)) return;
  return {turn, message, result, activeFlags};
}

function readWaitingFlag(flag) {
  const type = typeof flag === 'string' ? flag : flag?.type;
  if (typeof type !== 'string') return;

  let kind;
  if (/approval/i.test(type)) kind = 'approval';
  else if (/input|question/i.test(type)) kind = 'input';
  else return;

  const id = [flag?.requestId, flag?.id].find(value => isNonemptyText(value) || Number.isFinite(value));
  return {kind, waitId: id === undefined ? undefined : String(id)};
}

function normalizeWaits(pendingRequests, flags, turnOrRunId) {
  const waits = pendingRequests.map(({id, kind}) => ({waitId: id, kind}));
  const hostWaits = flags.map(readWaitingFlag).filter(Boolean);
  // A flag without an ID only establishes that a wait of this kind exists.
  const representedKinds = new Set([...waits, ...hostWaits.filter(wait => wait.waitId)].map(wait => wait.kind));
  for (const {kind, waitId} of hostWaits) {
    if (waitId) {
      if (!waits.some(wait => wait.kind === kind && wait.waitId === waitId)) waits.push({waitId, kind});
    } else if (!representedKinds.has(kind)) {
      waits.push({waitId: `codex:${turnOrRunId}:waiting_${kind}`, kind, anonymous: true});
      representedKinds.add(kind);
    }
  }
  return waits;
}

export function observationFromWait(raw, workerRef, runId, evidenceRef, readBack) {
  const envelope = decodeObservationEnvelope(raw);
  const hasRegisteredWorker = isNonemptyText(workerRef.threadId) && isNonemptyText(workerRef.hostId);
  const waitFailed = hasRegisteredWorker && envelope?.isError === true;
  const payload = waitFailed ? {} : unwrapHostResult(envelope);
  const workerPolls = payload.polls?.filter(poll => poll?.thread?.id === workerRef.threadId) ?? [];
  const normalPoll = workerPolls.find(poll => poll.thread.hostId === workerRef.hostId)
    ?? workerPolls.find(poll => !poll.thread.hostId);
  // A poll under a different host can supply correlation keys for a read on the registered host.
  const poll = normalPoll ?? (workerPolls.length === 1 ? workerPolls[0] : undefined);
  const compactTurn = poll?.latestTurn;
  const compactMessage = poll?.latestAssistantMessage;
  const compactTurnId = compactTurn?.id;
  // A previous finished turn is still visible immediately after a new dispatch.
  // Bind worker requests and results to the current run before using either.
  const compactResult = normalPoll ? readFinalResult(compactMessage, compactTurnId ?? null, runId) : undefined;
  const terminal = TERMINAL_TURN_STATUSES.has(compactTurn?.status);
  const brokenCompact = compactResult === JSON_DECODE_FAILED && terminal
    && isNonemptyText(compactTurnId) && compactMessage.turnId === compactTurnId && isNonemptyText(compactMessage.id)
    && (poll.latestAssistantMessageId == null || poll.latestAssistantMessageId === compactMessage.id);
  const targetFailed = workerPolls.length === 0 && Array.isArray(payload.errors) && payload.errors.some(error =>
    error?.threadId === workerRef.threadId && error.hostId === workerRef.hostId && isNonemptyText(error.message));
  const alternateHost = poll && !normalPoll;
  const canRecover = hasRegisteredWorker && (waitFailed || targetFailed || alternateHost || brokenCompact);
  if (!normalPoll && !canRecover) throw new HostContractError('HOST_CONTRACT', 'Wait result does not contain the selected worker');

  // A running turn may finish before the original is read. Its commentary ID is not a final message ID.
  const finalMessageKey = compactMessage?.phase === 'final_answer' || (terminal && compactMessage?.phase == null);
  const messageTurnId = finalMessageKey ? compactMessage?.turnId : undefined;
  const messageId = finalMessageKey ? poll.latestAssistantMessageId ?? compactMessage?.id : undefined;
  const correlation = {
    turnId: compactTurnId ?? messageTurnId,
    turnStatus: terminal ? compactTurn.status : undefined,
    messageId
  };
  const consistentKeys = (compactTurnId == null || messageTurnId == null || compactTurnId === messageTurnId)
    && (compactMessage?.id == null || messageId == null || compactMessage.id === messageId);
  const readThread = canRecover && readBack === undefined
    ? {threadId: workerRef.threadId, hostId: workerRef.hostId, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 12000}
    : undefined;
  const recovered = canRecover && consistentKeys ? recoverFinalResult(readBack, workerRef, correlation, runId) : undefined;
  const finalResult = recovered?.result ?? (compactResult === JSON_DECODE_FAILED ? undefined : compactResult);
  const message = recovered?.message ?? (normalPoll ? compactMessage : undefined);
  const turn = recovered?.turn ?? (normalPoll ? compactTurn : undefined);
  const hostTurnId = recovered?.turn.id ?? compactTurnId ?? null;
  const threadStatus = normalPoll?.thread.status;
  const hostCursor = normalPoll?.cursor;
  const flags = [...(threadStatus?.activeFlags ?? []), ...(recovered?.activeFlags ?? [])];
  const waits = normalizeWaits(finalResult?.pendingRequests ?? [], flags, hostTurnId ?? runId);
  const firstWait = waits[0];

  let status = 'unknown';
  if (firstWait) status = `waiting_${firstWait.kind}`;
  else if (turn?.status === 'completed') status = finalResult?.status ?? 'unknown';
  else if (TERMINAL_TURN_STATUSES.has(turn?.status)) {
    if (finalResult) status = 'failed';
  } else if (threadStatus?.type === 'active' || turn?.status === 'inProgress') status = 'running';

  const result = status === 'completed' || status === 'failed'
    ? {success: status === 'completed' && !turn?.error, summary: message.text}
    : undefined;
  // Correlated reads identify a message across cursor and host alias changes.
  const snapshotKey = canRecover
    ? ['read_thread', recovered?.turn.id ?? correlation.turnId, recovered?.turn.status ?? correlation.turnStatus,
      recovered?.message.id ?? correlation.messageId]
    : [hostCursor, hostTurnId];
  const evidenceKey = [runId, workerRef.hostId, workerRef.threadId, ...snapshotKey,
    status, firstWait ? waits : undefined, result?.success, finalResult ? message.text : null];
  const eventId = `codex:${createHash('sha256').update(JSON.stringify(evidenceKey)).digest('hex')}`;
  return {runId, eventId, status, evidenceRef: recovered ? readBack.evidenceRef : evidenceRef,
    ...(firstWait ? {waitId: firstWait.waitId, waits} : {}), ...(result ? {result} : {}),
    ...(readThread ? {readThread} : {}), hostCursor, hostTurnId};
}
