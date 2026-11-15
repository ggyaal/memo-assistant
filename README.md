# 메모비서 (Memo Assistant)

> AX School **Build Your Agent** 과제 — 떠오른 생각을 **글이나 음성**으로 한 번에 던지면 AI 에이전트가 메모로 나눠 정리하고 공유하는 **공개 체험 프로토타입**. 핵심은 할 일 관리보다 **기록의 진입장벽을 낮추는 것**입니다.

**데모: https://memo-assistant.ggyaal.workers.dev** (로그인 없이 사용) · 소개 글 초안: [docs/AX_CHALLENGE_SUBMISSION.md](docs/AX_CHALLENGE_SUBMISSION.md)

![음성 입력 화면](docs/screenshots/01-voice-input.png)

> ⚠️ **모든 메모와 닉네임은 모든 방문자에게 공개됩니다.** 개인정보나 비밀 내용을 입력하지 마세요. 닉네임은 표시용이며 로그인이나 본인 확인이 아닙니다. '익명'이어도 입력 내용 자체는 그대로 공개됩니다. 전화번호·이메일·주민번호·카드번호·'비밀번호: …' 같은 형식은 자동으로 막지만, 이름·주소 같은 다른 개인정보까지 모두 걸러내지는 못합니다.

## 누구를 위한 에이전트인가 / 무엇을 대신하나
- **대상**: 떠오르는 할 일·약속·아이디어를 한 문장에 몰아 적는 사람(학생, 직장인, 팀 프로젝트 참여자).
- **대신하는 일**: 뒤섞인 입력을 의미 단위로 **나누고**, `할 일/일정/아이디어/메모`로 **분류**하고, "내일 오후 3시" 같은 표현을 **요청 당시 한국 날짜 기준의 실제 일시로 해석**하고, 알림이 필요해 보이는지 **추천**한 뒤, 원문과 함께 **저장**합니다.

## 지금 되는 기능 / 아직 안 되는 기능
"확인됨"은 자동 테스트나 로컬 실행으로 직접 확인했다는 뜻입니다. 자세한 근거는 [docs/PROGRESS.md](docs/PROGRESS.md)에 있습니다.

| 기능 | 상태 |
|---|---|
| 닉네임 입력, 공개 고지, 개인정보 입력 금지 안내 | 확인됨 (운영 브라우저) |
| **음성 입력**: 버튼으로 녹음 시작/종료(최대 60초) → Workers AI Whisper로 글 변환 → 입력창에서 확인·수정 후 정리. 음성 파일은 저장하지 않음 | 확인됨 (운영: Chrome webm, 로컬: Safari 계열 mp4·wav 변환). 권한 거부·미지원 브라우저 안내 포함 |
| **민감정보 차단**: 전화번호·이메일·주민번호·카드번호·비밀번호 값 감지 시 화면 경고 + 서버가 AI 호출 전 거부 | 확인됨 (테스트 + 운영) |
| 하나의 입력을 여러 메모로 분리·분류하고 Flue Tool(`save_memos`)로 D1에 저장 | 확인됨 — mock 모델 테스트 + **실제 Workers AI(glm-4.7-flash) 로컬 호출** |
| 원문 보존, 각 메모의 `source_id` 연결 | 확인됨 |
| "내일 오후 3시"를 요청 시점 KST 기준으로 해석, 시각이 없는 표현("오늘")이나 기한 없는 메모에 일시를 만들지 않음 | 확인됨 (실제 AI + 서버 측 보정) |
| 같은 `requestId` 재요청 시 중복 저장·AI 재호출 없음 | 확인됨 |
| 오늘(KST) 등록 메모 / 전체 공개 메모 목록, 종류 필터, 더 보기 | 확인됨 (API) |
| 서버 측 입력 검증(닉네임 20자, 본문 1,000자, 요청 크기 8KB) | 확인됨 |
| 요청 제한(클라이언트별 분당 5회, 하루 전체 150회), 다른 사이트에서 보낸 요청 차단 | 확인됨 |
| 모델 오류·할당량 초과·시간 초과·DB 오류를 화면에 오류로 표시 | 확인됨 (API 응답) |
| 화면에 AI 사용량 표시: 오늘 사용 / 하루 한도, 누적 사용 횟수 (매일 오전 9시 KST 초기화) | 확인됨 (테스트 + 운영 반영) |
| 사이드 패널: 다가오는 **알림 추천을 시간순**으로, 기한 있는 메모를 **AI 우선순위(높음/보통/낮음) → 가까운 순**으로 순위 표시 | 확인됨 (테스트 + 운영 실제 AI). 실제 알림은 보내지 않음 |
| 우선순위 목록 **드래그 정렬**(▲▼ 버튼 포함). 저장되며 AI가 덮어쓰지 않음 | 확인됨 (테스트 + 로컬 브라우저 + 운영 반영) |
| 메모 **완료 체크 + 취소선**. 새로고침 후 유지, 해제하면 복구 | 확인됨 (테스트 + 로컬 브라우저 + 운영 반영) |
| **'지나버린 일'**: 기한이 지난 미완료 메모를 따로 표시하고 삭제(숨김) | 확인됨 (테스트 + 로컬 브라우저 + 운영 반영) |
| 실제 모델의 분류·우선순위 일관성 | 실행마다 카테고리·알림 추천·우선순위가 달라질 수 있음 (Phase 2에서 측정) |
| Cloudflare 배포 (Workers 무료 플랜) | 확인됨 — https://memo-assistant.ggyaal.workers.dev 에서 실제 AI 요청까지 확인 |
| 👍/👎 평가, 작성자 필터 UI | 아직 안 됨 |
| 실제 알림 발송, 로그인, 개인 메모, 메모 내용 수정, 검색 | **이번 범위 아님(구현하지 않음)**. 알림은 "추천" 배지만 표시합니다. |
| 모델이 시각을 빠뜨린 경우 고치기 | 안 됨 — 예: "내일 아침 9시"가 "시간 미정"으로 저장된 사례(운영). 수정 기능 없음 |

