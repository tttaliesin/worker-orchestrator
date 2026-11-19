# 설치된 CLI 사용법

Node.js 24 이상에서 설치 루트의 `dist/cli.mjs`를 실행합니다.
다음 형식은 모든 상태 명령에 공통입니다.

```text
node <설치 루트>/dist/cli.mjs <command> --state-dir <절대 경로> --input <JSON 파일>
node <설치 루트>/dist/cli.mjs <command> --state-dir <절대 경로> --input -
node <설치 루트>/dist/cli.mjs capabilities
```

`--input -`는 stdin의 JSON 객체를 읽습니다.
`--state-dir`를 생략하면 Windows에서 `%LOCALAPPDATA%/WorkerOrchestrator/state`를 사용합니다.
설치 검증은 항상 임시 절대 경로를 `--state-dir`로 지정합니다.
상태 명령이 기존 v1 SQLite 데이터베이스를 열면 저장된 기록을 보존하며 v2를 적용합니다.
CLI는 JSON 결과를 stdout으로 출력합니다.
오류는 `ok: false`와 종료 코드로 확인합니다.

다음 입력의 예시 식별자는 실제 식별자로 바꿉니다.
`projectRoot`는 존재하는 작업 디렉터리의 절대 경로여야 합니다.
`hostProjectId`에는 이미 등록된 Desktop 프로젝트 ID를 사용합니다.
기존 부모 프로젝트와 하위 저장소 작업 범위를 함께 사용할 수 있습니다.
새 Desktop 프로젝트 등록은 필요하지 않습니다.

`project`는 다음 객체를 받습니다.
네 권한의 `true`는 각각 해당 범위의 직접적인 사용자 허가가 있을 때만 기록합니다.
`source`에는 실제 허가의 출처를 남깁니다.

```json
{
  "projectId": "example",
  "projectRoot": "C:/work/example",
  "hostProjectId": "existing-desktop-project-id",
  "controller": { "threadId": "actual-controller-thread", "hostId": "local" },
  "authorization": {
    "createWorkers": true,
    "sendFollowups": true,
    "archiveCompleted": true,
    "restoreWorkers": true,
    "source": "직접적인 사용자 허가의 실제 출처와 작업 범위"
  }
}
```

`dispatch`는 다음 객체를 받습니다.
새 작업의 요청에는 새 `requestId`를 사용합니다.
동일 요청의 재조회에는 동일한 입력과 `requestId`를 사용합니다.
동일한 계획이 반환되어도 호스트 작업을 중복 실행하지 않습니다.

```json
{
  "projectId": "example",
  "taskId": "review",
  "requestId": "review-1",
  "prompt": "허용된 파일을 검토하고 지정된 검증을 실행하세요.",
  "profile": { "model": "host-supported-model", "thinking": "high" }
}
```

반환된 `action.id`가 이후 기록의 `actionId`입니다.
반환된 `action.runId`가 해당 실행의 식별자입니다.
`hostCall`은 컨트롤러가 실행할 도구와 인수의 계획입니다.
현재 도구 메타데이터가 실제 입력과 권한을 결정합니다.
워커 프롬프트에 해당 `runId`와 설치된 worker 스킬 경로를 전달합니다.

실제 호스트 호출 후 `record`로 결과를 기록합니다.
기록 응답을 받지 못했으면 같은 `actionId`와 `hostResult`로 `record`를 다시 호출합니다.
복원 기록을 다시 제출하면 아직 결과가 기록되지 않은 후속 `send`의 기존 action ID를 받을 수 있습니다.
다음 예시는 원문 호스트 결과를 `host-result.json`에 보존한 경우입니다.

```powershell
$InputObject = @{
  projectId = 'example'
  taskId = 'review'
  actionId = $Plan.action.id
  hostResult = Get-Content -Raw -LiteralPath './host-result.json' | ConvertFrom-Json
  evidenceRef = 'host-result.json'
}
$InputObject | ConvertTo-Json -Depth 40 -Compress |
  node "$InstalledRoot/dist/cli.mjs" record --state-dir $StateDir --input -
```

`$InstalledRoot`와 `$StateDir`는 사용자가 선택한 절대 경로입니다.
`$Plan`은 실제 `dispatch` 또는 이전 `record`의 JSON 응답입니다.
`hostResult` 대신 계약에 맞는 `outcome`과 `receipt`를 사용할 수 있습니다.
생성 성공 receipt에는 실제 `workerRef: {threadId, hostId}`가 필요합니다.
보관·복원 receipt에는 동일한 `workerRef`와 `archived: true|false`가 필요합니다.
결과를 모르면 `outcome: unknown`과 실제 근거를 기록합니다.
불명확한 생성은 확인 전에 다시 보내지 않습니다.
생성 전에 도구가 요청을 확정 거절했다는 증거를 확보하면 같은 action을 `outcome: rejected`와 `evidenceRef`로 기록합니다.
이 입력에는 `hostResult`와 성공 receipt를 생략합니다.
상태가 `rejected`가 되면 같은 `taskId`에 새 `requestId`와 수정한 입력으로 `dispatch`합니다.
일반 오류와 시간 초과는 생성 여부를 확인할 때까지 대조 대기로 유지합니다.

