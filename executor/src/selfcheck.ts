// Selfcheck for the single-op executor. Run: cd ../demo && npm run check
// - parse/apply tests for ADD, APP, DEL, RM, REP, INSB, INSA, UNDO
// - rejection cases (missing/ambiguous anchors, out of range, multi-op, CON)
// - session undo/zero-diff and normalize behavior
// - replays current-grammar cases in data-generation/udiff-l/cases
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  applyOps,
  applyParsed,
  normalize,
  OpParseError,
  parseOp,
  parseOps,
  splitLines,
  trimDoc,
  type ApplyResult,
} from "./executor.js";
import { EditSession } from "./session.js";
import { ChatEditSession } from "./client.js";
import { buildUserMessage, numbered } from "./prompt.js";

const MONDAY = "Nursery prep is brutal.\n# Monday\n- buy 3 crib rails\n- call Sarah at 9 PM\n";

function ok(doc: string, ops: string, expected: string) {
  const r = applyOps(doc, ops);
  assert.deepEqual(r, { ok: true, doc: expected, before: doc }, `apply failed: ${JSON.stringify(r)}`);
}

function rejectedWith(doc: string, ops: string, reason: string) {
  const r: ApplyResult = applyOps(doc, ops);
  assert.equal(r.ok, false, `expected ${reason}, got ${JSON.stringify(r)}`);
  assert.equal((r as { reason?: string }).reason, reason);
}

// --- parser ------------------------------------------------------------------
assert.deepEqual(parseOp("ADD [L03] - buy 2 crib sheets"), {
  kind: "ADD", line: 3, text: "- buy 2 crib sheets",
});
assert.deepEqual(parseOp("DEL [L03] - buy 3 crib rails"), {
  kind: "DEL", line: 3, text: "", anchor: "- buy 3 crib rails",
});
assert.deepEqual(parseOp("RM [L04] Sarah at"), { kind: "RM", line: 4, text: "Sarah at" });
assert.deepEqual(parseOp("REP [L02] Monday || Tuesday"), {
  kind: "REP", line: 2, text: "Tuesday", anchor: "Monday",
});
assert.deepEqual(parseOp("INSA [L03] buy 3 crib rails || Water the ferns."), {
  kind: "INSA", line: 3, anchor: "buy 3 crib rails", text: "Water the ferns.",
});
assert.deepEqual(parseOp("INSB [L03] crib rails || Water the ferns."), {
  kind: "INSB", line: 3, anchor: "crib rails", text: "Water the ferns.",
});
assert.deepEqual(parseOp("APP 1. Water the ferns."), { kind: "APP", line: 0, text: "1. Water the ferns." });
assert.deepEqual(parseOps("UNDO"), [{ kind: "UNDO", line: 0, text: "" }]);

assert.throws(() => parseOp("CON [L01] Nursery prep is brutal."), /CON is not part of the grammar/);
assert.throws(() => parseOp("DEL [L01]"), /DEL requires an anchor/);
assert.throws(() => parseOp("RM [L01]"), /RM requires a fragment/);
assert.throws(() => parseOp("REP [L01] Monday"), /old \|\| new/);
assert.throws(() => parseOp("REP [L01]  || Tuesday"), /old text must not be empty/);
assert.throws(() => parseOp("REP [L01] Monday || "), /new text must not be empty/);
assert.throws(() => parseOp("INSA [L03] no separator"), /anchor \|\| payload/);
assert.throws(() => parseOp("INSA [L03]  || payload"), /anchor must not be empty/);
assert.throws(() => parseOp("ADD [L01]"), /ADD requires text/);
assert.throws(() => parseOp("APP"), /APP requires payload/);
assert.throws(() => parseOp("CON [LX] y"), /CON is not part of the grammar/);
assert.throws(() => parseOp("DEL [L00] x"), /line number must be >= 1/);
assert.throws(() => parseOp("[L01] x"), /unknown op kind/);
assert.throws(() => parseOps("ADD [L02] x\nDEL [L03] y"), /exactly one op/);
assert.throws(() => parseOps("UNDO\nDEL [L03] x"), /exactly one op/);
assert.throws(() => parseOp("NOOP"), /malformed op line/);
assert.throws(() => parseOps(""), /empty response/);
assert.throws(() => parseOps("GARBAGE"), OpParseError);

