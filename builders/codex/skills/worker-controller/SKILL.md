---
name: worker-controller
description: Manage project-scoped worker chats through existing Codex Desktop tools when the user requests worker creation, follow-up, monitoring, or lifecycle management.
---

# Codex 워커 컨트롤러

이 스킬은 기존 Codex Desktop 대화 도구와 설치된 로컬 CLI를 연결합니다.
스킬의 발견이나 선택은 대화 생성·메시지 전달·보관·복원의 허가가 아닙니다.
각 변경에는 해당 프로젝트와 작업을 포함하는 직접적인 사용자 권한이 필요합니다.
이미 확인한 권한의 범위와 출처를 재사용합니다.
권한이 없는 변경은 수행하지 않습니다.

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
현재 대화에 공식 Desktop 도구가 노출되는지도 별도로 확인합니다.
필요한 도구가 없으면 누락된 기능을 알립니다.
원격 endpoint나 새로운 MCP 서버를 만들지 않습니다.

공통 절차는 [컨트롤러 워크플로](../../workflows/controller.md)를 읽습니다.
정확한 입력과 기록 예시는 [사용법](../../docs/usage.md)을 읽습니다.

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
이 표를 존재하지 않는 인수나 권한의 근거로 사용하지 않습니다.
`create_thread`는 사용자가 관리하는 대화를 생성합니다.
일시적인 subagent 도구로 대체하지 않습니다.

먼저 CLI가 반환한 `action.id`를 보존합니다.
그 다음 해당 호스트 도구를 호출합니다.
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
관련 상세 증거가 필요할 때 `read_thread`를 사용합니다.
`observe`가 `read_thread`의 `hostCall`을 반환하면 해당 읽기 전용 호출을 바로 실행합니다.
같은 `observe` 입력에 실제 조회 응답 `readThreadResult`와 근거 참조 `readThreadEvidenceRef`를 추가해 다시 호출합니다.
원문으로 확인된 결과도 같은 실행의 검증과 채택을 거칩니다.
승인이나 사용자 입력을 컨트롤러가 대신 처리하지 않습니다.
`waiting_approval`과 `waiting_input` 상태에서는 보관하지 않습니다.
실제 사용자 처리를 확인한 요청마다 `task.waits`의 해당 ID를 사용해 해제합니다.
동일 실행에 대한 `verify: passed`와 `accept`가 끝나야 보관을 계획합니다.
보관된 대화의 후속 작업은 같은 대화를 복원한 다음 새 실행을 전달합니다.
