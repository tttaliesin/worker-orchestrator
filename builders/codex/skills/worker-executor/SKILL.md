---
name: worker-executor
description: Execute a scoped worker assignment and return a structured run result when a controller supplies a runId, task, and ownership boundaries in a Codex worker chat.
---

# Codex 워커 실행

컨트롤러가 제공한 `runId`와 작업 범위를 사용합니다.
실행 식별자가 없으면 완료 결과를 만들기 전에 누락 사실을 현재 대화에 알립니다.
허용된 파일과 요청한 검증만 다룹니다.
다른 에이전트의 변경은 보존합니다.

설치 루트는 현재 설치본 `SKILL.md`의 부모인 스킬 디렉터리에서 **두 단계 위**입니다.
`<설치 루트>/skills/worker-executor/SKILL.md`에서 `dirname(SKILL.md)/../..`를 해석합니다.
설치 경로 확인이 필요하면 해당 루트의 `dist/cli.mjs`만 사용합니다.
소스 저장소의 CLI에 의존하지 않습니다.
워커에게 컨트롤러의 상태 변경 권한은 주어지지 않습니다.

[공통 워커 절차](../../workflows/worker.md)를 읽습니다.
결과 형식은 [결과 스키마](../../workflows/worker-result.schema.json)를 따릅니다.
검증을 실행하지 않았다면 `verification.status`를 `not_run`으로 남깁니다.
출력·파일·호스트 응답으로 확인한 근거만 `evidenceRefs`에 기록합니다.
승인과 답변 대기는 `pendingRequests`에 유지합니다.

마지막 응답은 `runId`, `status`, `summary`, `verification: {status, evidenceRefs}`, `pendingRequests`를 포함하는 JSON 객체로 반환합니다.
현재 실행과 정확히 일치하는 `runId`를 반드시 최상위 필드에 둡니다.
최종 응답의 JSON 앞뒤에 설명 문단을 붙이지 않습니다.
호스트 완료 판정은 이 최상위 `runId`로 현재 실행을 확인합니다.
컨트롤러에게 자동 메시지를 보내지 않습니다.
컨트롤러로 위장하거나 컨트롤러 대신 `record`, `verify`, `accept`, `archive`를 실행하지 않습니다.
다른 워커의 생성·전달·복원·보관 도구도 호출하지 않습니다.
