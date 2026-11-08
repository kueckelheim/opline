/**
 * Op executor: parses exactly one model op line and applies it to a document.
 * Reference semantics for the data generators (data-generation/udiff-l).
 * Grammar: ADD, APP, DEL, RM, REP, INSB, INSA, UNDO. There is no CON.
 * Every script is exactly one op. All-or-nothing: the doc is only replaced on
 * full success.
 *
 * Docs are assumed newline-terminated (corpus guarantee); a doc without a
 * trailing newline gains one.
 */

export type OpKind = "DEL" | "ADD" | "INSB" | "INSA" | "RM" | "REP" | "APP" | "UNDO";

export interface Op {
  kind: OpKind;
  /** 1-based input line number (0 for APP/UNDO: no tag). */
  line: number;
  /** Payload/inserted text. For RM this is the fragment to remove; for
   * INSB/INSA it is the payload after `||`; for REP it is the new text. */
  text: string;
  /** Quote copied from the doc: anchor for DEL/INSB/INSA, old text for REP. */
  anchor?: string;
}

const SURGERY_KINDS: readonly OpKind[] = ["DEL", "INSB", "INSA", "RM", "REP", "APP"];

function isSurgery(kind: OpKind): boolean {
  return (SURGERY_KINDS as readonly string[]).includes(kind);
}

/** Reasons for a non-ok apply. "unchanged" is session-level only: the pure
 * applier happily applies a script that leaves the doc byte-identical. */
export type RejectReason = "parse_error" | "no_match" | "unchanged";

export type ApplyResult =
  | { ok: true; doc: string; before: string; reverted?: boolean; nothingToUndo?: boolean }
  | { ok: false; reason: RejectReason; message: string };

export class OpParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpParseError";
  }
}

/** Strict single-op parse. Line-addressed forms:
 *   ADD [Lnn] <text>
 *   DEL [Lnn] <anchor>
 *   RM  [Lnn] <fragment>
 *   REP [Lnn] <old> || <new>
 *   INSB/INSA [Lnn] <anchor> || <payload>
 * plus the tag-less `APP <text>` and the bare `UNDO` meta op. */
export function parseOp(raw: string): Op {
  if (raw === "UNDO") return { kind: "UNDO", line: 0, text: "" };
  if (raw === "APP" || raw.startsWith("APP ")) {
    const payload = raw === "APP" ? "" : raw.slice(4);
    if (payload.trim() === "") throw new OpParseError("APP requires payload text");
    return { kind: "APP", line: 0, text: payload };
  }
  const sp1 = raw.indexOf(" ");
  if (sp1 === -1) throw new OpParseError(`malformed op line: ${JSON.stringify(raw)}`);
  const kindText = raw.slice(0, sp1);
  if (kindText === "CON") throw new OpParseError("CON is not part of the grammar");
  const kind = kindText as OpKind;
  if (kind !== "ADD" && !isSurgery(kind)) {
    throw new OpParseError(`unknown op kind: ${JSON.stringify(kind)}`);
  }
  const rest = raw.slice(sp1 + 1);
  const sp2 = rest.indexOf(" ");
  const tag = sp2 === -1 ? rest : rest.slice(0, sp2);
  const m = /^\[L(\d+)\]$/.exec(tag);
  if (!m) throw new OpParseError(`bad line tag: ${JSON.stringify(tag)}`);
  const line = parseInt(m[1]!, 10);
  if (line < 1) throw new OpParseError(`line number must be >= 1: ${JSON.stringify(tag)}`);
  const text = sp2 === -1 ? "" : rest.slice(sp2 + 1);
  if (kind === "DEL") {
    const anchor = text.trim();
    if (anchor === "") throw new OpParseError("DEL requires an anchor");
    return { kind, line, text: "", anchor };
  }
  if (kind === "RM") {
    const fragment = text.trim();
    if (fragment === "") throw new OpParseError("RM requires a fragment");
    return { kind, line, text: fragment };
  }
  if (kind === "REP") {
    const sep = text.indexOf("||");
    if (sep === -1) throw new OpParseError("REP requires an old || new split");
    const oldText = text.slice(0, sep).trim();
    const newText = text.slice(sep + 2).trim();
    if (oldText === "") throw new OpParseError("REP old text must not be empty");
    if (newText === "") throw new OpParseError("REP new text must not be empty");
    return { kind, line, text: newText, anchor: oldText };
  }
  if (kind === "INSB" || kind === "INSA") {
    const sep = text.indexOf("||");
    if (sep === -1) throw new OpParseError(`${kind} requires an anchor || payload split`);
    const anchor = text.slice(0, sep).trim();
    if (anchor === "") throw new OpParseError(`${kind} anchor must not be empty`);
    return { kind, line, anchor, text: text.slice(sep + 2).trim() };
  }
  if (text.trim() === "") throw new OpParseError("ADD requires text");
  return { kind, line, text };
}

