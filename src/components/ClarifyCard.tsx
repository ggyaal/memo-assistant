import { useMemo, useState } from 'react';
import { ApiRequestError, commitDraft, discardDraft } from '../client/api.ts';
import { CATEGORY_LABELS, formatDue } from '../client/format.ts';
import { applyAnswers, type ClarifyAnswer } from '../shared/clarify.ts';
import { describeRecurrence } from '../shared/recurrence.ts';
import type { CreateMemosResponse, MemoDraftPayload } from '../shared/types.ts';

/**
 * One clarifying question at a time for an organized input that is not saved yet.
 * Buttons and pickers are applied by fixed rules (no AI). Saving happens once: after the last
 * question, or right away with "추가 질문 안 하기" (skipped parts stay undecided).
 */
export function ClarifyCard({
	draft,
	onSaved,
	onDiscarded,
	onExpired,
}: {
	draft: MemoDraftPayload;
	onSaved: (result: CreateMemosResponse) => void;
	/** "저장 취소": the input text stays in the box. */
	onDiscarded: () => void;
	/** The draft can no longer be saved (expired / closed); the text stays in the box. */
	onExpired: (message: string) => void;
}) {
	const [index, setIndex] = useState(0);
	const [answers, setAnswers] = useState<ClarifyAnswer[]>([]);
	const [picked, setPicked] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const question = draft.questions[index];

	// Preview: answered/skipped questions applied; memos still being asked are marked.
	const preview = useMemo(
		() => applyAnswers(draft.memos, draft.questions.slice(0, index), answers, new Date()),
		[draft, index, answers],
	);
	const pendingMemos = new Set(draft.questions.slice(index).map((q) => q.memoIndex));

	async function save(final: ClarifyAnswer[]) {
		setBusy(true);
		setError(null);
		try {
			onSaved(await commitDraft(draft.id, final));
		} catch (e) {
			const err = e instanceof ApiRequestError ? e : null;
			if (err?.status === 410 || err?.status === 404) onExpired(err.message);
			else setError(err?.message ?? '저장하지 못했어요. 다시 시도해 주세요.');
		} finally {
			setBusy(false);
		}
	}

	function next(answer: ClarifyAnswer | null) {
		const all = answer ? [...answers.filter((a) => a.questionId !== answer.questionId), answer] : answers;
		setAnswers(all);
		setPicked('');
		if (index + 1 >= draft.questions.length) void save(all);
		else setIndex(index + 1);
	}

	async function discard() {
		setBusy(true);
		try {
			await discardDraft(draft.id);
		} catch {
			// already gone: nothing was saved either way
		} finally {
			setBusy(false);
			onDiscarded();
		}
	}

	if (!question) return null;
	const pickerOk = question.picker === 'time' ? /^([01]\d|2[0-3]):[0-5]\d$/.test(picked) : /^\d{4}-\d{2}-\d{2}$/.test(picked);
	return (
		<section className="clarify" aria-labelledby="clarify-title">
			<p className="clarify__step small muted">
				확인 {index + 1}/{draft.questions.length} · 저장 전이에요
			</p>
			<h3 id="clarify-title" className="clarify__question">
				{question.prompt}
			</h3>
			<div className="clarify__options" role="group" aria-label="답 고르기">
				{question.options.map((o) => (
					<button key={o.id} type="button" className="clarify__option" disabled={busy} onClick={() => next({ questionId: question.id, optionId: o.id })}>
						{o.label}
					</button>
				))}
			</div>
			{question.picker && (
				<div className="clarify__picker">
					<label className="small">
						직접 {question.picker === 'time' ? '시각' : '날짜'}
						<input type={question.picker} value={picked} onChange={(e) => setPicked(e.target.value)} />
					</label>
					<button type="button" className="link-button small" disabled={busy || !pickerOk} onClick={() => next({ questionId: question.id, value: picked })}>
						이 값으로
					</button>
				</div>
			)}
			<div className="clarify__actions">
				<button type="button" className="link-button" disabled={busy} onClick={() => next(null)}>
					이번 질문 건너뛰기
				</button>
				<button type="button" className="primary small" disabled={busy} onClick={() => void save(answers)}>
					추가 질문 안 하기
				</button>
				<button type="button" className="link-button memo-card__delete" disabled={busy} onClick={() => void discard()}>
					저장 취소
				</button>
			</div>
			{busy && (
				<p className="small muted" role="status">
					저장하는 중…
				</p>
			)}
			{error && (
				<p className="error small" role="alert">
					{error}
				</p>
			)}
			<div className="clarify__preview" aria-label="정리 미리보기">
				<p className="small muted">정리된 내용 미리보기 (건너뛴 항목은 미정으로 저장돼요)</p>
				<ul>
					{preview.map((m, i) => (
						<li key={i} className={pendingMemos.has(i) ? 'is-pending' : undefined}>
							<span className={`badge badge--${m.category}`}>{CATEGORY_LABELS[m.category]}</span> <strong>{m.title}</strong>
							<span className="muted small">
								{' '}
								· {pendingMemos.has(i) ? '❓ 확인 중' : formatDue(m) ?? '날짜 없음'}
								{m.recurrence ? ` · 🔁 ${describeRecurrence(m.recurrence)}` : m.recurrence_question && !pendingMemos.has(i) ? ' · 반복 여부 미정' : ''}
							</span>
						</li>
					))}
				</ul>
			</div>
		</section>
	);
}