// --- ADD (mid-document only) -------------------------------------------------
ok(MONDAY, "ADD [L03] - buy 2 crib sheets",
  "Nursery prep is brutal.\n# Monday\n- buy 2 crib sheets\n- buy 3 crib rails\n- call Sarah at 9 PM\n");
ok(MONDAY, "ADD [L01] Intro line",
  "Intro line\nNursery prep is brutal.\n# Monday\n- buy 3 crib rails\n- call Sarah at 9 PM\n");
rejectedWith(MONDAY, "ADD [L05] tail", "no_match"); // EOF must use APP
rejectedWith(MONDAY, "ADD [L06] tail", "no_match");
rejectedWith("", "ADD [L01] x", "no_match"); // blank file must use APP

// --- APP ---------------------------------------------------------------------
ok("", "APP # Title", "# Title\n");
ok(MONDAY, "APP - call Erik at 8 AM", `${MONDAY}- call Erik at 8 AM\n`);

// --- DEL (anchored whole line, doc-unique) -----------------------------------
ok(MONDAY, "DEL [L03] buy 3 crib rails", "Nursery prep is brutal.\n# Monday\n- call Sarah at 9 PM\n");
ok(MONDAY, "DEL [L03] call Sarah", "Nursery prep is brutal.\n# Monday\n- buy 3 crib rails\n"); // content-first: L04
ok(MONDAY, "DEL [L02] # Monday", "Nursery prep is brutal.\n- buy 3 crib rails\n- call Sarah at 9 PM\n");
ok("a  \nb\nc\n", "DEL [L02] b", "a  \nc\n"); // untouched bytes preserved
rejectedWith("alpha\nbeta\ngamma\ndelta\nalpha\n", "DEL [L01] alpha", "no_match"); // duplicate outside window
rejectedWith("echo echo foo\n", "DEL [L01] echo", "no_match"); // twice in one line
rejectedWith(MONDAY, "DEL [L03] nonexistent", "no_match");
rejectedWith("Schedule the plumber for Tuesday morning\n", "DEL [L01] Schedule the plumber for Thursday morning", "no_match"); // no fuzzy delete

// --- REP (quote-anchored replacement) ---------------------------------------
ok(MONDAY, "REP [L02] Monday || Tuesday",
  "Nursery prep is brutal.\n# Tuesday\n- buy 3 crib rails\n- call Sarah at 9 PM\n");
ok("In June we go.\n", "REP [L01] June || September", "In September we go.\n");
ok(MONDAY, "REP [L01] Nursery prep is brutal. || Nursery is calm.",
  "Nursery is calm.\n# Monday\n- buy 3 crib rails\n- call Sarah at 9 PM\n");
ok("Buy  THREE  crib rails today\n", "REP [L01] buy three crib rails || Buy two crib rails",
  "Buy two crib rails today\n"); // tier 2 normalized match
rejectedWith("foo foo\n", "REP [L01] foo || bar", "no_match");
rejectedWith(MONDAY, "REP [L01] completely unrelated words || x", "no_match");
rejectedWith("Schedule the plumber for Tuesday morning\n", "REP [L01] Schedule the plumber for Thursday morning || x", "no_match"); // no fuzzy replace

// --- RM (fragment removal, seam + orphan punctuation cleanup) ---------------
ok(MONDAY, "RM [L04] Sarah at", "Nursery prep is brutal.\n# Monday\n- buy 3 crib rails\n- call 9 PM\n");
ok("call Sarah at 9 PM\n", "RM [L01] Sarah at", "call 9 PM\n");
ok("- Jeans, two pairs\n", "RM [L01] two pairs", "- Jeans\n");
ok("- order the lamp from IKEA, $25, for the desk\n", "RM [L01] $25",
  "- order the lamp from IKEA, for the desk\n");
ok("- measure under-desk gap for cable tray, need 2 inches clearance\n", "RM [L01] for cable tray",
  "- measure under-desk gap, need 2 inches clearance\n");
rejectedWith("alpha beta\nalpha beta\nother\n", "RM [L01] alpha", "no_match");
rejectedWith("echo echo foo\n", "RM [L01] echo", "no_match");
rejectedWith(MONDAY, "RM [L01] completely unrelated words here now", "no_match");
rejectedWith("Schedule the plumber for Tuesday morning\n", "RM [L01] Schedule the plumber for Thursday morning", "no_match"); // no fuzzy whole-line removal