/** Strict op-script parse; whitespace-only lines are noise and skipped.
 * Never trims the op lines themselves — trailing whitespace can be payload.
 * A script contains exactly one op, for every kind. */
export function parseOps(raw: string): Op[] {
  const ops: Op[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    ops.push(parseOp(line));
  }
  if (ops.length === 0) throw new OpParseError("empty response");
  if (ops.length > 1) throw new OpParseError("a script must contain exactly one op");
  return ops;
}

/** Split into lines the way the reference compiler does: a final newline creates no extra line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
}

function render(lines: string[]): string {
  return lines.map((line) => line + "\n").join("");
}

/** Trim whitespace-only lines from both edges, plus edge whitespace of the
 * first/last content line; keep a single trailing newline. Empty doc stays "". */
export function trimDoc(doc: string): string {
  const lines = splitLines(doc);
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  if (start === end) return "";
  lines[start] = lines[start]!.replace(/^\s+/, "");
  lines[end - 1] = lines[end - 1]!.replace(/\s+$/, "");
  return render(lines.slice(start, end));
}

// --- normalize (playbook formatting cleanup) -----------------------------------

const HEADING_RE = /^#{1,2} /;
const LIST_RE = /^(?:- |\d+\. )/;
type Block = "heading" | "list" | "para";

function blockOf(line: string): Block {
  if (HEADING_RE.test(line)) return "heading";
  if (LIST_RE.test(line)) return "list";
  return "para";
}

/** Playbook formatting cleanup, applied by the session after every successful
 * edit — even parts of the doc the model did not touch:
 * - no empty line after a heading; exactly one empty line before a heading
 *   (none at doc start)
 * - empty line after a list / paragraph when content follows
 * - no trailing whitespace per line (incl. double-space line breaks)
 * - trim leading/trailing blank lines and edge whitespace of the first/last
 *   content lines; collapse consecutive empty lines to one
 * - single trailing newline; "" stays "".
 * Fenced code block interiors stay verbatim (no spacing/whitespace cleanup). */
