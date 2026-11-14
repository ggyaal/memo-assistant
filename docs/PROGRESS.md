# 진행 기록 — Memo Assistant Phase 1

마지막 갱신: 2026-11-09 23:00 (KST)

**배포 주소: https://memo-assistant.ggyaal.workers.dev** (현재 Version `29f0e6f3-e96b-4be9-be86-861b62ad4e39`, 2026-11-14)

## 1. 상태 요약
| 단계 | 상태 | 근거 |
|---|---|---|
| 호환성 확인 (Flue / Workers / Workers AI / D1 / DO 무료 플랜) | 완료. 배포 환경에서 동작 확인 | §2, §6, R5 |
| 프로젝트 구성 (`flue init --target cloudflare` 스캐폴드 기준으로 병합) | 완료 | `npm run build` |
| D1 스키마·마이그레이션 | 완료 (로컬 + 원격) | `migrations apply --local/--remote` |
| 에이전트 `MemoOrganizer` + `save_memos` Tool | **완료 — 실제 Workers AI로 확인** | §4 |
| 공개 메모 API (`GET/POST /api/memos`) | 완료 | 테스트, 실제 dev 서버 |
| React 화면 | 빌드·타입 검사 통과, SPA 제공 확인 | 브라우저 수동 조작은 **미확인** (U2) |
| 서버 측 남용 방지·보안 헤더 | 완료 | 테스트 (400/403/413/415/429), §5 |
| Cloudflare 원격 배포 | **완료** (2026-11-09, 사용자 승인) | §6 |