## 구조
```text
브라우저 (React)
  │ POST /api/memos {nickname, text, requestId}
  ▼
Cloudflare Worker — Hono (src/app.ts, src/server/routes.ts)
  ├─ 입력 검증 · 중복 requestId 확인 · 요청 제한 (D1 usage_counters)
  │
  ├─ init(MemoOrganizer).dispatch()  ← 서버가 정한 값은 initialData로 전달
  ▼
Flue 에이전트 MemoOrganizer (Durable Object, src/agents/memo-organizer.ts)
  ├─ Workers AI: @cf/zai-org/glm-4.7-flash  (원문 + KST 날짜표)
  └─ Tool 호출 save_memos (src/tools/save-memos.ts)
        └─ sanitizeMemo() 보정 → D1 batch: sources 1건 + memos N건
  ▼
D1 → 응답 → 결과 카드 / "오늘 등록된 메모" · "전체 공개 메모" · 사이드 패널(알림·우선순위·지나버린 일)

🎙️ MediaRecorder ─ POST /api/transcribe (audio/*) ─▶ Workers AI @cf/openai/whisper-large-v3-turbo
                                                     └▶ 텍스트만 응답(음성·텍스트 저장 안 함) → 입력창
```
- 에이전트는 HTTP로 직접 노출하지 않습니다. `/api/memos`만 거치므로 검증과 요청 제한을 우회할 수 없습니다.
- 모델은 닉네임, `source_id`, 생성 시각 같은 값을 정하거나 바꿀 수 없습니다.

## 기술
React 19 + TypeScript + Vite 8 · Flue 2.3 (`'use agent'`, `useTool`) · Cloudflare Workers + Durable Objects(SQLite) · Workers AI · D1 · Wrangler · Vitest + Miniflare

## 로컬 실행
필요: Node.js 22.19 이상, Cloudflare 계정(무료 플랜).

```bash
npm install
npx wrangler login                 # 실제 AI를 호출할 때만 필요
npm run db:migrate:local           # 로컬 D1(.wrangler/)에 스키마 적용
```

| 명령 | 설명 |
|---|---|
| `npm run dev:offline` | AI 없이 화면·D1·목록 API를 로컬에서 실행합니다. Neuron을 쓰지 않습니다. AI 정리 요청은 오류로 표시됩니다. |
| `npm run dev:cron` | 로컬 dev 서버의 예약 발송(Cron)을 1분마다 실행합니다. `vite dev`는 Cron을 스스로 돌리지 않으므로, 로컬에서 Discord 알림을 시험할 때 `npm run dev`와 함께 켜 두세요(운영에서는 Cloudflare가 자동 실행). |
| `npm run dev` | 실제 Workers AI를 호출합니다. **로컬 실행이어도 내 Cloudflare 계정의 무료 Neuron(하루 10,000)을 소모합니다**(1건당 약 36). 계정에 workers.dev 서브도메인이 등록되어 있어야 합니다. |

브라우저에서 http://localhost:5173 을 엽니다.

