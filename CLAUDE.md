# Memo Assistant — Claude Code 프로젝트 지침

## 프로젝트 목적
AX School **Build Your Agent** 과제용으로, 여러 사람이 공개 체험할 수 있는 **AI 메모 정리·공유 프로토타입**을 만든다. 이번 단계의 목적은 기능의 완성도가 아니라 **입력 → Flue 에이전트 → AI 분석 → 도구 호출 → D1 저장 → 화면 표시** 워크플로를 직접 구현·검증하는 것이다.

작업 전 `docs/SPEC.md`와 `docs/IMPLEMENTATION.md`를 읽고, 명시된 MVP 범위를 벗어나지 말 것.

## 우선 기술
- 개발: Claude Code
- 웹: React + TypeScript + Vite
- 에이전트: **Flue** (`'use agent'`)
- 서버/API: Cloudflare Workers (TypeScript)
- AI: Cloudflare Workers AI의 **무료 할당량 내 사용 가능한 모델**, 현재 모델 ID와 Flue 호환성 사전 확인
- 저장: Cloudflare D1
- 로컬/배포: Wrangler + Cloudflare Vite 플러그인 (공식 Flue 가이드 기준)
- 검증: TypeScript typecheck, 빌드, 단위 테스트, 로컬 Worker/D1 통합 테스트
- Python, FastAPI, OpenAI Agents SDK, 별도 유료 API, PostgreSQL은 이번 MVP에 추가하지 말 것.

## 기본 원칙
1. 공식 문서 먼저 확인: https://flueframework.com/start.md , https://flueframework.com/docs/ecosystem/deploy/cloudflare/ , https://flueframework.com/docs/guide/models/ . 없는 API를 추측해서 작성하지 말 것.
2. **Flue에서 실제 Tool을 호출**해 데이터 저장 흐름을 구현한다. 단순한 프롬프트→JSON 반환 앱으로 끝내지 않는다.
3. 원본 입력을 보존하고 하나의 입력을 여러 개의 메모로 분리한다. 모델이 입력에 없는 날짜·시간·사실을 만들어내지 않도록 한다.
4. 시간 기준은 `Asia/Seoul`, 저장 시각은 UTC(ISO 8601)로 기록한다. 날짜의 상대 표현은 **요청 당시의 한국 날짜**를 함께 전달해 해석한다.
5. **모든 메모는 공개 공유**된다. 입력 전 공개 고지, 개인정보 입력 금지 안내, 글자 수 제한, 서버 측 입력 검증을 제공한다. 닉네임은 인증이 아님을 명시한다.
6. API 키·토큰·개인 메모·`.dev.vars`·`.env`·로컬 DB 데이터를 저장소에 커밋하지 않는다. Cloudflare 비밀값은 Wrangler secret으로 관리한다.
7. 무제한 AI 호출을 막기 위한 서버 측 남용 방지(가능한 범위 내 요청 제한, 입력 크기 제한, 오류 처리)를 구현한다. 클라이언트 `localStorage`만으로 호출 제한을 보장하지 않는다.
8. 무료 요금제에서 실행 가능 여부를 **Durable Objects 및 Workers AI 모델 지원/한도까지** 확인한다. 불가능하거나 불확실한 기능은 명시하고, 우회해서 유료 기능을 몰래 사용하지 않는다.
9. 기존 프로젝트가 있으면 분석 후 재사용하고, 신규 프로젝트라면 최소 구조로 시작한다. 불필요한 패키지·Skill·멀티에이전트를 추가하지 않는다.
10. 테스트하지 않은 기능을 README에 '완료'라고 표시하지 않는다. 불가하거나 막힌 부분은 `docs/PROGRESS.md`에 기록한다.
11. **사용자의 사전 승인 없이** 유료 플랜 가입, 결제, 프로덕션 배포, D1 원격 삭제/초기화, Git 강제 푸시를 하지 않는다.