// --- INSB / INSA -------------------------------------------------------------
ok(MONDAY, "INSA [L03] buy 3 crib rails || Water the ferns.",
  "Nursery prep is brutal.\n# Monday\n- buy 3 crib rails Water the ferns.\n- call Sarah at 9 PM\n");
ok(MONDAY, "INSB [L03] crib rails || First",
  "Nursery prep is brutal.\n# Monday\n- buy 3 First crib rails\n- call Sarah at 9 PM\n");
ok(MONDAY, "INSA [L02] call Sarah || ASAP",
  "Nursery prep is brutal.\n# Monday\n- buy 3 crib rails\n- call Sarah ASAP at 9 PM\n"); // ±2 window
ok("Buy  THREE  crib rails today\n", "INSA [L01] buy three crib rails || now",
  "Buy THREE crib rails now today\n"); // tier 2
// tier 3: the model closes a fragment with punctuation the document does not
// have. Rejecting this is a false negative (the anchor still names one span).
ok("- The beginning was really difficult\n",
  "INSA [L01] really difficult. || The discontinuity was harsh.",
  "- The beginning was really difficult The discontinuity was harsh.\n");
// tier 3 with a different terminal punctuation: the payload must land AFTER
// the document's own mark, not before it ("you Too much to do.?").
ok("Q: How is work for you?\n",
  "INSA [L01] work for you. || Too much to do.",
  "Q: How is work for you? Too much to do.\n");
ok("Use baking soda to vinegar'.\n", "INSA [L01] to vinegar. || Then wait.",
  "Use baking soda to vinegar'. Then wait.\n"); // closing quote+period swallowed
ok("The ferns are dry\n", "REP [L01] ferns are dry. || ferns look dead",
  "The ferns look dead\n"); // REP: reference punctuation is optional
ok("The ferns are dry\n", "DEL [L01] ferns are dry.", ""); // DEL with punctuation the line lacks still targets the same line
// ...but an exact hit elsewhere in the document pins the DEL to that tier: it
// must not delete a merely tolerant twin inside the window instead.
rejectedWith(
  "The ferns are dry.\n\nA\nB\nC\nWater the ferns are dry\n",
  "DEL [L06] ferns are dry.",
  "no_match",
);
// tier 3 must not paper over a real mismatch inside the fragment
rejectedWith("The ferns are dry\n", "INSA [L01] ferns are wet. || x", "no_match");
rejectedWith("echo echo foo\n", "INSA [L01] echo. || x", "no_match"); // still ambiguous
rejectedWith(MONDAY, "INSA [L03] completely unrelated || x", "no_match");

// --- meta ops in the pure applier -------------------------------------------
rejectedWith(MONDAY, "UNDO", "parse_error");
rejectedWith(MONDAY, "NOOP", "parse_error"); // NOOP was removed from the grammar
rejectedWith(MONDAY, "ADD [L03] x\nDEL [L04] y", "parse_error");
const multi = applyParsed(MONDAY, [
  { kind: "ADD", line: 3, text: "x" },
  { kind: "DEL", line: 4, text: "", anchor: "y" },
]);
assert.equal(multi.ok, false);
assert.equal((multi as { reason?: string }).reason, "parse_error");

// --- edge trim + session undo ------------------------------------------------
assert.equal(trimDoc("\n\n  \n# Grocery\n\nBuy milk\n\n  \n\n"), "# Grocery\n\nBuy milk\n");
assert.equal(trimDoc("a\n"), "a\n");
assert.equal(trimDoc("  x\ny  \n"), "x\ny\n"); // edge whitespace of boundary lines
assert.equal(trimDoc("\n\n"), "");
assert.equal(trimDoc(""), "");

const s = new EditSession("\n\n  \n# Grocery\n\nBuy milk\n\n  \n"); // load trims
assert.equal(s.doc, "# Grocery\n\nBuy milk\n");
assert.ok(s.apply("DEL [L03] Buy milk").ok);
assert.equal(s.doc, "# Grocery\n");
const undone = s.apply("UNDO");
assert.ok(undone.ok && undone.reverted); // restores the pre-edit doc
assert.equal(s.doc, "# Grocery\n\nBuy milk\n");
const spent = s.apply("UNDO");
assert.ok(spent.ok && spent.nothingToUndo); // single-level: history is spent
assert.equal(s.doc, "# Grocery\n\nBuy milk\n");
const empty = new EditSession("x\n");
const emptyUndo = empty.apply("UNDO");
assert.ok(emptyUndo.ok && emptyUndo.nothingToUndo); // nothing to undo at all

