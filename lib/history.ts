/**
 * In-memory per-chat conversation history (lost on cold start / redeploy).
 */

import type OpenAI from "openai";

export type HistoryMessage = OpenAI.Chat.ChatCompletionMessageParam;

const histories = new Map<string, HistoryMessage[]>();

function maxHistory(): number {
  const n = Number.parseInt(process.env.MAX_HISTORY || "24", 10);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

export function getHistory(chatId: string): HistoryMessage[] {
  let list = histories.get(chatId);
  if (!list) {
    list = [];
    histories.set(chatId, list);
  }
  return list;
}

export function appendHistory(chatId: string, msg: HistoryMessage): void {
  const list = getHistory(chatId);
  list.push(msg);
  const max = maxHistory();
  while (list.length > max) {
    list.shift();
  }
}

export function clearHistory(chatId: string): void {
  histories.delete(chatId);
}
