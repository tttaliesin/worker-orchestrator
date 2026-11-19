---
name: worker-controller
description: Resolve the controller role for ordinary requests in projects using Worker Orchestrator, then plan and verify work through authorized Codex Desktop worker chats. Also use for worker follow-ups, monitoring, and lifecycle management.
---

# Codex 워커 컨트롤러

이 스킬은 기존 Codex Desktop 대화 도구와 설치된 로컬 CLI를 연결합니다.
워커 대화 운영 권한은 사용자가 해당 프로젝트와 작업에 대해 직접 위임한 동작으로 한정합니다.
스킬이나 워크플로를 수정하라는 요청은 대화 운영 권한의 근거에서 제외합니다.

현재 읽은 **설치본** `SKILL.md`의 부모 디렉터리가 이 스킬 디렉터리입니다.
설치 루트는 그 스킬 디렉터리에서 **두 단계 위**입니다.
`<설치 루트>/skills/worker-controller/SKILL.md`에서 `dirname(SKILL.md)/../..`를 해석합니다.
SKILL 파일 자체를 기준으로 두 번 dirname을 적용하면 `skills/`가 되므로 사용하지 않습니다.
설치 루트의 `dist/cli.mjs`만 실행합니다.
소스 저장소의 CLI나 builder 디렉터리를 실행 경로로 사용하지 않습니다.

먼저 Node.js 24 이상으로 다음 명령을 실행합니다.

```text
node <설치 루트>/dist/cli.mjs capabilities
```

이 출력은 로컬 명령의 지원 범위입니다.
프로젝트 위임을 사용하기 전에 `supports`에서 `project-operations`를 확인합니다.
현재 대화에 공식 Desktop 도구가 노출되는지도 별도로 확인합니다.
필요한 도구가 없으면 누락된 기능을 알립니다.
원격 endpoint나 새로운 MCP 서버를 만들지 않습니다.

## 현재 대화의 역할 확인

관리 대상 프로젝트에서는 일반 작업 요청을 받아도 먼저 설치 CLI의 `candidate`에 실제 프로젝트 경로를 전달합니다.
현재 대화 ID는 CLI가 Codex 실행 환경에서 읽습니다.
`DISCOVERY_REQUIRED`를 받으면 `list_projects`와 현재 호스트의 `list_threads` 기록을 조회합니다.
기록 조회에는 `mode: history`, `source: codex`, `archived: false`를 사용하고 `nextCursor`가 `null`일 때까지 같은 범위에서 페이지를 읽습니다.
조회 원문과 각 페이지의 요청 커서를 같은 `candidate` 입력에 담습니다.
`claim: true`를 전달하면 유일한 최초 후보를 등록하고 기존 등록이 있다면 그 역할을 반환합니다.
`claim`을 생략하면 후보 판정만 확인할 수 있습니다.
등록·페이지 입력 예시는 [사용법](../../docs/usage.md)을 읽습니다.

`decision: controller`를 받으면 반환된 프로젝트와 컨트롤러 식별자를 사용합니다.
컨트롤러는 계획, 워커 배정, 진행 관찰, 산출물 검증과 보고를 맡습니다.
컨트롤러 등록은 대화의 역할만 기록합니다.
`worker`, `not_candidate`, `undetermined`에서는 컨트롤러 명의의 동작을 계획하거나 호출하지 않습니다.

## 프로젝트 위임과 워커 선택

사용자가 프로젝트의 워커 대화 운영을 직접 위임하면 등록된 컨트롤러 대화에서 `project`를 호출합니다.
입력에는 등록된 `projectId`, `projectRoot`, `hostProjectId`, `controller`를 사용합니다.
`authorization`에 `scope: "project"`를 지정합니다.
`createWorkers`, `sendFollowups`, `archiveCompleted`, `restoreWorkers`에는 각각 `true`나 `false`를 명시합니다.
`source`에는 직접 위임을 확인할 수 있는 사용자 발언의 출처와 해당 작업 범위를 기록합니다.
이 위임은 등록된 프로젝트 루트에서 사용자가 허용한 작업과 동작에만 적용합니다.

사용자가 위임을 바꾸면 같은 `project` 명령으로 권한을 갱신합니다.
상시 위임을 철회하면 `authorization`에서 `scope`를 빼고 현재 권한으로 교체합니다.

일반 요청을 받으면 등록된 `projectId`로 `status`를 조회합니다.
`tasks`의 `taskId`, `prompt`, `result`를 새 요청과 대조해 관련 작업을 찾습니다.
관련 워커가 실행 중이거나 대기 중이면 현재 실행을 관찰하고 새 대화를 만들지 않습니다.
관련 작업에 `workerRef`가 있고 새 실행을 시작할 수 있으면 같은 `taskId`와 `reuseOnly: true`로 `dispatch`합니다.
해당 워커가 보관 상태이면 복원 결과를 기록한 뒤 반환된 전달 action을 수행합니다.
관련 작업이 없고 새 워커 생성 권한이 있으면 새 `taskId`로 실행을 계획합니다.

## 작업 지시와 검증

자연어 요청을 받으면 [컨트롤러 워크플로](../../workflows/controller.md)의 요청 해석 절차에 따라 작업별 프롬프트, 프로필, 실행 순서와 검증 기준을 정합니다.
정한 프롬프트와 프로필을 `dispatch`에 전달하고, 실제 검증 근거를 확인한 뒤 결과를 사용자에게 보고합니다.
정확한 입력과 기록 예시는 [사용법](../../docs/usage.md)을 읽습니다.

