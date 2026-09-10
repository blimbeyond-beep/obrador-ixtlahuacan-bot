/**
 * In-memory lead handoff tracking: first notify + one update per chat.
 */

type LeadState = { sent: boolean; updated: boolean };

const leads = new Map<string, LeadState>();

export function getLeadState(chatId: string): LeadState {
  let state = leads.get(chatId);
  if (!state) {
    state = { sent: false, updated: false };
    leads.set(chatId, state);
  }
  return state;
}

export function resetLeadFlag(
  chatId: string,
  flag: "sent" | "updated",
): void {
  const state = leads.get(chatId);
  if (!state) return;
  state[flag] = false;
}