## 테스트
```bash
npm run check:types   # 타입 검사 (클라이언트 + Worker)
npm test              # 단위 + 로컬 D1 통합 + Flue 에이전트(faux 모델) 테스트
npm run test:worker   # 빌드한 Worker를 workerd + 로컬 D1에서 실행 (AI 스텁)
```
테스트는 실제 AI를 호출하지 않습니다. 에이전트 테스트는 Pi faux provider로 모델 응답을 스크립트로 정해 두고, 실제 Flue 런타임과 Tool, 로컬 D1을 그대로 실행합니다.

## 로그인 설정 (`feat/auth` 브랜치, 운영 미반영)
- 첫 화면에서 Google·Discord·카카오로 로그인하면 **나만 보는 개인 공간**, 로그인 없이 시작하면 모두가 함께 쓰는 **「익명의 스케줄」**(기존 공개 메모)이 열립니다.
- 키가 설정된 공급자만 로그인 버튼이 활성화됩니다(나머지는 "준비 중"). 로컬: `.dev.vars.example`을 `.dev.vars`로 복사해 값 입력. 운영: `npx wrangler secret put DISCORD_CLIENT_ID` 등.
- 비밀값 이름: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `KAKAO_REST_API_KEY`, `KAKAO_CLIENT_SECRET`(선택)
- 각 개발자 콘솔에 등록할 리디렉션 URI: `http://localhost:5173/api/auth/<provider>/callback`, `https://memo-assistant.ggyaal.workers.dev/api/auth/<provider>/callback`
- 로그인 후 **⚙️ 설정**: 닉네임 변경, 계정 연결, 알림 받을 경로 토글(Discord DM / 카카오톡·Gmail — 비활성). Discord는 켤 때 **테스트 DM이 실제로 도착해야** 켜집니다(알림 봇과 같은 서버에 있어야 함).
- **Discord 알림 카드·말투**: 알림 DM은 Embed 카드(분류, 한국 시간 예정/마감 — 날짜만 있으면 "시간 미정", 알림 시점, 안내 문장, 「메모비서에서 확인하기」 링크 버튼)로 보냅니다. 말투는 설정에서 친근한 비서(기본)·기본형·정중한 비서형·귀여운 말투 중 고르고(D1 `users.reminder_tone`), 「미리보기 DM」으로 실제 카드를 받아 볼 수 있습니다. 문장은 고정 템플릿에 제목·시간만 넣으며 **AI를 호출하지 않습니다**. 카드가 거부되면(400) 같은 알림을 텍스트로 한 번만 보냅니다. 변수 `PUBLIC_APP_URL`(버튼 주소).
- **캘린더**: 「📅 캘린더 / 📝 메모 목록」 전환(처음에는 캘린더). 사이드 카드는 처음에 「다가오는 알림」만 펼쳐져 있고, 직접 접거나 펼친 상태는 브라우저에 기억됩니다. 월요일 시작 월간 달력에 같은 메모를 **한국 날짜(`due_date`) 기준**으로 표시합니다(등록일 아님, 별도 테이블 없음, `GET /api/calendar?month=YYYY-MM`). 기본은 할 일·일정, 아이디어·메모는 필터로 표시. 날짜를 누르면 그날 메모 카드(수정·완료·알림 그대로)가 나오고, 현재 달에는 오늘 요약을 보여 줍니다. 개인 공간과 「익명의 스케줄」은 서버가 세션 기준으로 분리하며, AI를 호출하지 않습니다. 주간 보기는 아직 없습니다.
- **메모 수정**: 정리된 메모 카드의 「✏️ 수정」으로 제목·내용·분류·중요도·날짜·시각(선택)을 고칠 수 있습니다(`PUT /api/memos/:id`, 공간 범위·다른 사이트 차단·요청 제한 적용, 공개 공간은 개인정보 차단 후 모든 방문자에게 공유). 기한을 바꾸면 AI가 읽은 원문 표현은 지우고, 「N분 전」 방식 알림은 새 기한을 따라가며(4분 이내가 되면 취소), 직접 고른 시각의 알림은 그대로 둡니다.
- **사이드 카드**: 넓은 화면에서는 스크롤해도 화면에 고정되고(카드가 길면 패널 안에서 스크롤), 카드마다 접기/펼치기 버튼이 있습니다(브라우저에 기억). 💡 아이디어 목록 카드는 완료하지 않은 아이디어를 최신순으로 보여 줍니다.
- **반복·여러 날짜 일정**: "매일", "매주 월수금 오후 7시", "격주 화요일", "매월 15일", "평일마다", "주말마다"와 요일을 두 개 이상 적은 경우("월 화 금 헬스장", "이제부터 월, 화, 금")는 매주 반복으로, "다음 주 월, 목"·"이번 주말"은 그 날짜들만 한 번씩으로 저장합니다(`memos.recurrence` 한 행이 규칙, `due_at`/`due_date`는 첫 회차). "평일 아침", "주말에 청소"처럼 반복인지 분명하지 않으면 카드에서 「매주 반복 / 이번만」을 물어봅니다. 모델이 반복 문구를 빠뜨리면 메모 내용에서, 메모가 하나뿐이면 입력 원문에서 서버가 직접 읽습니다. 개인 공간의 반복 할 일·일정은 AI 추천과 관계없이 자동으로 알림이 예약되며, 시각이 없으면 회차 날 오전 9시(설정의 「날짜만 있는 메모」 시각을 정했으면 그 시각)에 보냅니다. 날짜 계산은 서버가 저장된 문구로만 하며 AI를 다시 부르지 않습니다. 회차마다 완료를 따로 체크하고(`memo_occurrences`), 캘린더에는 회차마다 표시됩니다. Discord 알림은 매 회차 "정시·N분 전"(시각 있는 일정) 또는 정한 시각(날짜만 있는 일정)에 보내고, `reminder_deliveries`로 같은 회차를 두 번 보내지 않습니다. 수정 폼에서 반복(매일·평일·주말·매주·격주·매월)을 바꿀 수 있습니다. 반복 일정은 통째로 "지나버린 일"이 되지 않고, 놓친 회차는 캘린더에서 미완료로 보입니다.
- **입력 카드**: 처음에는 접혀 있어 음성 입력 버튼만 보입니다. 버튼 문구는 방문할 때마다 「주저리.. 주저리..」「그 뭐더라...」 등 8개 중 하나로 바뀝니다(스크린리더에는 「음성으로 입력」으로 읽힘). 「⌨️ 글로 쓰기」로 펼치고, 음성이 글로 바뀌면 검토할 수 있게 자동으로 펼쳐집니다. 입력한 글이 있거나 정리 중이면 접히지 않습니다.
- **AI 정리 진행 표시**: 「AI로 정리하기」는 같은 `POST /api/memos`에 `Accept: text/event-stream`으로 요청해 서버가 실제로 도달한 단계만 SSE로 받습니다(입력 확인 → AI 분석 → 메모 N개 발견 → 저장 → 완료). 「N개 발견」·「저장」은 `save_memos` Tool이 Flue `useDataWriter`로 기록한 값이고, 타이머로 꾸미지 않습니다. AI 분석 중에는 「취소」로 그 요청의 에이전트를 중단합니다(`POST /api/memos/cancel`, D1 `memo_runs`에 진행 중으로 기록된 같은 공간의 요청만 — 없는 요청은 404이고 어떤 에이전트도 건드리지 않음). 오류는 기존과 같은 코드·문구로 해당 단계에 표시됩니다. Accept 헤더가 없으면 기존 JSON 응답 그대로입니다.
- **Discord 알림**: AI가 알림을 추천한 개인 메모는 **자동으로 예약**되고(정확한 시각 → 기본 30분 전, 날짜만 있는 메모 → 설정에서 시각을 정한 경우만), **다가오는 알림** 창의 스위치로 끌 수 있습니다(끈 알림은 다시 자동으로 켜지지 않음). 메모 카드에서도 직접 예약할 수 있습니다: 알림 받을 곳 토글(Discord / 카카오톡·Gmail은 준비 중이라 비활성)과 날짜·시각 입력 하나, 그 아래 「30분 전·10분 전·정시」 버튼(누르면 메모 시각 기준으로 입력칸을 채움). 지났거나 3분 이내인 시각은 막고, 지금부터 4분 이후면 기한 전후와 상관없이 예약할 수 있습니다(서버도 같은 규칙으로 검사). Cron(1분 간격)이 발송하고(Cloudflare는 매분 정해진 시점, 운영에서는 약 50초에 실행하므로 다음 실행 전까지 예정된 알림을 미리 가져와 **정각까지 기다렸다가** 보냄), 보내기 직전에 완료·삭제·채널 상태를 다시 확인하며, 같은 알림은 한 번만 보냅니다. 비밀값 `DISCORD_BOT_TOKEN`, 변수 `DISCORD_GUILD_ID`(봇이 있는 서버 ID)·`DISCORD_SERVER_INVITE`(초대 링크). 봇은 같은 서버 멤버에게만 DM을 보낼 수 있으므로, `DISCORD_GUILD_ID`가 있으면 설정 화면이 서버 가입 여부를 봇 API로 확인하고 미가입이면 초대 링크를 보여 주며 스위치를 잠급니다(서버도 켜기 요청 때 다시 확인). 확인이 안 될 때는 테스트 DM으로 판단합니다.

