'use agent';
import { useDataWriter, useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { env } from 'cloudflare:workers';
import { createSaveMemosTool, type MemoJob, MemoJobSchema } from '../tools/save-memos.ts';

/** Name of the data part that carries save progress to the waiting request. */
export const PROGRESS_PART = 'progress';
const ProgressSchema = v.object({ stage: v.picklist(['found', 'saving']), count: v.number() });

/** Free-plan Workers AI model with function calling (see docs/PROGRESS.md). */
export const DEFAULT_MODEL = 'cloudflare/@cf/zai-org/glm-4.7-flash';

const INSTRUCTIONS = `당신은 한국어 메모 정리 도우미입니다. <signal> 본문은 사용자가 한 번에 적은 여러 생각입니다.

해야 할 일:
1. 본문을 의미 단위의 독립 메모로 나눕니다. 서로 다른 주제·할 일은 반드시 별도 메모로 분리합니다.
2. 각 메모의 category를 정합니다.
   - todo: 사용자가 실행하고 끝내야 하는 행동 (기한이 있을 수 있음)
   - schedule: 정해진 시각에 일어나는 약속·행사·회의 (그 시각에 어딘가 있거나 참여함)
   - idea: 발전시킬 생각·기획
   - note: 나중에 참고할 기록·정보
   날짜·시각이 있다고 모두 schedule이 아닙니다. "오후 3시까지 보고서 제출"은 마감이 있는 todo, "오후 3시 발표"·"월요일 오전 10시 회의"는 schedule입니다. 분류와 날짜·알림·우선순위는 서로 독립적으로 정합니다.
3. title은 짧은 명사구(20자 이내), content는 원문 의미를 유지한 한 문장으로 씁니다.
4. due_text: 원문에 기한·일시 표현이 있으면 원문 그대로(예: "내일 오후 3시") 적고, 없으면 null.
   반복("매일", "매주", "격주", "매월", "평일", "주말", "~마다")이나 여러 요일("월수금", "월, 목", "월요일과 목요일")이 있으면 그 표현을 빠짐없이 원문 그대로 due_text에 넣으세요(예: "매주 월수금 오후 7시", "이제부터 월, 화, 금"). 반복되는 일은 요일별로 나누지 말고 메모 하나로 만듭니다. 반복·여러 날짜의 날짜 계산은 서버가 하므로 직접 계산하지 마세요.
5. due_at: 날짜와 시각이 모두 명확할 때만 signal 속성의 date_reference 표를 보고 "YYYY-MM-DDTHH:mm:00+09:00"(한국 시간) 형식으로 씁니다.
   - 시각이 없거나("오늘", "이번 주") 불명확하면("다음에", "언젠가") due_at은 null입니다.
   - 입력에 없는 날짜·시간·사실을 절대 만들지 마세요.
6. due_date: 원문이 특정한 하루를 가리키면(예: "오늘", "금요일", "11월 20일") date_reference 표를 보고 "YYYY-MM-DD"로 씁니다. 시각이 없어도 됩니다. 하루를 특정할 수 없으면("다음 주", "언젠가") null입니다.
7. reminder_recommended: 기한이나 일시가 있는 할 일·일정이면 true, 아니면 false. true일 때만 reminder_reason을 한 문장으로 씁니다. (실제 알림은 보내지 않습니다.)
8. priority: 각 메모의 중요도·긴급도를 high / medium / low 중 하나로 정하고, priority_reason에 근거를 한 문장으로 씁니다.
   - high: 기한이 임박했거나(오늘·내일), 건강·약속·마감처럼 놓치면 곤란한 일
   - medium: 기한이 있지만 여유가 있는 일
   - low: 기한이 없는 아이디어·기록, 하지 않아도 큰 문제가 없는 일

반드시 save_memos 도구를 한 번만 호출해 모든 메모를 한꺼번에 저장하세요. 저장 후에는 추가 설명 없이 끝냅니다.`;

export function MemoOrganizer() {
	const job = useInitialData<MemoJob>();
	useModel(env.MEMO_MODEL || DEFAULT_MODEL);
	// Streamed to the waiting request as it happens (the model never sees it).
	const writeProgressData = useDataWriter(PROGRESS_PART, { schema: ProgressSchema });
	useTool(createSaveMemosTool({ db: env.DB, job, onProgress: writeProgressData }));
	return INSTRUCTIONS;
}

// Pin the durable identity (-> Durable Object class FlueMemoOrganizerAgent).
MemoOrganizer.agentName = 'memo-organizer';
// Validated once when an instance is created; one instance per request.
MemoOrganizer.initialData = MemoJobSchema;
