# 워커 오케스트레이터 사용법

## 컨트롤러에 자연어로 요청하기

컨트롤러 대화에 이 프로젝트의 하위 대화 운영을 처음 한 번 맡기십시오.

> 이 프로젝트에서 필요하면 워커 대화를 열어 줘.
> 관련 작업은 같은 워커에 이어서 맡겨 줘.
> 보관된 워커가 다시 필요하면 복원해 줘.
> 검증이 끝나고 후속 작업이 없으면 워커를 보관해 줘.

컨트롤러는 사용자가 맡긴 동작과 그 출처를 프로젝트에 저장합니다.
이후에는 평소처럼 원하는 결과를 말하십시오.
필요하면 작업 범위, 완료 조건, 보고 형식을 함께 알리십시오.

- “오류 메시지를 점검해 줘.
  입력 검증 코드만 읽고, 문제가 재현되는 조건을 세 줄로 알려 줘.”
- “인증과 세션을 확인해서 로그인 실패 원인을 찾아 줘.
  기존 테스트로 원인을 확인하고 팀에 공유할 요약을 써 줘.”
- “지난 로그부터 이어서 재시도 가설을 확인해 줘.
  그 결론도 독립적으로 검토해 줘.”

컨트롤러는 현재 호스트에서 요청할 수 있는 모델과 thinking을 작업 복잡도에 맞춰 고릅니다.
범위가 좁고 빠른 확인에는 `medium`, 여러 구성 요소에 걸친 원인 분석에는 `high`, 서로 영향을 주는 가설을 검증할 때는 `xhigh`를 고려합니다.
실제 적용값은 호스트에서 확인된 경우에만 보고합니다.

컨트롤러는 작업을 나누고 실행 순서와 워커별 담당 범위를 정합니다.
후속 전달 권한이 확인되면 기존 워커에서 이전 근거를 이어서 조사합니다.
새 워커를 만들 권한이 확인되면 독립적인 검토를 별도 워커에게 맡길 수 있습니다.
완료 조건을 관찰 가능한 결과로 정하고 변경 내용이나 테스트 결과처럼 작업에 맞는 근거를 직접 확인합니다.
최종 보고의 길이와 상세 수준은 읽는 사람과 요청에 맞춥니다.

되돌릴 수 있는 가정은 밝혀 두고 작업을 진행합니다.
실제 승인이나 답변을 기다리는 동안 그 응답에 의존하지 않는 작업을 계속합니다.
사용자에게는 범위나 결과를 크게 바꾸는 결정, 직접 확인할 수 없는 정보, 필요한 승인만 요청합니다.

### 권한

워커 생성, 후속 메시지 전달, 보관, 복원은 각각 해당 프로젝트와 작업 범위에 대한 직접적인 사용자 허가가 필요합니다.
요청에 포함된 허가는 확인된 범위에서 사용합니다.
프로젝트 운영을 맡겼으면 컨트롤러는 이후 요청에도 저장된 허가를 사용합니다.
호스트 도구를 호출할 때는 실제 동작과 대상 대화가 그 허가에 포함되는지 확인합니다.
CLI는 실행 계획과 상태를 관리하고 컨트롤러가 현재 호스트 도구를 호출합니다.

## 설치된 CLI 사용법

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
상태 명령은 기존 SQLite 스키마 v1과 v2를 v3으로 갱신합니다.
CLI는 갱신할 때 프로젝트와 작업 기록을 보존합니다.
CLI는 JSON 결과를 stdout으로 출력합니다.
오류는 `ok: false`와 종료 코드로 확인합니다.

다음 입력의 예시 식별자는 실제 식별자로 바꿉니다.
`projectRoot`는 존재하는 작업 디렉터리의 절대 경로여야 합니다.

### 컨트롤러 조회와 확정

`candidate`는 런타임이 제공한 `CODEX_THREAD_ID`로 현재 대화를 식별합니다.
저장된 역할을 먼저 조회하려면 `projectRoot`만 보냅니다.
이미 등록된 컨트롤러는 보관 상태여도 우선합니다.
현재 대화가 이미 등록된 컨트롤러이면 `decision: "controller"`와 `project`, `claimed: false`가 반환됩니다.

```text
node <설치 루트>/dist/cli.mjs candidate --input - [--state-dir <절대 경로>]
```

```json
{ "projectRoot": "C:/work/example" }
```

`reason: "DISCOVERY_REQUIRED"`가 반환되면 다음 순서로 조회 근거를 모읍니다.

1. `list_projects`의 실제 응답 전체를 `projects`에 넣습니다.
2. `list_threads`를 `mode: "history"`, `source: "codex"`, `archived: false`로 호출합니다.
   호출 대화의 기본 호스트를 사용하거나 확인된 `hostId`를 지정합니다.
   첫 호출에서는 `cursor`를 생략합니다.
3. 각 요청의 커서와 응답을 `{ cursor, result }` 형식으로 `threadPages`에 순서대로 넣습니다.
   첫 항목의 `cursor`에는 `null`을 넣습니다.
   각 `result`에는 `threads`와 `nextCursor`가 들어 있는 실제 `list_threads` 응답 전체를 넣습니다.
   같은 호스트와 조회 조건을 유지하며 직전 응답의 `nextCursor`를 다음 요청의 `cursor`로 사용합니다.
   `nextCursor`가 `null`인 마지막 응답까지 포함합니다.
4. `projectRoot`, `projects`, `threadPages`를 함께 보내 후보를 조회합니다.

