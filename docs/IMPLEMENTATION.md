# Claude Code 실행 작업 — Memo Assistant Phase 1

## 수행 지시
이 저장소에서 `CLAUDE.md`와 `docs/SPEC.md`를 읽고 **Phase 1 프로토타입을 실제로 구현**하라. 사용자는 Intel Mac, Zed, `npx wrangler login` 완료 환경을 사용한다. Node >= 22.19 조건을 확인한다. 기존 코드를 발견하면 먼저 비교하고 재활용 가능한 부분을 최대한 살린다.

## 꼭 먼저 할 호환성 검증
1. 공식 `https://flueframework.com/start.md`와 Cloudflare 배포 문서를 확인하고 현재 안정 API 사용.
2. **Workers 무료 플랜**에서 Flue가 요구하는 Durable Objects와 관련 바인딩을 실행할 수 있는지 검증. 결제/유료 변경이 필요하면 멈추고 제한을 보고.
3. Flue `cloudflare/<Workers AI 모델 ID>` 연결 방식, `AI` 바인딩, 선택한 모델의 무료 플랜 지원/할당량을 확인. 모델 ID는 추측 금지. 사용 가능한 모델을 택하고 변경 가능하게 설정.
4. Wrangler 로컬 실행과 실제 원격 호출의 차이를 확인. 로컬 테스트가 원격 무료 사용량이나 AI 호출을 발생시킬 수 있다는 점을 README에 기재.

## 구현 단계 (순서대로)
1. React + TypeScript + Vite와 Flue/Cloudflare Workers를 호환되는 최소 구조로 초기화. Flue 공식 Cloudflare 가이드의 `flue()` + `cloudflare()` 플러그인 순서와 `app.ts` 라우팅 패턴을 따른다.
2. Cloudflare D1 바인딩, 버전 관리되는 SQL 마이그레이션, 로컬 데이터베이스 설정.
3. 서버 측 데이터 모델 및 스키마 검증, 공개 메모 조회 API, 입력 검증.
4. Flue 메모 분석 에이전트: 하나의 입력을 분리/분류하고 시간 추출/알림 추천 수행. **`save_memos` 도구 실제 호출**로 저장; 원문을 별도 테이블에 보존하고 결과를 프론트에 전달.
5. React: 닉네임, 공개 고지, 텍스트 입력, AI 분석 결과 카드, 오늘/전체 목록, 작성자 표시, 오류/로딩/한도 초과 안내.
6. 반복 호출·중복 저장 방지, 안전한 입력 제한, 서버 측 기본 남용 방지. 공개 배포 전 최소 보안/비용 위험 점검.
7. mock 기반 AI 동작 테스트, D1 통합 테스트, 타입 검사/빌드, 가능하면 실제 무료 Workers AI 테스트 1회.
8. `README.md`, `docs/PROGRESS.md`, `.gitignore`, `.dev.vars.example` (필요 시) 업데이트.

## 우선 구현 파일 트리 (기술적 사유가 있으면 조정 가능)
```text
memo-assistant/
├── CLAUDE.md                         # Claude Code 상시 프로젝트 규칙
├── README.md                         # AX School 제출용 소개/상태/실행
├── .gitignore
├── package.json
├── package-lock.json
├── vite.config.ts                     # Flue + Cloudflare Vite 설정
├── wrangler.jsonc                     # Workers, D1, Workers AI, DO 바인딩
├── app.ts                             # Flue 라우트 + 일반 API
├── index.html
├── src/
│   ├── agents/
│   │   └── memo-agent.ts              # 'use agent', 모델 및 도구 연결
│   ├── tools/
│   │   └── save-memos.ts              # AI Tool과 DB 저장 경계
│   ├── server/
│   │   ├── db.ts                      # D1 쿼리 및 트랜잭션 처리
│   │   ├── routes.ts                  # 공개 메모 조회 API
│   │   └── validation.ts              # 서버 입력/출력 검증
│   ├── shared/
│   │   └── types.ts                   # 프론트·서버 공유 타입
│   ├── components/
│   │   ├── MemoInput.tsx
│   │   ├── MemoCard.tsx
│   │   └── MemoList.tsx
│   ├── App.tsx
│   ├── main.tsx
│   └── styles.css
├── migrations/
│   └── 0001_initial.sql
├── tests/
│   ├── memo-agent.test.ts
│   └── memos-api.test.ts
└── docs/
    ├── SPEC.md
    ├── IMPLEMENTATION.md
    └── PROGRESS.md
```
폴더/파일의 정확한 형태는 Flue와 Cloudflare 최신 공식 생성 구조에 맞춰 변경 가능. 그 경우 변경 이유를 설명할 것.

## README 필수 내용
- **누구를 위한 에이전트인지 / 어떤 업무를 대신하는지**
- **지금 되는 기능 / 아직 안 되는 기능**
- 사용 기술과 AI Tool 흐름(한눈에 보는 짧은 구조도)
- 로컬 구동/테스트 방법, 필요한 Wrangler 로그인·D1 마이그레이션 명령
- GitHub 공개 저장소에 비밀값을 올리지 말 것
- 모든 사용자의 메모가 공개적으로 보이는 데모라는 고지
- 과제 제출에 필요한 GitHub Public 상태

## 중요 경계
- 실제 사용자가 요청한 범위는 '공개 데모/프로토타입'이지 완성형 개인 비서가 아니다.
- 프론트 화면에 '알림 추천'만 표시하고 **알림을 전송하지 않는다**.
- 닉네임만으로 인증을 구현했다고 주장하지 않는다.
- 실사용 개인정보를 수집하지 않는다.
- 무료 할당량을 초과하거나 호환 문제가 있으면 허위 성공 대신 정확한 상태와 대안을 기록한다.
- 코드 작성 후 실제 실행 명령, 검증 결과, 아직 필요한 수동 설정을 정리한다.
