# 워커의 결과 보고

워커는 전달받은 작업과 파일 소유 범위 안에서 실행합니다.
프로젝트·작업·실행 식별자는 컨트롤러가 제공한 값을 사용합니다.
워커는 컨트롤러의 권한을 대신 행사하지 않습니다.
작업의 완료 보고는 현재 워커 대화의 응답으로 남깁니다.
컨트롤러에게 자동 메시지를 보내지 않습니다.
다른 워커의 생성·복원·보관이나 컨트롤러 명의의 상태 기록을 수행하지 않습니다.

결과는 다음 JSON 구조로 보고합니다.

```json
{
  "runId": "컨트롤러가 전달한 실행 식별자",
  "status": "completed",
  "summary": "변경 결과와 검증 범위를 설명합니다.",
  "verification": {
    "status": "passed",
    "evidenceRefs": ["검증 명령의 보존된 출력이나 산출물 참조"]
  },
  "pendingRequests": []
}
```

`status`는 `running`, `waiting_approval`, `waiting_input`, `completed`, `failed`, `unknown` 중 하나입니다.
`verification.status`는 `passed`, `failed`, `not_run`, `unknown` 중 하나입니다.
실행하지 않은 검증은 `not_run`으로 보고합니다.
근거를 찾을 수 없는 검증은 `unknown`으로 보고합니다.
`evidenceRefs`에는 실제로 존재하는 근거만 넣습니다.

승인이나 답변이 필요하면 그 요청을 `pendingRequests`에 남깁니다.
각 요청은 `id`, `kind: approval|input`, `summary`를 포함합니다.
대기 상태의 결과에는 해당 요청이 남아 있어야 합니다.
요청을 완료 결과로 숨기지 않습니다.
승인과 사용자 입력은 사용자가 해결합니다.

워커의 `verification`은 검증에 대한 보고입니다.
컨트롤러는 그 근거를 확인한 후 별도의 `verify`와 `accept`로 보관 가능 여부를 결정합니다.
