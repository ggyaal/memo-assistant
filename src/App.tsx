import { type FormEvent, useState } from 'react';
import { AgendaPanel } from './components/AgendaPanel.tsx';
import { MemoCard } from './components/MemoCard.tsx';
import { MemoInput } from './components/MemoInput.tsx';
import { MemoList } from './components/MemoList.tsx';
import { UsageMeter } from './components/UsageMeter.tsx';
import { describeSensitive, detectSensitive } from './shared/privacy.ts';
import { LIMITS, type CreateMemosResponse } from './shared/types.ts';

const NICKNAME_KEY = 'memo-assistant:nickname';

function readNickname(): string {
	try {
		return localStorage.getItem(NICKNAME_KEY) ?? '';
	} catch {
		return '';
	}
}

export function App() {
	const [nickname, setNickname] = useState(readNickname);
	const [draft, setDraft] = useState(nickname);
	const [lastResult, setLastResult] = useState<CreateMemosResponse | null>(null);
	const [refreshKey, setRefreshKey] = useState(0);
	const [usageKey, setUsageKey] = useState(0);
	// Bumped after a board edit (done / reorder / delete) to reload the side panel only.
	const [agendaKey, setAgendaKey] = useState(0);

	function saveNickname(event: FormEvent) {
		event.preventDefault();
		const value = draft.trim().slice(0, LIMITS.nicknameMax);
		if (!value || detectSensitive(value).length > 0) return;
		setNickname(value);
		try {
			localStorage.setItem(NICKNAME_KEY, value);
		} catch {
			// Storage is only a convenience.
		}
	}

	return (
		<main className="container layout">
			<div className="layout__top">
			<header className="hero">
				<h1>Memo Assistant</h1>
				<p className="muted">여러 생각을 한 번에 적으면 AI가 할 일·일정·아이디어·메모로 나눠 정리합니다.</p>
			</header>

			<aside className="notice" role="note">
				<strong>공개 체험 데모입니다.</strong> 입력한 내용과 닉네임은 <strong>모든 방문자에게 공개</strong>됩니다.
				이름·연락처·주소·건강 정보 등 개인정보나 비밀 내용을 입력하지 마세요. 닉네임은 표시용일 뿐 로그인/본인 확인이 아닙니다.
				알림 추천은 표시만 하며 실제 알림은 보내지 않습니다.
			</aside>

			<UsageMeter refreshKey={usageKey} />

			{nickname ? (
				<>
					<p className="row space-between small">
						<span>
							닉네임: <strong>{nickname}</strong>
						</span>
						<button type="button" className="link-button" onClick={() => setNickname('')}>
							변경
						</button>
					</p>
					<MemoInput
						nickname={nickname}
						onCreated={(result) => {
							setLastResult(result);
							setRefreshKey((k) => k + 1);
						}}
						onSettled={() => setUsageKey((k) => k + 1)}
					/>
				</>
			) : (
				<form className="card" onSubmit={saveNickname}>
					<label htmlFor="nickname" className="label">
						공개될 닉네임을 정해 주세요
					</label>
					<input
						id="nickname"
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						maxLength={LIMITS.nicknameMax}
						placeholder={`최대 ${LIMITS.nicknameMax}자, 실명 대신 별명 권장`}
						autoComplete="off"
					/>
					{detectSensitive(draft).length > 0 && (
						<p className="warning" role="alert">
							⚠️ 닉네임에 {describeSensitive(detectSensitive(draft))}를 쓰지 마세요. 닉네임도 모두에게 공개됩니다.
						</p>
					)}
					<button type="submit" className="primary" disabled={!draft.trim() || detectSensitive(draft).length > 0}>
						시작하기
					</button>
				</form>
			)}

			{lastResult && (
				<section className="result" aria-live="polite">
					<h2>
						방금 정리된 메모 {lastResult.memos.length}개{lastResult.duplicate && ' (이미 저장된 요청)'}
					</h2>
					<div className="cards">
						{lastResult.memos.map((memo) => (
							<MemoCard key={memo.id} memo={memo} showSource={false} onChanged={() => setRefreshKey((k) => k + 1)} />
						))}
					</div>
				</section>
			)}
			</div>

			{/* Side panel on wide screens; between the input and the list on mobile. */}
			<aside className="layout__side" aria-label="다가오는 알림과 일정 우선순위">
				<AgendaPanel refreshKey={refreshKey + agendaKey} onChanged={() => setRefreshKey((k) => k + 1)} />
			</aside>

			<div className="layout__bottom">
				<MemoList refreshKey={refreshKey} onChanged={() => setAgendaKey((k) => k + 1)} />

				<footer className="muted small center footer">
					AX School Build Your Agent · Flue + Cloudflare Workers AI + D1 프로토타입
				</footer>
			</div>
		</main>
	);
}
