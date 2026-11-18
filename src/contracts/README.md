# 공통 명령 계약

CLI 형식은 `node <설치 루트>/dist/cli.mjs <command> --state-dir <절대 경로> --input <JSON 파일>`입니다.
JSON을 stdin으로 전달할 때는 `--input -`를 사용합니다.
모든 상태 변경은 `projectId`로 범위를 제한합니다.
CLI는 대화 도구 호출 계획을 출력하고 실제 호스트 호출은 컨트롤러가 수행합니다.

`project` 입력은 `projectId`, `projectRoot`, `hostProjectId`, `controller: {threadId, hostId}`, `authorization: {createWorkers, sendFollowups, archiveCompleted, restoreWorkers, source}`를 받습니다.
`dispatch` 입력은 `projectId`, `taskId`, `requestId`, `prompt`, `profile: {model, thinking}`를 받습니다.
`record` 입력은 `projectId`, `taskId`, `actionId`, `outcome`과 `receipt`, `evidenceRef`를 받습니다.
`record`에 Codex 도구의 원문 `hostResult`를 주면 CLI의 호스트 어댑터가 receipt로 변환합니다.
`observe` 입력은 `projectId`, `taskId`, `runId`, `eventId`, `status`, `evidenceRef`를 받습니다.
status는 `running`, `waiting_approval`, `waiting_input`, `completed`, `failed`, `unknown`입니다.
대기 시 `waitId`, 완료 시 `result: {success, summary}`를 포함합니다.
`resolve` 입력은 `projectId`, `taskId`, `runId`, `waitId`, `evidenceRef`를 받습니다.
`verify` 입력은 `projectId`, `taskId`, `runId`, `status: passed|failed`, `evidenceRefs`를 받습니다.
검증 대상 결과의 `task.result.eventId`를 `resultEventId`로 전달할 수 있습니다.
같은 실행에서 종료 결과가 교체되면 새 결과의 `resultEventId`가 필요합니다.
`accept`와 `archive` 입력은 `projectId`, `taskId`, `runId`를 받습니다.
`status` 입력은 `projectId`와 선택적인 `taskId`를 받습니다.
`capabilities`는 입력이 필요 없습니다.

반환값의 `action`이 있으면 `id`, `type`, `projectId`, `taskId`, `runId`, `profile`, `prompt`, `workerRef`, `hostProjectId`를 포함합니다.
action type은 `create`, `send`, `unarchive`, `archive`입니다.
기록 성공 뒤 다음 행동이 있으면 새 action을 반환합니다.
성공 receipt는 생성 시 `workerRef: {threadId, hostId}`를 포함합니다.
보관과 복원 receipt는 `archived: true|false`와 동일한 `workerRef`를 포함합니다.
실패가 불명확한 호스트 호출은 `outcome: unknown`으로 기록하고 확인 전 재전송하지 않습니다.
복원이 확인됐을 때 후속 전달 권한이 철회된 상태면 복원은 기록하고 전달을 보류합니다.
전달 권한을 다시 확보한 뒤 같은 `dispatch` 입력으로 전달 계획을 받습니다.
