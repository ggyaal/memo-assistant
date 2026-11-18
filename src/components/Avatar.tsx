import { useState } from 'react';

/**
 * Profile picture from the social account, or the default image when there is none, the person
 * declined it (e.g. Kakao optional consent), or it fails to load. No referrer is sent.
 */
export function Avatar({ url, size = 28, label }: { url: string | null | undefined; size?: number; label?: string }) {
	const [broken, setBroken] = useState(false);
	const style = { width: size, height: size };
	if (!url || broken) {
		return (
			<span className="avatar avatar--default" style={style} role="img" aria-label={label ?? '기본 프로필 이미지'}>
				<svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62} aria-hidden="true">
					<circle cx="12" cy="8" r="4" fill="currentColor" />
					<path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" fill="currentColor" />
				</svg>
			</span>
		);
	}
	return (
		<img
			className="avatar"
			style={style}
			src={url}
			alt={label ?? '프로필 사진'}
			referrerPolicy="no-referrer"
			loading="lazy"
			onError={() => setBroken(true)}
		/>
	);
}