진행은 공식 `wait_threads`로 관찰합니다.
세부 근거가 필요하면 `read_thread`를 사용합니다.
다음은 정규화한 `observe` 입력입니다.

```json
{
  "projectId": "example",
  "taskId": "review",
  "runId": "actual-current-run-id",
  "eventId": "actual-event-id",
  "status": "completed",
  "result": { "success": true, "summary": "실제 워커 결과 요약" },
  "evidenceRef": "실제 관찰 근거"
}
```

공식 wait 응답은 `status`와 `eventId` 대신 원문 `hostResult`로 전달할 수도 있습니다.
호출에 실패한 경우 컨트롤러는 `isError: true`인 응답도 `hostResult`로 전달합니다.
같은 워커의 요약이 다른 호스트 ID를 반환하거나 최종 메시지의 JSON을 해석할 수 없을 때도 원문 조회를 계획할 수 있습니다.

1. `observe`가 `read_thread` 계획을 반환하면 `hostCall`의 인수로 등록된 호스트에서 원문을 조회하십시오.
2. 같은 `observe` 입력에 `readThreadResult`와 `readThreadEvidenceRef`를 추가해 다시 호출하십시오.

CLI는 등록된 호스트의 최종 응답에서 현재 `runId`를 확인합니다.
요약에 터미널 턴과 최종 메시지의 ID가 있으면 CLI는 원문 식별자와 대조합니다.
조회가 실패하거나 식별자가 다르면 CLI는 확인된 대기 상태나 미확인 상태를 유지합니다.

정규화한 입력을 직접 작성할 때 `eventId`는 같은 작업의 실행 전체에서 고유해야 합니다.
승인 대기는 `status: waiting_approval`과 `waitId`를 기록합니다.
사용자 입력 대기는 `status: waiting_input`과 `waitId`를 기록합니다.
대기 요청 여러 개를 직접 기록할 때는 `waits: [{waitId, kind}]`를 전달합니다.
첫 항목의 `kind`가 `approval`이면 `waiting_approval`을 사용하고, `input`이면 `waiting_input`을 사용합니다.
원문 wait 응답에 여러 요청이 있으면 한 관찰에서 함께 기록합니다.
각 요청의 실제 승인이나 답변을 확인한 뒤 `task.waits`에 반환된 해당 `waitId`를 `resolve`로 해제합니다.
호스트가 요청 ID 없이 대기 상태만 제공하면 재개가 관찰된 뒤 같은 턴에 생긴 대기를 새 요청으로 기록합니다.

다음 표는 나머지 명령의 정확한 입력입니다.
`p`, `t`, `r`는 각각 실제 `projectId`, `taskId`, `runId`입니다.

| command | JSON 입력 |
| --- | --- |
| `resolve` | `{"projectId":"p","taskId":"t","runId":"r","waitId":"actual-wait-id","evidenceRef":"실제 사용자 해결 근거"}` |
| `verify` | `{"projectId":"p","taskId":"t","runId":"r","resultEventId":"actual-result-event-id","status":"passed","evidenceRefs":["실제 검증 근거"]}` |
| `accept` | `{"projectId":"p","taskId":"t","runId":"r"}` |
| `archive` | `{"projectId":"p","taskId":"t","runId":"r"}` |
| `status` | `{"projectId":"p","taskId":"t"}` |

`verify.status`는 `passed` 또는 `failed`입니다.
통과에는 실제 검증 근거가 필요합니다.
`resultEventId`에는 검증을 시작할 때 관찰한 `task.result.eventId`를 넣습니다.
같은 실행의 종료 결과가 교체되면 현재 결과의 ID가 있어야 검증을 기록할 수 있습니다.
컨트롤러는 결과를 검토한 뒤 `accept`로 채택합니다.
그 다음 `archive`가 반환한 action을 공식 보관 도구로 실행합니다.
실제 보관 응답을 `record`에 기록해야 보관 상태가 확정됩니다.
승인이나 사용자 입력 대기가 남아 있으면 보관하지 않습니다.

후속 요청은 같은 `taskId`와 새 `requestId`로 `dispatch`합니다.
보관된 대화에서는 `unarchive` action이 먼저 반환됩니다.
후속 전달 권한이 있으면 복원 응답을 기록한 뒤 같은 대화의 `send` action이 반환됩니다.
복원 도중 후속 전달 권한이 철회되면 복원만 기록합니다.
전달 권한을 다시 확보한 뒤 같은 `requestId`와 입력으로 `dispatch`를 다시 호출합니다.
새 실행에는 새로운 검증과 채택이 필요합니다.
