# worker-orchestrator

기존 Codex Desktop 입력창과 대화 도구로 프로젝트별 워커 생명주기를 관리합니다.
Node.js 24 이상과 기본 제공 SQLite를 사용합니다.
공통 코어는 호스트 도구를 직접 호출하지 않습니다.
Codex 도구 호출은 사용자 권한을 가진 컨트롤러 대화가 수행합니다.

## 구현 경계

- `src/core`, `src/contracts`, `src/state`는 builder에 독립적입니다.
- Codex 변환은 `src/adapters/codex-desktop`에 둡니다.
- `scripts/build-package.mjs`는 `plugin/`의 원본과 공통 구현을 독립 설치 패키지로 묶습니다.
- 승인·사용자 답변 대기 또는 검증 미확인 작업은 자동 보관하지 않습니다.
- 후속 실행에 이전 검증 통과를 승계하지 않습니다.
- 사용자 대화 도구와 일시적 subagent 도구를 혼동하지 않습니다.

## Desktop 대화 역할

설치된 CLI가 `candidate`를 지원하고 Codex Desktop 조회 도구를 사용할 수 있으면 일반 프로젝트 작업에서도 `worker-controller` 스킬로 대화 역할을 확인합니다.
컨트롤러가 `runId`와 작업 범위를 전달한 워커는 `worker-executor` 스킬을 사용합니다.
컨트롤러로 확인된 대화는 계획, 허가된 워커 배정, 관찰, 검증과 보고를 맡습니다.

## 검증과 산출물

`npm test`, `npm run build`, `npm run check`로 검증합니다.
실제 대화 검증은 사용자 요청 범위의 검증 워커만 사용합니다.
원시 도구 결과와 SQLite 상태·설치 검증 출력은 Git 제외를 확인한 `.local/`에 둡니다.
유지할 문서·소스·테스트·fixture는 추적 대상으로 둡니다.
문서와 최종 답변은 한국어를 기본으로 하고 문장마다 줄바꿈합니다.
