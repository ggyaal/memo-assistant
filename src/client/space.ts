import { createContext, useContext } from 'react';

export type ReminderChannel = 'discord' | 'email';

/**
 * shared: the shared guest board (edits affect everyone).
 * channels: personal space channels that are on and verified (Discord DM, e-mail); each one is independent.
 * remindersReady: at least one of them is on, so reminders can be booked.
 */
export interface Space {
	shared: boolean;
	channels: ReminderChannel[];
	remindersReady: boolean;
}

export const SpaceContext = createContext<Space>({ shared: true, channels: [], remindersReady: false });

export const CHANNEL_LABELS: Record<ReminderChannel, string> = { discord: 'Discord', email: '이메일' };

/** "Discord·이메일" */
export function channelNames(channels: ReminderChannel[]): string {
	return channels.map((c) => CHANNEL_LABELS[c]).join('·');
}

export function useSpace() {
	return useContext(SpaceContext);
}