// --- zero-diff guard: session reports "unchanged", pure applier still applies -
ok(MONDAY, "REP [L03] buy 3 crib rails || buy 3 crib rails", MONDAY);
const zero = new EditSession(MONDAY);
assert.ok(zero.apply("DEL [L03] buy 3 crib rails").ok);
const zr = zero.apply("REP [L01] Nursery prep is brutal. || Nursery prep is brutal."); // no-op
assert.equal(zr.ok, false);
assert.equal((zr as { reason?: string }).reason, "unchanged");
assert.equal(zero.doc, "Nursery prep is brutal.\n\n# Monday\n- call Sarah at 9 PM\n"); // normalize added the blank before the heading
const zUndo = zero.apply("UNDO");
assert.ok(zUndo.ok && zUndo.reverted);
assert.equal(zero.doc, MONDAY); // no-change turn did not consume undo history

// --- normalize (playbook formatting cleanup) -----------------------------------
assert.equal(normalize(""), "");
assert.equal(normalize("\n\n  \n\n"), ""); // blank-only doc
assert.equal(normalize("a  \nb\t\n \nc\n"), "a\n\nb\n\nc\n"); // trailing whitespace per line (double-space breaks too)
assert.equal(normalize("\n\n  x\ny  \n\n\n"), "x\n\ny\n"); // edge blanks + edge whitespace of boundary lines
assert.equal(normalize("a\n\n\n\nb\n"), "a\n\nb\n"); // consecutive blanks collapse to one
assert.equal(normalize("# A\n\nbody\n"), "# A\nbody\n"); // no empty line after a heading
assert.equal(normalize("intro\n# A\nbody\n"), "intro\n\n# A\nbody\n"); // exactly one empty before a heading
assert.equal(normalize("\n\n# A\nbody\n"), "# A\nbody\n"); // none at doc start
assert.equal(normalize("# A\n\n## B\n"), "# A\n## B\n"); // heading after heading: no empty after a heading
assert.equal(normalize("p1\np2\n"), "p1\n\np2\n"); // empty line after a paragraph when content follows
assert.equal(normalize("- a\n- b\nnext\n"), "- a\n- b\n\nnext\n"); // empty line after a list when content follows
assert.equal(normalize("para\n- a\n- b\n"), "para\n\n- a\n- b\n"); // ...and before a list (paragraph rule)
assert.equal(normalize("1. a\n2. b\nx\n"), "1. a\n2. b\n\nx\n"); // ordered lists count as lists
assert.equal(normalize("- a\n## B\n"), "- a\n\n## B\n"); // list then heading
assert.equal(normalize("> quote\nnext\n"), "> quote\n\nnext\n"); // blockquotes are paragraph blocks
assert.equal(normalize("# A\n\n```\nx  \n\n\ny\n```\n\nnext\n"), "# A\n```\nx  \n\n\ny\n```\n\nnext\n"); // code interior verbatim

// --- session: normalize after every successful edit ----------------------------
const lst = new EditSession("para one\n");
assert.ok(lst.apply("APP - item").ok); // list appended to a paragraph
assert.equal(lst.doc, "para one\n\n- item\n"); // exactly one empty line between them
const h = new EditSession("# T\n\nbody\n");
assert.ok(h.apply("APP tail").ok); // untouched blank after the heading
assert.equal(h.doc, "# T\nbody\n\ntail\n"); // ...is removed by the cleanup
const blanks = new EditSession("a\n\n\n\nb\n");
assert.ok(blanks.apply("APP c").ok);
assert.equal(blanks.doc, "a\n\nb\n\nc\n"); // 3 consecutive blanks collapse to 1
const spaces = new EditSession("a\n");
assert.ok(spaces.apply("APP b  ").ok); // model emitted a double-space line break
assert.equal(spaces.doc, "a\n\nb\n"); // executor strips it (and separates the paragraphs)
const chain = new EditSession("a\n\n\n\nb\n");
assert.ok(chain.apply("APP c").ok);
assert.ok(chain.apply("APP d").ok);
assert.equal(chain.doc, "a\n\nb\n\nc\n\nd\n");
const chainUndo = chain.apply("UNDO");
assert.ok(chainUndo.ok && chainUndo.reverted);
assert.equal(chain.doc, "a\n\nb\n\nc\n"); // pre-edit (already normalized) doc restored