export function normalize(doc: string): string {
  const lines = splitLines(doc);
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  if (start === end) return "";
  lines[start] = lines[start]!.replace(/^\s+/, "");
  lines[end - 1] = lines[end - 1]!.replace(/\s+$/, "");
  const out: string[] = [];
  let prev: Block | null = null;
  let fence = false;
  for (let i = start; i < end; i++) {
    let line = lines[i]!;
    const isFence = /^\s*```/.test(line);
    if (isFence && fence) {
      fence = false;
      out.push(line); // closing marker: tight after the interior
      prev = "para";
      continue;
    }
    if (isFence) fence = true;
    else if (fence) {
      out.push(line); // code block interior: untouched
      continue;
    } else {
      line = line.replace(/\s+$/, "");
      if (line === "") continue; // blank lines are re-inserted per the spacing rules
    }
    const blk: Block = isFence ? "para" : blockOf(line);
    if (
      prev !== null &&
      (blk === "heading" ? prev !== "heading" : prev === "heading" ? false : prev === "list" ? blk !== "list" : true)
    ) {
      out.push("");
    }
    out.push(line);
    prev = blk;
  }
  return render(out);
}

// --- quote-anchored ops (DEL/REP/RM/INSB/INSA/APP) -----------------------------

/** Whitespace runs collapsed to one space + case-folded. */
function foldNorm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Word-array Levenshtein similarity in [0,1] (same metric as the eval sweep). */
function wordSim(a: string, b: string): number {
  const wa = a.split(/\s+/).filter(Boolean);
  const wb = b.split(/\s+/).filter(Boolean);
  if (wa.length === 0 && wb.length === 0) return 1;
  let prev = Array.from({ length: wb.length + 1 }, (_, j) => j);
  for (let i = 1; i <= wa.length; i++) {
    const cur = [i];
    for (let j = 1; j <= wb.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (wa[i - 1] === wb[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[wb.length]! / Math.max(wa.length, wb.length);
}

/** Tiers 1-2: exact substring, then whitespace-collapsed + case-folded. */
function matchExact(line: string, quote: string): { start: number; end: number } | "ambiguous" | null {
  return findInLine(line, quote);
}

/** Tier 3: tiers 1-2 again, on the quote with leading/trailing punctuation
 * trimmed. It exists because the model routinely closes a quoted fragment with
 * the punctuation it believes belongs there (`really difficult.` for a line that
 * ends `really difficult`), and rejecting that is a false negative: the anchor
 * still names exactly one span. Trimming only ever touches the quote's edges,
 * so an internal mismatch (`2:30` vs `2.30`) still fails.
 * This tier is a fallback, never a competitor: callers must first count tiers
 * 1-2 across the whole window/document and consult tier 3 only when they match
 * nothing. Otherwise a tolerant twin could make an exact hit look ambiguous
 * (a subject line `... on the network` competing with the body line
 * `... on the network.`). */
function matchTolerant(line: string, quote: string): { start: number; end: number } | "ambiguous" | null {
  const tailStripped = quote.replace(/[\s.,;:!?'"`(\[…-]+$/, "");
  const droppedTail = tailStripped !== quote;
  const trimmed = tailStripped.replace(/^[\s.,;:!?'"`)\]…-]+/, "");
  if (trimmed === "" || trimmed === quote) return null;
  const t = findInLine(line, trimmed);
  if (t === null || t === "ambiguous") return t;
  if (!droppedTail) return t;
  // The quote ended in punctuation, so the fragment denotes a sentence edge:
  // swallow the document's own closing punctuation so an INSA lands after it
  // ("work for you." on a "work for you?" line) instead of before it.
  let end = t.end;
  while (end < line.length && /[.!?'"”’)\]]/.test(line[end]!)) end++;
  return { start: t.start, end };
}

type LineHit = { idx: number; span: { start: number; end: number } };
type WindowScan = { hits: number; ambiguous: boolean; first: LineHit | null };

/** Scan candidate lines with one matcher, stopping at the first ambiguity. */
function scanWindow(
  window: { idx: number; line: string }[],
  match: (line: string, quote: string) => { start: number; end: number } | "ambiguous" | null,
  quote: string,
): WindowScan {
  const out: WindowScan = { hits: 0, ambiguous: false, first: null };
  for (const c of window) {
    const m = match(c.line, quote);
    if (m === "ambiguous") return { ...out, ambiguous: true };
    if (m) {
      out.hits++;
      out.first ??= { idx: c.idx, span: m };
      if (out.hits > 1) return { ...out, ambiguous: true };
    }
  }
  return out;
}

/** Tiers 1-2 for one quote form: exact, then whitespace/case-normalized. */
function findInLine(line: string, quote: string): { start: number; end: number } | "ambiguous" | null {
  // tier 1: exact substring
  const exact = line.indexOf(quote);
  if (exact !== -1) {
    if (line.indexOf(quote, exact + 1) !== -1) return "ambiguous"; // twice in one line
    return { start: exact, end: exact + quote.length };
  }
  // tier 2: normalized substring (whitespace-collapsed + case-folded, both sides)
  const nLine = foldNorm(line);
  const nQuote = foldNorm(quote);
  if (nQuote === "") return null;
  const nAt = nLine.indexOf(nQuote);
  if (nAt === -1 || nLine.indexOf(nQuote, nAt + 1) !== -1) return nAt === -1 ? null : "ambiguous";
  // map the normalized span back to original coordinates: per folded char,
  // the original index of its first character
  const map: number[] = [];
  let folded = "";
  for (let i = 0; i < line.length; i++) {
    if (/\s/.test(line[i]!)) {
      if (folded !== "" && !folded.endsWith(" ")) {
        folded += " ";
        map.push(i);
      }
    } else {
      folded += line[i]!.toLowerCase();
      map.push(i);
    }
  }
  // trailing folded space came from trailing whitespace in the line
  while (folded.endsWith(" ")) {
    folded = folded.slice(0, -1);
    map.pop();
  }
  if (folded !== nLine) return null; // normalization mismatch (should not happen)
  const start = map[nAt]!;
  const endChar = map[nAt + nQuote.length - 1]!;
  return { start, end: endChar + 1 };
}

/** Tier 3: unique near-match of `quote` among candidate lines. Returns the
 * winning line index or null (below threshold, or not uniquely best). */
function nearMatch(candidates: { idx: number; line: string }[], quote: string): number | null {
  if (candidates.length === 0) return null; // empty document: nothing to splice onto
  const scored = candidates.map((c) => ({ idx: c.idx, sim: wordSim(foldNorm(c.line), foldNorm(quote)) }));
  const best = scored.reduce((a, b) => (b.sim > a.sim ? b : a));
  if (best.sim < 0.8) return null;
  const second = scored.filter((s) => s.idx !== best.idx).reduce((m, s) => Math.max(m, s.sim), -1);
  if (best.sim - second < 0.1) return null;
  return best.idx;
}

/** Which tier makes this quote doc-unique for a destructive op: "exact" when
 * tiers 1-2 find exactly one line document-wide, "tolerant" when they find
 * none and the punctuation-insensitive tier finds one, null when ambiguous.
 * The chosen tier also constrains in-window resolution: an exact hit elsewhere
 * in the document must not license a tolerant delete of a different line. */
function docMatchTier(lines: string[], quote: string): "exact" | "tolerant" | null {
  const all = lines.map((line, idx) => ({ idx, line }));
  const exact = scanWindow(all, matchExact, quote);
  if (exact.ambiguous || exact.hits > 1) return null;
  if (exact.hits === 1) return "exact";
  const tolerant = scanWindow(all, matchTolerant, quote);
  if (tolerant.ambiguous || tolerant.hits > 1) return null;
  return "tolerant";
}

/** Apply one quote-anchored op. Returns the new doc or a rejection message. */
function applySurgery(doc: string, op: Op): ApplyResult {
  const lines = splitLines(doc);
  if (op.kind === "APP") {
    lines.push(op.text);
    return { ok: true, doc: render(lines), before: doc };
  }
  const quote = op.kind === "RM" ? op.text : op.anchor!;
  // DEL is destructive: it may only delete a doc-unique line, and it must
  // resolve at the same tier that made the quote unique (see docMatchTier).
  const delTier = op.kind === "DEL" ? docMatchTier(lines, quote) : undefined;
  if (op.kind === "DEL" && delTier === null) {
    return rejected("no_match", `DEL [L${op.line}]: anchor ${JSON.stringify(quote)} is ambiguous in the document`);
  }
  // step 0: content-first line resolution — search the anchor/fragment in
  // Lnn, then Lnn-1, Lnn+1, Lnn-2, Lnn+2 (in range only)
  const window = [0, -1, 1, -2, 2]
    .map((d) => op.line - 1 + d)
    .filter((i) => i >= 0 && i < lines.length)
    .map((i) => ({ idx: i, line: lines[i]! }));
  // tiers 1-2 per candidate line; ambiguity (twice within one line, or two
  // window lines matching) is an atomic rejection. Punctuation tolerance is
  // only consulted when tiers 1-2 match nothing in the whole window, so an
  // exact hit can never be turned ambiguous by a tolerant twin. A DEL is
  // locked to the tier that made its quote doc-unique.
  let scan = scanWindow(window, delTier === "tolerant" ? matchTolerant : matchExact, quote);
  if (delTier === undefined && scan.hits === 0 && !scan.ambiguous) scan = scanWindow(window, matchTolerant, quote);
  const { ambiguous, hits, first: firstHit } = scan;
  if (!ambiguous && hits === 1) {
    if (op.kind === "DEL") {
      lines.splice(firstHit!.idx, 1);
      return { ok: true, doc: render(lines), before: doc };
    }
    return splice(doc, lines, firstHit!.idx, firstHit!.span, op);
  }
  // tier 3: unique near-match on whole lines, only for insertions. A fuzzy
  // guess must never delete/replace a whole line (DEL/REP/RM), so those stay
  // exact/normalized and reject a missing anchor.
  if (!ambiguous && (op.kind === "INSB" || op.kind === "INSA")) {
    const idx = nearMatch(window, quote);
    if (idx !== null) {
      const line = lines[idx]!;
      return splice(doc, lines, idx, { start: 0, end: line.length }, op);
    }
  }
  // tier 4: reject with the closest real line as "did you mean" context
  const closest = window.length
    ? window.reduce((a, b) => (wordSim(foldNorm(b.line), foldNorm(quote)) > wordSim(foldNorm(a.line), foldNorm(quote)) ? b : a)).line
    : "";
  return rejected(
    "no_match",
    `${op.kind} [L${op.line}]: quote ${JSON.stringify(quote)} not found${ambiguous ? " (ambiguous)" : ""}; closest line: ${JSON.stringify(closest)}`,
  );
}

/** Collapse doubled whitespace at the seams (tier-2 spans may swallow or abut
 * whitespace runs); edge spaces are trimmed as before. */
function tidySeam(s: string): string {
  return s.replace(/(\S)\s{2,}(\S)/g, "$1 $2").replace(/^ | $/g, "");
}

/** RM may orphan a comma/semicolon/colon when the fragment was the last item
 * (`- Jeans, two pairs` -> `- Jeans,`). Remove punctuation left dangling at
 * the edited line's edge. */
function tidyRmSeam(s: string, atStart: boolean, atEnd: boolean): string {
  let out = s
    .replace(/(\S)\s{2,}(\S)/g, "$1 $2")
    .replace(/^(\s*(?:[-*+]|\d+\.))\s*[,;:]\s+/, "$1 ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,;:])\s*([,;:])/g, "$1")
    .replace(/,(\s*[.!?])/g, "$1")
    .replace(/([.!?])\1+/g, "$1")
    .replace(/^ | $/g, "");
  if (atStart) out = out.replace(/^\s+/, "");
  if (atEnd) out = out.replace(/\s+$/, "").replace(/,$/, "");
  return out;
}

/** Splice the payload around/into the matched span of `lines[idx]`. The
 * matched span text is kept byte-identical; only the seam spacing is fixed. */
function splice(doc: string, lines: string[], idx: number, span: { start: number; end: number }, op: Op): ApplyResult {
  const line = lines[idx]!;
  const matched = line.slice(span.start, span.end);
  let merged: string;
  if (op.kind === "INSB") {
    merged = `${line.slice(0, span.start)}${op.text} ${matched}${line.slice(span.end)}`;
  } else if (op.kind === "INSA") {
    merged = `${line.slice(0, span.start)}${matched} ${op.text}${line.slice(span.end)}`;
  } else if (op.kind === "REP") {
    merged = `${line.slice(0, span.start)}${op.text}${line.slice(span.end)}`;
  } else {
    // RM: drop the fragment, then repair the seam (incl. orphan punctuation)
    merged = `${line.slice(0, span.start)} ${line.slice(span.end)}`;
    merged = tidyRmSeam(merged, span.start === 0, line.slice(span.end).trim() === "");
    if (merged.trim() === line.trim()) {
      return rejected("no_match", `RM [L${op.line}]: fragment removal left the line unchanged`);
    }
    lines[idx] = merged;
    return { ok: true, doc: render(lines), before: doc };
  }
  lines[idx] = tidySeam(merged);
  return { ok: true, doc: render(lines), before: doc };
}

/** Apply an already-parsed single op to a doc. */
export function applyParsed(doc: string, ops: Op[]): ApplyResult {
  if (ops.length !== 1) return rejected("parse_error", "a script must contain exactly one op");
  const op = ops[0]!;
  if (op.kind === "UNDO") {
    // UNDO needs the session's previous state; the pure applier cannot do it.
    return rejected("parse_error", "UNDO must be handled by the session");
  }
  if (op.kind === "ADD") {
    const lines = splitLines(doc);
    if (op.line < 1 || op.line > lines.length) {
      return rejected("no_match", `ADD target [L${op.line}] is out of range; use APP for end of document`);
    }
    lines.splice(op.line - 1, 0, op.text);
    return { ok: true, doc: render(lines), before: doc };
  }
  return applySurgery(doc, op);
}

function rejected(reason: RejectReason, message: string): ApplyResult {
  return { ok: false, reason, message };
}

/** Parse and apply one op script. */
export function applyOps(doc: string, raw: string): ApplyResult {
  let ops: Op[];
  try {
    ops = parseOps(raw);
  } catch (e) {
    return rejected("parse_error", (e as Error).message);
  }
  return applyParsed(doc, ops);
}