## 2. 호환성 확인 결과 (공식 문서 기준, 2026-11-09)
- **Node**: 로컬 v26.13.0. Flue는 `>=22.19.0`을 요구한다.
- **Flue 2.3.0**: Vite 8과 `@cloudflare/vite-plugin`을 쓰고, `flue()`를 `cloudflare()`보다 앞에 둔다. `nodejs_compat`, `compatibility_date >= 2026-04-01`, `new_sqlite_classes` migration이 필요하다.
- **Workers Free** ([limits](https://developers.cloudflare.com/workers/platform/limits/)):
  - 하루 100,000 요청, 호출당 CPU 10ms, 메모리 128MB, 시작 시간 1초, 호출당 subrequest 50개.
  - 크기는 비압축 64MiB까지이고 압축 크기 한도는 없다. 이 앱은 6.6MB(gzip 1.2MB)이다.
- **Durable Objects Free** ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [pricing](https://developers.cloudflare.com/workers/platform/pricing/)):
  - SQLite 기반 DO만 쓸 수 있고, Flue가 쓰는 방식이 바로 이것이다.
  - 하루 100,000 요청, 13,000 GB-s, 저장 5GB.
  - CPU 한도는 문서마다 다르다: "기본 30초" vs "Workers와 같은 호출당 CPU 한도". → R5
- **Workers AI**: 무료 할당량은 하루 10,000 Neurons(00:00 UTC 초기화)이고, 넘으면 호출이 실패한다(과금 없음).
- **모델**:
  - `kimi-k2.6`(Flue 문서 예시)은 유료 전용(†)이라 제외했다.
  - `qwen3-30b-a3b-fp8`은 2026-11-20 지원 종료 예정이라 제외했다.
  - **채택: `@cf/zai-org/glm-4.7-flash`**. 무료이고 function calling을 지원하며, 실제 호출로 동작을 확인했다.
- **AI Gateway**: `cloudflareBindingProvider({ gateway: false })`로 끄고 바인딩으로 직접 호출한다.
- **로컬 AI 호출**: 로컬 개발에서도 원격으로 실행되어 Neuron을 소모하며, workers.dev 서브도메인이 있어야 한다. 서브도메인 `ggyaal.workers.dev`는 등록되어 있다.

## 3. 이슈 / 결정 기록
| ID | 구분 | 내용 | 상태 |
|---|---|---|---|
| U1 | 해결 | workers.dev 서브도메인이 없어 `npm run dev`가 시작하지 않았다(10063). 사용자가 `ggyaal.workers.dev`를 등록한 뒤 정상 동작한다. | 해결 |
| U2 | 미확인 | 브라우저에서 React 화면을 직접 조작해 보지 않았다(빌드, SPA 응답, API는 확인). | 열림 |
| U3 | 부분 확인 | 실제 모델 품질(§4): 분리와 "내일 오후 3시" 해석은 2회 모두 정확했다. 다만 실행마다 출력이 달라진다. 카테고리(todo/schedule), `due_text` 범위(표현만 vs 문장 전체), 알림 추천 여부가 바뀌었다. 품질 측정은 Phase 2 범위다. | 기록 |
| U4 | 기록 | 첫 실제 호출이 Workers AI `500 Internal Server Error`로 실패했다(reference `3igekk152v16baf2pejkbsfc`). 같은 요청 형식을 진단 Worker로 하나씩 나누어 시험했을 때는 모두 200이었고, 재시도는 성공했다. 일시적인 플랫폼 오류로 판단한다. 사용자에게는 `agent_failed`(502)와 다시 시도 버튼이 표시된다. | 관찰 |
| I1 | 수정됨 | `@flue/runtime@2.3.0`이 `pi-ai@1.5.0`과 호환되지 않는다(`Type` export 없음). `overrides`로 1.4.0에 고정했다. | 임시 고정 |
| I2 | 수정됨 | `AgentRunError.cause`가 일반 객체라서 할당량 오류(4006)가 502로 분류되었다. 이제 503 `ai_quota_exceeded`로 분류한다. | 해결 |
| I7 | 수정됨 | **실제 모델이 "오늘"(시각 없음)에 자정 시각(`00:00+09:00`)을 만들어 넣었다.** `due_text`에 명시적 시각(N시, HH:MM, 정오, 자정 등)이 없으면 `due_at`을 null로 두는 규칙을 서버에 추가했다(`hasExplicitTime`). 회귀 테스트를 추가했고, 실제 재호출로 확인했다. | 해결 |
| I8 | 수정됨 | **보안**: `POST /api/memos`가 Content-Type을 검사하지 않아, 다른 사이트가 사전 요청 없는 `text/plain` POST로 방문자 브라우저를 이용해 AI 할당량을 쓰게 할 수 있었다. → `application/json`만 허용(415)하고, 다른 Origin은 403으로 거부한다. | 해결 |
| I3 | 결정 | 에이전트는 HTTP에 마운트하지 않는다(dispatch 전용). | — |
| I4 | 결정 | 서버가 정하는 값은 `initialData`로 넘긴다. 요청마다 새 인스턴스(`req-<requestId>`)를 만든다. | — |
| I5 | 결정 | 오늘/내일/모레/글피는 요청 시점 KST 날짜로 고정한다. 원문에 없는 `due_text`는 지운다. | — |
| I6 | 결정 | `memos.position` 컬럼과 `usage_counters` 테이블을 추가했다(SPEC §5에 없음). | — |
| I9 | 결정 | **화면 사용량 표시**(`GET /api/usage`, `UsageMeter`). "오늘 사용"은 서버가 AI로 넘긴 요청 수로, AI 실패 건도 포함하고 중복 requestId와 검증 실패 건은 제외한다. 기준은 UTC 하루(오전 9시 KST 초기화, Workers AI 무료량과 같은 기준)이며, 화면에는 한도를 넘지 않게 `min(count, limit)`로 표시한다. "누적 사용"은 만료되지 않는 `usage_counters`의 `total:ai` 행이다(`0002_usage_total.sql`). 누적 초깃값은 마이그레이션 시점의 sources 수라서, 그 이전에 실패한 시도는 빠진 **근사치**다. 횟수 기준이며 Neuron 양은 아니다. | 운영 반영 (2026-11-09, 버전 `bf18a7ca`) |
| I10 | 결정 | **사이드 패널**(`GET /api/agenda`, `AgendaPanel`). 다가오는 항목만 보여 준다: `due_at`이 지나지 않았거나, 날짜만 있는 경우 `due_date`가 오늘(KST) 이후인 것. 알림 목록은 `reminder_recommended` 항목을 시간순으로, 순위 목록은 AI `priority`(high > medium(=미지정) > low) → 가까운 순 → 등록 순으로 정렬한다(`src/server/agenda.ts`). 각 20개까지. 실제 알림 발송은 없다. 모바일에서는 입력과 목록 사이에, 960px 이상에서는 오른쪽 sticky 사이드로 표시한다. | 운영 반영 (버전 `4b94b6ef`) |
| I11 | 결정 | `0003_priority_due_date.sql`: `priority`, `priority_reason`, `due_date` 컬럼을 추가했다. `due_date`는 시각 없이 날짜만 있는 기한("오늘 장 보기")도 알림 목록에 넣기 위한 것이다. 기존 행은 `due_at`이 있을 때만 날짜를 채우고, 기존 메모의 priority는 비어 있다(미지정). 모델의 priority가 허용 값이 아니면 저장을 실패시키지 않고 미지정으로 둔다. | 구현 |
| I12 | 수정됨 | **실제 모델이 "금요일까지"(요청일 11/9 월요일)를 11/20으로 계산했다.** 요일 표현도 서버가 계산한다(`pinnedDay`): "금요일"은 오늘을 포함한 가장 가까운 그 요일, "이번 주/다음 주/다다음 주 X요일"은 월요일 시작 주 기준이다. 시각이 있는 경우(`due_at`)에도 같은 날짜로 고정한다. 모델이 준 날짜는 "11월 20일" 같은 명시적 날짜에만 쓰고, 1년 이내 미래일 때만 받는다. 회귀 테스트를 추가했다. | 해결 |
| I13 | 결정 | **편집 권한 정책 (2026-11-14, 사용자 선택: "모두에게 공유")**: 로그인과 소유 확인이 없는 공개 게시판이므로 순서·완료·삭제는 D1에 저장되어 모든 방문자에게 같게 보이고, 누구나 바꿀 수 있다. 안전장치: 삭제는 숨김 처리(`deleted_at`, 운영자가 복구 가능)이며 **기한이 지난 미완료** 메모만 가능하다(그 외 409). 편집 API도 `crossSiteBlock`(JSON 필수·같은 출처)을 거치고, 클라이언트당 분당 30회로 제한한다(`consumeWindow`, 429). 화면에 "모든 방문자에게 적용"을 표시한다. SPEC §2 P2의 "메모 수정·삭제 제외"를 사용자 요청으로 넓힌 것이다(완료 체크와 지나버린 일 삭제만 추가했고, 메모 내용 수정은 여전히 없음). | 구현 |
| I14 | 기능 1 | **우선순위 목록 드래그 정렬**: `manual_rank`(0004)와 `PUT /api/agenda/order`(id 배열 1–20개, 중복·형식 검사, 원자적 batch). 정렬 규칙 `byListOrder`: 사용자가 정한 순서가 항상 먼저 오고, 아직 정렬하지 않은 항목은 그 아래에 AI 우선순위 → 가까운 순으로 붙는다. 그래서 AI가 이후에 사용자 순서를 덮어쓰지 않는다. 화면은 HTML5 드래그(반투명 점선 + 놓일 위치에 파란 선)와 ▲▼ 버튼(터치·키보드용)이고, 저장에 실패하면 원래 순서로 되돌린다. | 운영 반영 (`29f0e6f3`) |
| I15 | 기능 2 | **완료 체크 + 취소선**: `completed_at`(0005)과 `PATCH /api/memos/:id {completed}`. 메모 카드와 우선순위 목록에 체크박스를 두고, 완료하면 취소선과 흐린 카드, 완료 시각을 표시한다. 완료한 항목은 '다가오는 알림'에서 빠지고 우선순위 목록에는 남는다(다시 해제할 수 있도록). | 운영 반영 (`29f0e6f3`) |
| I16 | 기능 3 | **지나버린 일**: `deleted_at`(0006, 숨김), `DELETE /api/memos/:id`, `GET /api/agenda`의 `overdue`(최근 기한 순, 50개). 판정은 데이터를 복사하지 않고 기한과 완료 상태에서 바로 한다: 정확한 시각(`due_at`)은 그 시각이 지나면, 날짜만 있으면(`due_date`, KST) 그날이 끝나면 경과다. 다가오는 목록과 정확히 겹치지 않는다. 완료 메모와 기한 없는 메모는 대상이 아니다. 숨긴 메모는 모든 목록과 API에서 제외된다. 메인 목록 카드는 메모 기록 성격이라 그대로 두고 '기한 지남' 배지만 붙인다(화면의 판정 함수 `isOverdue`도 서버와 같은 규칙이며 테스트로 확인). | 운영 반영 (`29f0e6f3`) |
| I17 | 수정됨 | 브라우저 확인 중 넓은 화면에서 sticky 사이드 패널이 화면 높이로 잘려 맨 아래 '지나버린 일'이 보이지 않았다. sticky를 풀고 페이지와 함께 흐르게 했다. | 해결 |
| R1 | 조정 | 실측 결과 1건당 **35.9 Neurons**(프롬프트 1,492토큰, 출력 760토큰, `reasoning_effort: medium`)였다. 10,000/일이면 약 270건이다. 긴 입력과 검증 호출을 고려해 `DAILY_AI_LIMIT`를 200에서 **150**으로 낮췄다. | 해결 |
| R2 | 위험 | 실패한 submission을 Flue가 'deferred'로 남긴다. 플랫폼 오류 뒤 재시도 때문에 Neuron이 추가로 쓰이는지는 배포 환경에서 관찰이 필요하다. 요청 경로는 90초에 시간 초과되며, 그때 `abort()`를 호출한다. | 열림 |
| R3 | 위험 | `npm audit` 고위험 7건은 모두 `@flue/runtime`이 버전을 고정한 MCP SDK(`@modelcontextprotocol/*` 2.0.0)에서 나온다. 이 앱은 `useMcpConnection`을 쓰지 않아 해당 코드가 실행되지 않는다. `--force` 업그레이드는 하지 않았다. Flue를 업그레이드할 때 다시 확인한다. | 수용 |
| R4 | 해결 | 원격 D1 `memo-assistant`(APAC, `3b94baf6-5a20-4a9b-bb97-05b57fe981c1`)를 만들고 원격 마이그레이션을 적용했다. D1 ID는 비밀값이 아니다. | 해결 |
| R5 | 관찰됨 / 계속 주의 | 문서가 서로 다르던 CPU 10ms 문제를 배포 후 `wrangler tail`로 확인했다. 실제 요청 1건에서 **여러 호출이 10ms를 넘었지만**(API 37ms, DO 호출 최대 47ms, 에이전트 alarm 30ms) 모두 `outcome: ok`였고 CPU 초과 오류는 0건이었다. 지금은 무료 플랜에서 동작하지만, Cloudflare가 강제 방식을 바꾸면 `Exceeded CPU Limit`이 날 수 있다. 오류가 늘면 Workers Paid 전환(유료, 승인 필요)을 검토한다. | 관찰 |

## 4. 실제 Workers AI 검증 (2026-11-09, `npm run dev`, SPEC §3 예시 입력)
입력: `오늘 장 보고, 내일 오후 3시에 병원 예약해야 해. AI 검색 기능 아이디어도 메모해 줘.` (요청 시각 22:3x KST)

| 회차 | 결과 | 비고 |
|---|---|---|
| 1 | 502 `agent_failed`, 12.9초 | Workers AI 500 (U4) |
| 2 | 201, 19.7초, 모델 호출 1회 | todo `장 보기`(due_at **00:00 생성됨** → I7) / schedule `병원 예약` 2026-11-10T06:00Z / idea `AI 검색 기능 아이디어` (due 없음). 3건 모두 같은 source_id |
| (측정) | 같은 페이로드를 비스트리밍으로 재전송: 35.87 Neurons, tool_calls 1 | R1 |
| 3 (I7 수정 후) | 201, 25.9초 | todo `오늘 장 보고`(due_at null ✔) / todo `병원 예약` 2026-11-10T06:00Z ✔ / idea (due 없음 ✔) |
| 3 재전송 | 200 `duplicate: true`, 0.01초 | AI 재호출 없음 ✔ |
| 목록 | 서로 다른 IP 두 곳에서 `GET /api/memos?scope=all` | 응답 동일 ✔ |

모델에 실제로 전달된 것: 시스템 지시문, signal(원문 + timezone + now_kst + date_reference), `save_memos` 도구 정의. nickname, source_id, request_id는 전달되지 않는다(로그로 확인한 뒤 디버그 코드는 삭제했다).

## 5. 보안 점검 (배포 전)
| 항목 | 상태 |
|---|---|
| 저장소의 비밀값 | 없음. AI는 바인딩을 쓰므로 API 키가 필요 없다. `.env*`, `.dev.vars*`, `.wrangler/`, `dist/`는 git에서 무시된다 |
| 공개 노출 경로 | Worker에 도달하는 경로는 `/api/*`뿐이다(`run_worker_first`). 에이전트는 HTTP에 마운트하지 않았다(빌드 Worker 테스트에서 확인) |
| 크로스사이트 요청 | JSON Content-Type 필수(415), 다른 Origin은 403. CORS 헤더 없음(빌드 Worker에서 확인. dev 서버의 CORS는 개발 전용 기본값) |
| 입력 검증 | 닉네임 1–20자, 본문 1–1000자, 요청 8KB, 메모 최대 10개, 필드 길이 제한, 제어 문자 제거 |
| 남용·비용 | IP 해시별 분당 5회, 전체 하루 150회(D1). 원본 IP는 저장하지 않는다. 같은 requestId는 AI를 다시 호출하지 않는다. AI 호출은 90초에 시간 초과된다 |
| 모델 출력 | 서버에서 보정한 뒤 저장한다(I5, I7). 화면은 텍스트 노드로만 렌더링한다(`dangerouslySetInnerHTML` 없음) |
| 프롬프트 인젝션 | 입력이 모델 지시를 바꾸려 해도 Tool은 메모 저장만 할 수 있다. 저장 대상(닉네임, source)은 서버가 정하고 개수와 길이도 제한된다. 결과는 어차피 공개 게시판이라 추가로 노출되는 정보가 없다 |
| 응답 헤더 | API: `CSP default-src 'none'`, nosniff, `X-Frame-Options`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. 정적 자산: `public/_headers`로 엄격한 CSP, HSTS, Permissions-Policy 적용 |
| 공개 범위 | `workers_dev: true`, `preview_urls: false`(버전별 미리보기 URL 비활성화). AI Gateway 로그 미사용 |
| 오류 노출 | 사용자에게는 일반화된 메시지만 보낸다. 상세 내용은 서버 콘솔에만 남는다 |
| 의존성 | R3 |

## 6. 배포 기록 (2026-11-09, 사용자 승인: "main 닉네임 버전으로 배포 진행해줘")
| 단계 | 결과 |
|---|---|
| `npx wrangler d1 create memo-assistant` | 성공 (APAC). 첫 `d1 list`는 인증 오류 10000이었고 재시도는 정상이었다(토큰 갱신 시점의 일시 오류로 판단) |
| `wrangler.jsonc` `database_id` 반영 → `npm run cf-typegen` | 완료 |
| `npx wrangler d1 migrations apply DB --remote` | `0001_initial.sql` 적용 |
| 배포 전 재검증 | 타입 검사, `npm test` 50개, `npm run test:worker` 5개, dry-run 모두 통과 |
| `npx wrangler deploy` | 성공. 시작 시간 66ms, 업로드 gzip 1.2MB |
| 운영 확인 (AI 없이) | health 200, SPA와 딥링크 200, 잘못된 입력 400, 다른 Origin 403, text/plain 415, `/agents/*` Worker 미도달(405), 미리보기 URL 404, `/_headers`는 SPA로 대체되어 노출 안 됨 |
| 운영 보안 헤더 | 페이지: CSP, HSTS, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy. API: CSP `default-src 'none'`, no-store. CORS 헤더 없음 |
| 운영 실제 AI 1건 | 201, 19.8초: todo `장 보기`(due 없음) / schedule `병원 예약` 2026-11-10T06:00Z, 알림 추천 / idea (due 없음) |
| 같은 requestId 재전송 | 200, 0.3초 (AI 재호출 없음) |
| 원격 D1 | sources 1, memos 3, 연결된 memos 3 (중복 없음) |
| CPU (R5) | 위 R5 참조. 초과 오류 0건 |

**사용량 표시 반영 (2026-11-09, 사용자 승인)**: 원격 `0002_usage_total.sql` 적용(`total:ai` 초깃값 1) → 재배포(Version `bf18a7ca-e95f-4f3b-b408-5af2a3372625`, 시작 시간 75ms) → 운영 `GET /api/usage` 응답 `{"today":{"used":1,"limit":150},"total":1}` 확인. 새 번들이 제공되는 것과 기존 보안 동작(403/415, CSP)이 그대로인 것도 확인했다. AI 호출은 하지 않았다.

**일정 패널 반영 (2026-11-09, 사용자 승인)**: 원격 `0003_priority_due_date.sql` 적용(기존 5건 중 시각이 있는 2건에 KST `due_date`를 채움, 예: `2026-11-10T21:00Z` → `2026-11-11`) → 재배포(Version `4b94b6ef-12b0-4dbf-baf0-f7f255fb9ae4`, 시작 시간 70ms) → 운영 실제 AI 1건(201, 16.7초): "금요일까지"가 `due_date=2026-11-13`(이번 주 금요일)으로 저장되어 서버 요일 계산이 운영에서 동작함을 확인했다. priority high 2건 저장. `/api/agenda`는 알림 4건을 시간순으로, 순위는 high 2건 → 미지정 2건으로 반환했다. 보안 동작(403/415/400, no-store, CSP)도 유지된다. **브라우저에서 화면 배치를 직접 확인하지는 않았다.**

**목록 관리 3기능 반영 (2026-11-14, 사용자 승인)**: 원격 0004–0006 적용(기존 8건은 순서·완료·숨김 모두 비어 있어 영향 없음) → 재배포(Version `29f0e6f3-e96b-4be9-be86-861b62ad4e39`, 시작 시간 68ms) → 운영 확인: agenda에 `overdue` 포함, 완료 체크 → 다시 불러와도 유지 → 해제로 원상 복구, 순서 변경 400/403/415, 삭제 404/403. 새 화면 코드가 번들에 포함된 것도 확인. **검증 실수**: 삭제가 거부(409)될 거라 보고 고른 검증용 메모(`배포검증`, "과제 보고서 제출하기")가 실제로는 기한이 지나 있어 삭제(숨김)가 성공했다. 바로 `deleted_at = NULL`로 복구했고, 확인 전과 같은 상태임을 확인했다(숨김 → 보존 → 복구가 운영에서 동작함도 함께 확인됨). 운영에서 실제 순서 변경은 공유 화면을 바꾸므로 하지 않았다(로컬 브라우저 테스트로 확인).

**공개 데이터 참고**: 검증용 메모 5건(닉네임 `배포검증`)이 공개 목록에 보인다. 원격 D1 데이터 삭제는 승인이 필요하므로 그대로 두었다.

## 7. 실행한 검증 (마지막 실행: 2026-11-09)
| 명령 | 결과 |
|---|---|
| `npm run check:types` | 성공 |
| `npm test` | 5개 파일, **124개 테스트** 통과 (드래그 정렬, 완료 체크, 지나버린 일 시나리오 포함) |
| `npm run test:worker` | **7개 테스트** 통과 (빌드 Worker, workerd, CORS 없음, 403/415, `/api/usage`, `/api/agenda`) |
| 로컬 브라우저 확인 (headless Chrome + `dev:offline`, 시드 데이터, 2026-11-14) | **17/17 통과**: 드래그 중 표시, C를 맨 위로 드래그 → 새로고침 후 C·A·B 유지, ▲ 버튼, 체크 → 취소선 → 새로고침 유지 → 해제, 어제 기한 미완료 표시 / 완료·기한 없음 미표시, 삭제 → 새로고침 후 미복구, 모바일 390px 가로 스크롤 없음, 콘솔 오류 없음 |
| `npx wrangler deploy --dry-run` | 성공. 업로드 6.6MB / gzip 1.2MB, 바인딩 DO·D1·AI·vars |
| `npm run dev` + 실제 AI | §4 |
| `npx wrangler deploy` + 운영 확인 | §6 |

## 8. 다음 작업
1. 운영 중 `wrangler tail`이나 대시보드로 CPU 초과와 오류율을 주기적으로 확인한다(R2, R5).
2. 브라우저 수동 확인(U2), 모바일 폭 포함.
3. P1 남은 항목: 👍/👎 피드백, 작성자 필터 UI(API는 `nickname` 쿼리로 구현됨).
