import type { MeResponse } from '../client/api.ts';
import { PROVIDER_ORDER, ProviderIcon } from './ProviderIcon.tsx';

/** First screen: social login (personal space) or the shared guest space. */
export function Landing({ me, onGuest }: { me: MeResponse; onGuest: () => void }) {
	return (
		<section className="card landing" aria-labelledby="landing-title">
			<h2 id="landing-title" className="landing__title">
				어떻게 시작할까요?
			</h2>
			<p className="muted small">로그인하면 나만 보는 개인 메모 공간이 생겨요. 로그인 없이도 함께 쓰는 공개 공간을 이용할 수 있어요.</p>
			<div className="landing__buttons">
				{PROVIDER_ORDER.map((id) => {
					const provider = me.providers[id];
					return provider.configured ? (
						<a key={id} className={`login-button login-button--${id}`} href={`/api/auth/${id}/start`}>
							<ProviderIcon id={id} />
							{provider.label}로 계속하기
						</a>
					) : (
						<span key={id} className={`login-button login-button--${id} is-disabled`} aria-disabled="true" title="아직 설정되지 않았어요">
							<ProviderIcon id={id} />
							{provider.label}로 계속하기 <span className="small">(준비 중)</span>
						</span>
					);
				})}
				<button type="button" className="login-button login-button--guest" onClick={onGuest}>
					익명의 스케줄로 시작하기
				</button>
			</div>
			<p className="muted small">
				「익명의 스케줄」은 모든 방문자가 함께 쓰는 공개 공간이에요. 입력한 내용은 누구나 보고 바꿀 수 있어요.
			</p>
		</section>
	);
}