대상 호스트의 도구 메타데이터 등에서 지원이 확인된 모델과 thinking 조합을 선택합니다.
선택을 위임받았고 둘 다 사용할 수 있다면 일반 작업에는 `gpt-6.2-sol`을 우선 고려하고, 복잡한 종합 판단이나 어려운 원인 조사에는 `gpt-6.2-astra`를 고려합니다.
선호 모델을 사용할 수 없으면 사용자의 조건을 충족하는 확인된 후보를 선택합니다.
사용자가 요구한 모델이나 강도를 바꿔야 하는 경우는 사용자 결정으로 남깁니다.

| CLI action 또는 관찰 | 공식 호스트 도구 |
| --- | --- |
| `create` | `mcp__codex_app.create_thread` |
| `send` | `mcp__codex_app.send_message_to_thread` |
| 진행 확인 | `mcp__codex_app.wait_threads` |
| 필요한 상세 확인 | `mcp__codex_app.read_thread` |
| `archive` | `mcp__codex_app.set_thread_archived`의 보관 동작 |
| `unarchive` | `mcp__codex_app.set_thread_archived`의 복원 동작 |

실제 도구 이름과 입력은 현재 제공된 도구 메타데이터를 따릅니다.
도구 이름의 표기는 Desktop의 namespace에 따라 달라질 수 있습니다.
`create_thread`는 실제 새 워커 대화 생성이 사용자의 명시적 요청 범위에 있을 때 호출합니다.
프로젝트에서 대화를 만들기 전에 `list_projects`에서 대상 호스트 프로젝트를 확인합니다.
일시적인 subagent 도구로 대체하지 않습니다.

`send_message_to_thread`는 등록된 대상 워커에 대한 사용자의 직접 허가를 확인한 경우에 호출합니다.
전달, 보관, 복원에는 `workerRef`의 `threadId`와 `hostId`로 대상을 지정합니다.
현재 위임 기록이 대상과 동작을 포함하면 같은 허가를 다시 묻지 않습니다.
필요한 권한이 빠져 있으면 그 동작과 대상만 사용자에게 확인합니다.

먼저 CLI가 반환한 `action.id`를 보존합니다.
해당 동작을 현재 위임과 호스트 계약에 대조한 뒤 호스트 도구를 한 번 호출합니다.
마지막으로 실제 응답을 `record`에 `hostResult` 또는 계약에 맞는 `receipt`로 기록합니다.
`record`가 새 action을 반환하면 새 ID를 사용해 다음 호스트 작업을 수행합니다.
계획만으로 호스트 성공을 기록하지 않습니다.
생성 결과를 알 수 없으면 `outcome: unknown`으로 남깁니다.
실제 생성 여부를 확인하기 전에는 생성을 다시 보내지 않습니다.
호스트가 생성 시작 전에 요청을 확정 거절했으면 같은 action의 `outcome: rejected`와 실제 근거를 기록합니다.
거절이 기록되면 같은 작업에 새 `requestId`로 수정된 요청을 계획할 수 있습니다.
기록 응답을 받지 못했으면 같은 `action.id`와 원문 응답을 `record`에 다시 전달합니다.

워커 프롬프트에는 `action.runId`와 [워커 스킬](../worker-executor/SKILL.md)의 설치 경로를 전달합니다.
프롬프트에는 프로젝트와 파일 소유 범위도 전달합니다.
요청한 모델과 thinking은 요청값으로만 보고합니다.
호스트 증거가 없으면 실제 적용 프로필은 미확인으로 남깁니다.

관찰은 `wait_threads`의 커서와 워커의 `threadId`, `hostId`를 보존합니다.
호출 오류가 발생해도 `wait_threads` 응답을 `observe`의 `hostResult`에 전달합니다.
응답의 근거는 `evidenceRef`에 지정합니다.
오류 메시지만 받으면 `hostResult`에 `isError: true`를 지정합니다.
실제 오류 메시지는 그 객체의 `content`에 `type: "text"`인 항목으로 담습니다.
`observe`가 `read_thread`의 `hostCall`을 반환하면 해당 읽기 전용 호출을 바로 실행합니다.
같은 `observe` 입력에 실제 조회 응답 `readThreadResult`와 근거 참조 `readThreadEvidenceRef`를 추가해 다시 호출합니다.
오류 메시지만 남긴 `read_thread` 호출에도 같은 오류 형식을 사용해 조회 실패를 기록합니다.
원문으로 확인된 결과도 같은 실행의 검증과 채택을 거칩니다.
승인이나 사용자 입력을 컨트롤러가 대신 처리하지 않습니다.
실제 사용자 처리를 확인한 요청마다 `task.waits`의 해당 ID를 사용해 해제합니다.

현재 실행의 성공을 검증한 뒤 `verify`에 통과와 근거를 기록합니다.
미해결 대기가 없으면 `accept`로 결과를 채택합니다.
합의했거나 계획에 남은 후속 작업이 있으면 `keepWorker: true`를 보내거나 필드를 생략해 워커를 유지합니다.
후속 작업이 없고 해당 워커의 보관을 위임받았으면 `keepWorker: false`를 보냅니다.
자동 보관에는 `authorization.scope: "project"`와 `archiveCompleted: true`가 모두 필요합니다.
`accept`가 보관 action을 반환하면 해당 워커를 보관하고 실제 응답을 같은 `action.id`로 기록합니다.