## 설정 (환경 변수 이름만 — 비밀값 없음)
`wrangler.jsonc`의 `vars`로 조정합니다. 비밀값(secret)은 필요하지 않습니다.
- `MEMO_MODEL`: 무료 플랜에서 쓸 수 있고 function calling을 지원하는 Workers AI 모델
- `RATE_LIMIT_PER_MINUTE`, `DAILY_AI_LIMIT`: AI 정리 요청 제한 값
- 바인딩: `AI`(Workers AI), `DB`(D1). Flue가 Durable Object 바인딩을 자동 생성합니다.

## 무료 서비스 의존성과 사용 제한
| 항목 | 한도 | 앱의 대응 |
|---|---|---|
| Workers AI | 하루 10,000 Neurons (00:00 UTC = 오전 9시 KST 초기화) | 메모 정리: 하루 150회 **그리고** 입력 길이 기반 예상 비용 6,000(1건 = 30 + 0.4 × 글자 수; 실측 짧은 입력 21–65, 463자 125–215). 음성: **실제 오디오 길이 기준 하루 30분**(약 1,400). 나머지 약 2,600은 예비. 클라이언트별 분당 제한. 초과 시 안내 |
| Workers / Durable Objects / D1 | 무료 플랜 한도 | 운영에서 호출당 CPU 10ms를 넘는 경우가 관찰됐지만 오류는 없었음([PROGRESS](docs/PROGRESS.md) R5) |
| 음성 변환 | 최대 60초 | 화면은 32kbps로 녹음하고 60초에 자동 종료(60초 ≈ 230KB). 서버는 600KB 초과를 거부하고, 모델이 보고한 길이가 65초를 넘으면 결과를 주지 않음. 화면에 "음성 변환 N분 / 30분" 표시 |

