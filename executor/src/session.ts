import { applyParsed, normalize, OpParseError, parseOps, trimDoc, type ApplyResult, type Op } from "./executor.js";

/**
 * Applies op scripts to the current doc. Holds the single-level undo state:
 * the model only ever emits a bare `UNDO` line, the session supplies the
 * previous document. The doc is edge-trimmed on load and normalized (playbook
 * formatting cleanup, including parts the model did not touch) after every
 * successful edit; rejected scripts leave the doc untouched.
 */
export class EditSession {
  #doc: string;
  #prev: string | null = null;

  constructor(doc: string) {
    this.#doc = trimDoc(doc);
  }

  get doc(): string {
    return this.#doc;
  }

  /** `view` defaults to the stored doc; callers that show an alternate numbered
   * form may pass it. Ops apply against the view, while zero-diff and undo still
   * compare/restore the real doc. */
  apply(raw: string, view: string = this.#doc): ApplyResult {
    let ops: Op[];
    try {
      ops = parseOps(raw);
    } catch (e) {
      return { ok: false, reason: "parse_error", message: (e as OpParseError).message };
    }
    if (ops[0]!.kind === "UNDO") {
      // parseOps guarantees UNDO comes alone
      if (this.#prev === null) {
        return { ok: true, doc: this.#doc, before: this.#doc, nothingToUndo: true };
      }
      const before = this.#doc;
      this.#doc = this.#prev;
      this.#prev = null;
      return { ok: true, doc: this.#doc, before, reverted: true };
    }
    const result = applyParsed(view, ops);
    if (result.ok) {
      const doc = normalize(result.doc);
      if (doc === this.#doc) {
        // Zero-diff: the script applied but changed nothing — not a success.
        // Doc and undo history stay untouched.
        return { ok: false, reason: "unchanged", message: "Nothing changed." };
      }
      this.#prev = this.#doc;
      this.#doc = doc;
      return { ok: true, doc, before: result.before };
    }
    return result;
  }
}
