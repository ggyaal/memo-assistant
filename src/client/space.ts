import { createContext, useContext } from 'react';

/**
 * shared: the shared guest board (edits affect everyone).
 * discordReady: personal space with a verified Discord channel (reminders can be booked).
 */
export const SpaceContext = createContext<{ shared: boolean; discordReady: boolean }>({ shared: true, discordReady: false });

export function useSpace() {
	return useContext(SpaceContext);
}