## 진행 순서
1. 현재 폴더/기존 파일, Node 버전, Wrangler 로그인 상태 확인
2. Flue + Cloudflare + Workers AI + D1의 공식 호환성을 확인하고 최소 실행 구성 작성
3. 로컬 D1 스키마/마이그레이션 생성
4. 에이전트 분석 및 `save_memos` Tool 구현
5. 공개 메모 API / React 화면 연결
6. AI 모킹 테스트 + 가능한 실제 로컬 AI 호출 1회 검증
7. README·PROGRESS 업데이트, 보안 점검, 최종 실행 명령 제시

## 작업 완료 보고 형식
- 변경 파일
- 실제 실행한 명령과 성공/실패 결과
- 로컬 기능 시연 방법
- 남은 미구현/위험 사항
- GitHub 제출 가능 여부(확인한 근거 포함)

## 추가 개발 지침 (2026-11-09 호환성 확인 결과)
위 원칙을 대체하지 않고, 실제 구현·검증에서 확인된 사항만 보완한다. 근거와 이력은 `docs/PROGRESS.md`.

### 모델·의존성
- 기본 모델은 `wrangler.jsonc`의 `MEMO_MODEL`(`cloudflare/@cf/zai-org/glm-4.7-flash`). 바꿀 때는 Workers AI 가격표에서 **† 표시(유료 플랜 전용)가 없고** 모델 페이지에서 **Function calling = Yes**, 지원 종료 예정일이 없는지 확인한다. Flue 문서 예시의 `kimi-k2.6`은 유료 전용이라 쓰지 않는다.
- `@flue/runtime@2.3.0`은 `@earendil-works/pi-ai@1.5.0`과 호환되지 않는다(`Type` export 제거). `package.json`의 `overrides`(pi-ai/pi-agent-core 1.4.0)를 Flue 업그레이드 전까지 유지한다.
- `miniflare` devDependency는 `wrangler`가 쓰는 버전과 맞춘다(테스트의 로컬 D1용).

### 구조 규칙
- 에이전트는 **dispatch 전용**이다. `createAgentRouter()`로 공개 마운트하지 않는다(검증·요청 제한을 우회해 대화를 읽고 쓸 수 있게 됨). 진입점은 `POST /api/memos` → `src/server/agent-runner.ts`의 `init().dispatch()/read()` 하나뿐이다.
- 서버가 정하는 값(nickname, requestId, sourceId, createdAt, 원문)은 에이전트 `initialData`로 넘기고 Tool이 클로저로 사용한다. Tool 입력 스키마에 넣지 않는다.
- 모델 출력은 `src/server/validation.ts`의 `sanitizeMemo()`를 거친 뒤에만 저장한다(원문에 없는 기한 제거, 시각 표현이 없으면 `due_at` 제거, 오늘/내일/모레와 요일 표현을 요청 시점의 KST 날짜로 서버가 계산(`pinnedDay`)). 실제 모델은 지시를 어기고 "오늘"에 00:00을 넣거나 "금요일"을 한 주 뒤로 계산한 적이 있으므로 프롬프트만으로 막으려 하지 않는다.
- `POST /api/memos`의 JSON Content-Type 강제와 Origin 검사는 크로스사이트 할당량 소모 방지책이다. 제거하거나 CORS를 열지 않는다.
- 에이전트 이름을 바꾸면 Durable Object 클래스명이 바뀐다. `wrangler.jsonc` migrations에 새 태그를 추가하고(`renamed_classes` 등) 기존 항목은 수정하지 않는다. `wrangler.jsonc`를 수정했다면 `npm run cf-typegen`을 다시 실행한다.

### 실행·검증 명령
- `npm test`(단위 + 로컬 D1 통합 + faux 모델 에이전트), `npm run test:worker`(빌드한 Worker를 workerd에서 실행), `npm run check:types`, `npm run build`, `npx wrangler deploy --dry-run`(업로드하지 않음).
- `npm run dev`는 로컬에서도 **실제 Workers AI를 호출해 무료 Neuron을 소모**하며, 계정에 workers.dev 서브도메인이 있어야 한다. AI 없이 화면과 API만 확인할 때는 `npm run dev:offline`을 쓴다.
- 실제 AI 호출은 검증에 필요한 최소 횟수만 하고, 결과는 `docs/PROGRESS.md`에 기록한다.