// --- session: rejected scripts leave the doc untouched and unnormalized --------
const rej = new EditSession("p1\np2\n"); // violates spacing; load does not normalize
assert.equal(rej.doc, "p1\np2\n");
const rejNoMatch = rej.apply("DEL [L01] wrong echo");
assert.equal(rejNoMatch.ok, false);
assert.equal((rejNoMatch as { reason?: string }).reason, "no_match");
assert.equal(rej.doc, "p1\np2\n"); // untouched, not normalized
const rejParse = rej.apply("GARBAGE");
assert.equal(rejParse.ok, false);
assert.equal((rejParse as { reason?: string }).reason, "parse_error");
assert.equal(rej.doc, "p1\np2\n");

// --- prompt helpers ----------------------------------------------------------
assert.equal(numbered("a\nb\n"), "[L01] a\n[L02] b");
assert.equal(numbered(""), "");
assert.equal(buildUserMessage("a\n", "fix typos"), "fix typos\n\n---\n\n[L01] a");

// --- one-line paragraph: continuation is INSA on the same line ----------------
const continuation = "INSA [L01] We need to find a good way to communicate. || The team will meet again next Tuesday.";
const one = new EditSession("We need to find a good way to communicate.\n");
assert.ok(one.apply(continuation).ok);
assert.equal(one.doc, "We need to find a good way to communicate. The team will meet again next Tuesday.\n");
const seen: string[] = [];
const stub = { complete: async (msgs: { content: string }[]) => { seen.push(msgs[1]!.content); return continuation; } };
const chat = new ChatEditSession(stub, "We need to find a good way to communicate.\n");
const turn = await chat.send("The team will meet again next Tuesday.");
assert.ok(turn.ok);
assert.equal(chat.doc, "We need to find a good way to communicate. The team will meet again next Tuesday.\n");
assert.ok(seen[0]!.endsWith("[L01] We need to find a good way to communicate."));

// --- one-line H1 title: add below the heading uses APP -----------------------
const h1 = new EditSession("# To do list\n");
assert.ok(h1.apply("APP Weather was pretty nasty today.").ok);
assert.equal(h1.doc, "# To do list\nWeather was pretty nasty today.\n");

// --- real-case replay --------------------------------------------------------
// cases live in category subdirs: cases/<category>/<stem>.before.md
// Every case is regenerated in the single-op grammar; replay all of them.
const casesDir = new URL("../../data-generation/udiff-l/cases/", import.meta.url);
const hasCases =
  existsSync(casesDir) && readdirSync(casesDir, { withFileTypes: true }).some((e) => e.isDirectory());
let replayed = 0;
if (hasCases) {
  for (const sub of readdirSync(casesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const dir = new URL(`${sub}/`, casesDir);
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".before.md")) continue;
      const stem = name.slice(0, -".before.md".length);
      const afterUrl = new URL(`${stem}.after.md`, dir);
      const udiffUrl = new URL(`${stem}.udiff.txt`, dir);
      if (!existsSync(afterUrl) || !existsSync(udiffUrl)) continue; // incomplete case
      const before = readFileSync(new URL(name, dir), "utf8");
      const after = readFileSync(afterUrl, "utf8");
      const udiff = readFileSync(udiffUrl, "utf8");
      const lines = udiff.split("\n").filter((line) => line.trim() !== "");
      assert.equal(lines.length, 1, `case ${stem}: expected one op line`);
      const r = applyOps(before, udiff);
      // playbook round-trip: the executor normalizes after every edit, so the
      // stored after is the normalized form (the ops need not produce it raw)
      assert.ok(r.ok && normalize(r.doc) === after, `case ${stem}: ${JSON.stringify(r).slice(0, 400)}`);
      // and the same ops via the full parse path (session behavior)
      assert.ok(applyParsed(before, parseOps(udiff)).ok);
      replayed++;
    }
  }
}

console.log(
  `selfcheck ok (${replayed > 0 ? `${replayed} cases replayed` : "cases/ empty, nothing to replay"})`,
);
