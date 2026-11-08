import { splitLines } from "./executor.js";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** Must match the dataset system prompt byte-for-byte (data/udiff_dataset.jsonl). */
export const SYSTEM_PROMPT = "Convert the edit instruction into exactly one op line for the numbered document.";

/** Render a doc as `[L01] line` lines — the same format the ops address. */
export function numbered(doc: string): string {
  return splitLines(doc).map((line, idx) => `[L${String(idx + 1).padStart(2, "0")}] ${line}`).join("\n");
}

/** Canonical user-message format, shared by the dataset (make-dataset.ts) and live sessions. */
export function buildUserMessage(doc: string, command: string): string {
  return `${command}\n\n---\n\n${numbered(doc)}`;
}