## 보안·공개 저장소 주의
- API 키, 토큰, `.env`, `.dev.vars`, `.wrangler/`(로컬 DB)는 `.gitignore`에 포함되어 있으며 **커밋하지 않습니다.** 이 앱은 Workers AI 바인딩을 쓰므로 별도 API 키가 필요하지 않습니다.
- 비밀값이 필요해지면 `npx wrangler secret put`을 사용합니다.
- 모델이 생성한 문자열은 HTML이 아닌 텍스트로만 표시합니다.
- **공유 게시판 편집**: 드래그 순서, 완료 체크, '지나버린 일' 삭제는 로그인 없이 **모든 방문자에게 똑같이 적용**됩니다(누구나 바꿀 수 있음). 삭제는 기한이 지난 미완료 메모만 가능하고, DB에서 지우지 않고 숨기기만 합니다(soft delete). 편집 요청도 같은 출처의 JSON 요청만 받고, 클라이언트당 분당 30회로 제한합니다.
- 클라이언트 IP는 저장하지 않고, 요청 제한용 해시만 잠시 보관합니다.
- API는 JSON 요청과 같은 출처만 허용하고, API·정적 자산 모두 보안 헤더(CSP 등)를 보냅니다. 점검 내역은 [docs/PROGRESS.md](docs/PROGRESS.md) §5에 있습니다.

## 과제 제출
- 이 저장소를 GitHub에 **Public**으로 공개해 제출합니다.
- 제출 전 확인: `git status`에 `.env`, `.dev.vars`, `.wrangler/`가 없어야 합니다.
- 배포 방법(이미 배포됨): `npx wrangler d1 migrations apply DB --remote` → `npm run build && npx wrangler deploy`
- 포크해서 다른 계정에 배포할 때는 `npx wrangler d1 create memo-assistant`로 만든 ID를 `wrangler.jsonc`의 `database_id`에 넣으세요.

## 문서
- [docs/AX_CHALLENGE_SUBMISSION.md](docs/AX_CHALLENGE_SUBMISSION.md): 사이드 프로젝트 소개 글 초안(운영 실측 예시)
- [docs/AX_CHALLENGE_DEMO.md](docs/AX_CHALLENGE_DEMO.md): 데모 녹화 순서·테스트 입력·캡처 가이드
- [docs/SPEC.md](docs/SPEC.md): 제품 명세
- [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md): 구현 지시
- [docs/PROGRESS.md](docs/PROGRESS.md): 진행 기록, 이슈, 검증 결과
- [CLAUDE.md](CLAUDE.md): Claude Code 작업 지침

## License
[LICENSE](LICENSE)
