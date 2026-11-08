import type { RejectReason } from "./executor.js";
import { EditSession } from "./session.js";
import { buildUserMessage, SYSTEM_PROMPT, type ChatMessage } from "./prompt.js";

export interface ModelClientConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** GBNF grammar attached to requests when configured; honored by capable servers, ignored elsewhere. Off by default. */
  grammar?: string;
}

export interface Completer {
  complete(messages: ChatMessage[]): Promise<string>;
}

/** OpenAI-compatible chat-completions client (any /chat/completions endpoint). */
export class ModelClient implements Completer {
  #config: ModelClientConfig;

  constructor(config: ModelClientConfig) {
    this.#config = config;
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    const { baseUrl, model, apiKey, grammar } = this.#config;
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, messages, ...(grammar !== undefined ? { grammar } : {}) }),
    });
    if (!res.ok) throw new Error(`model request failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (content === undefined) {
      throw new Error(`unexpected model response: ${JSON.stringify(json).slice(0, 300)}`);
    }
    return content;
  }
}

export interface TurnResult {
  ok: boolean;
  /** Raw model response (the attempted op script), for chat-log transparency. */
  op: string;
  reason?: RejectReason;
  /** User-facing message. */
  message: string;
}

const REPHRASE = "Please rephrase your command.";

function rejectionMessage(reason: RejectReason): string {
  switch (reason) {
    case "parse_error":
      return `I couldn't turn the model's response into a valid op line. ${REPHRASE}`;
    case "no_match":
      return `The model's edit doesn't fit the current document. ${REPHRASE}`;
    case "unchanged":
      return "Nothing changed.";
  }
}

/**
 * Model-driven edit session: builds the prompt, calls the model, and applies
 * the response as a single op (or rejects with a user-facing message, leaving
 * the doc untouched).
 */
export class ChatEditSession {
  #client: Completer;
  #session: EditSession;

  constructor(client: Completer, doc: string) {
    this.#client = client;
    this.#session = new EditSession(doc);
  }

  get doc(): string {
    return this.#session.doc;
  }

  async send(command: string): Promise<TurnResult> {
    // No trim here: parseOps skips whitespace lines but must keep trailing
    // spaces on op lines (they can be payload).
    const raw = await this.#client.complete([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserMessage(this.#session.doc, command) },
    ]);

    const result = this.#session.apply(raw);
    if (result.ok) {
      const message = result.reverted
        ? "Reverted last edit."
        : result.nothingToUndo
          ? "Nothing to undo."
          : "Applied edit.";
      return { ok: true, op: raw, message };
    }
    return { ok: false, op: raw, reason: result.reason, message: rejectionMessage(result.reason) };
  }
}