CLI는 같은 호스트에서 프로젝트 ID가 일치하는 대화를 셉니다.
Git으로 확인한 같은 저장소의 루트와 연결된 워크트리도 이 범위에 포함합니다.
부모 프로젝트에 함께 속한 저장소는 작업 경로로 구분합니다.
조건에 맞는 미보관 `notLoaded` 대화도 셉니다.

등록된 워커의 역할은 `worker`로 반환합니다.
기록이 중간에 끊기거나 소속이 불분명한 대화가 있으면 CLI는 확정을 보류합니다.

조건에 맞는 미보관 대화가 현재 대화뿐이면 `claim`을 생략한 조회는 `decision: "candidate"`를 반환합니다.
역할을 확정하려면 같은 입력을 `claim: true`와 함께 보냅니다.
등록 요청이 겹치면 CLI는 최초 등록을 유지합니다.
신규 등록 결과에는 `decision: "controller"`와 `project`, `claimed: true`가 포함됩니다.
이때 워커 생성, 후속 전달, 보관, 복원 권한은 모두 `false`로 저장됩니다.

### 프로젝트 등록과 작업 실행

`candidate`에서 `decision: "controller"`를 받으면 반환된 `project`의 식별자와 경로를 사용합니다.
권한 업데이트에 필요한 `projectId`, `projectRoot`, `hostProjectId`, `controller`를 그 결과에서 가져옵니다.
`hostProjectId`에는 이미 등록된 Desktop 프로젝트 ID를 사용합니다.
기존 부모 프로젝트와 하위 저장소 작업 범위를 함께 사용할 수 있습니다.
새 Desktop 프로젝트 등록은 필요하지 않습니다.

`project`는 다음 객체를 받습니다.
네 권한의 `true`는 각각 해당 범위의 직접적인 사용자 허가가 있을 때만 기록합니다.
`source`에는 실제 허가의 출처를 남깁니다.
이 프로젝트의 후속 작업에도 같은 권한을 허용했으면 `authorization.scope`에 `"project"`를 넣습니다.
특정 작업에 준 권한은 `scope`를 생략하고 그 작업의 범위에서만 사용합니다.
이미 등록된 컨트롤러가 이 입력을 실행해야 합니다.

```json
{
  "projectId": "example",
  "projectRoot": "C:/work/example",
  "hostProjectId": "existing-desktop-project-id",
  "controller": { "threadId": "actual-controller-thread", "hostId": "local" },
  "authorization": {
    "scope": "project",
    "createWorkers": true,
    "sendFollowups": true,
    "archiveCompleted": true,
    "restoreWorkers": true,
    "source": "직접적인 사용자 허가의 실제 출처와 작업 범위"
  }
}
```

이 권한은 같은 프로젝트의 후속 요청에서 사용합니다.
권한을 바꾸려면 등록된 컨트롤러에서 `project`를 다시 호출하고 사용자가 확인한 새 범위를 기록합니다.
일부 권한을 철회하려면 해당 값을 `false`로 저장합니다.
지속 운영을 끝내려면 `scope`를 빼고 현재 허가된 동작만 저장합니다.

`status`에 `projectId`만 전달하면 프로젝트의 작업과 워커를 조회합니다.
관련된 워커가 이미 등록돼 있으면 같은 `taskId`를 선택합니다.
그 워커만 재사용하려면 `dispatch`에 `reuseOnly: true`를 넣습니다.
선택한 작업에 워커 등록이 없으면 CLI는 `WORKER_NOT_FOUND`를 반환합니다.

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
| `accept` | `{"projectId":"p","taskId":"t","runId":"r","keepWorker":false}` |
| `archive` | `{"projectId":"p","taskId":"t","runId":"r"}` |
| `status` | `{"projectId":"p","taskId":"t"}` |

`verify.status`는 `passed` 또는 `failed`입니다.
통과에는 실제 검증 근거가 필요합니다.
`resultEventId`에는 검증을 시작할 때 관찰한 `task.result.eventId`를 넣습니다.
같은 실행의 종료 결과가 교체되면 현재 결과의 ID가 있어야 검증을 기록할 수 있습니다.
컨트롤러는 결과를 검토한 뒤 `accept`로 채택합니다.
현재 실행을 검증했고 후속 작업이 없으면 `accept`에 `keepWorker: false`를 넣습니다.
프로젝트 운영 권한에 보관이 포함되어 있으면 CLI는 채택과 함께 보관 계획을 반환합니다.
워커를 열어 두려면 `keepWorker: true`를 전달하거나 이 필드를 생략합니다.
`archive`로 이미 채택한 실행의 보관 계획을 요청할 수도 있습니다.
보관 계획을 받으면 반환된 action을 공식 보관 도구로 실행합니다.
실제 보관 응답을 `record`에 기록해야 보관 상태가 확정됩니다.
승인이나 사용자 입력 대기가 남아 있으면 보관하지 않습니다.

후속 요청은 같은 `taskId`와 새 `requestId`로 `dispatch`합니다.
보관된 대화의 후속 실행에는 복원과 후속 전달 권한이 모두 필요합니다.
두 권한이 확인되면 `unarchive` action이 먼저 반환됩니다.
후속 전달 권한이 있으면 복원 응답을 기록한 뒤 같은 대화의 `send` action이 반환됩니다.
복원 도중 후속 전달 권한이 철회되면 복원만 기록합니다.
전달 권한을 다시 확보한 뒤 같은 `requestId`와 입력으로 `dispatch`를 다시 호출합니다.
새 실행에는 새로운 검증과 채택이 필요합니다.
