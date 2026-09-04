import { describe, expect, it } from "vitest";
import { PRINTABLE_LIMIT, printable } from "../../src/runtime/printable.js";

/**
 * The sanitizer every operator-facing message in the runtime goes through.
 *
 * It lives in its own module because three units quote values they did not write — a lock file's
 * host, a run name off the command line, `ps`'s stderr — and a copy of the ranges in each is how the
 * ranges drift apart. Each of the classes below reached a terminal at some point in this unit's
 * review, one class at a time, which is the argument for a test that enumerates them rather than a
 * comment claiming they are covered.
 */
describe("making a value from outside awcli safe to print", () => {
  it.each([
    { what: "an escape sequence", value: "evil[2Jhost", gone: "" },
    { what: "a C1 control", value: "evilhost", gone: "" },
    { what: "a carriage return", value: "host\rNOT-THE-HOST", gone: "\r" },
    // Not control characters by the C0/C1 definition, and the ones that change what the *rest* of
    // the message says rather than merely how one value looks.
    { what: "a right-to-left override", value: "evil‮moc.elpmaxe", gone: "‮" },
    { what: "an arabic letter mark", value: "evil؜host", gone: "؜" },
    { what: "a right-to-left isolate", value: "evil⁧host", gone: "⁧" },
    // Render as nothing, so two different values look like one. A byte-order mark is the one that
    // arrives by accident, at the front of anything that has been through a Windows editor.
    { what: "a zero-width space", value: "exampl​e.com", gone: "​" },
    { what: "a byte-order mark", value: "exampl﻿e.com", gone: "﻿" },
    { what: "a word joiner", value: "exampl⁠e.com", gone: "⁠" },
    { what: "an invisible times", value: "exampl⁢e.com", gone: "⁢" },
    // Render as blank or as nothing without being a control, a bidi mark or a zero-width space, so
    // the previous pattern let every one of them through — measured, one class at a time, which is
    // what the module docblock asks of an addition to a blocklist. Written as escapes rather than
    // literals because a literal of any of them is invisible in this file too.
    { what: "a soft hyphen", value: "exampl\u00ade.com", gone: "\u00ad" },
    { what: "a combining grapheme joiner", value: "exampl\u034fe.com", gone: "\u034f" },
    { what: "a Hangul choseong filler", value: "exampl\u115fe.com", gone: "\u115f" },
    { what: "a Hangul filler", value: "exampl\u3164e.com", gone: "\u3164" },
    { what: "a halfwidth Hangul filler", value: "exampl\uffa0e.com", gone: "\uffa0" },
    { what: "a Khmer inherent vowel", value: "exampl\u17b4e.com", gone: "\u17b4" },
    { what: "a variation selector", value: "exampl\ufe00e.com", gone: "\ufe00" },
    // The tags block: 128 code points that render as nothing at all, of which U+E0020-U+E007F are a
    // shadow ASCII alphabet — so a whole sentence rides inside a value that displays as `example`.
    // Non-BMP, which is why the pattern carries the `u` flag: without it the range cannot be written
    // as a range at all.
    { what: "a language tag", value: "exampl\u{e0001}e.com", gone: "\u{e0001}" },
    { what: "a tag letter", value: "exampl\u{e0041}e.com", gone: "\u{e0041}" },
    { what: "a cancel tag", value: "exampl\u{e007f}e.com", gone: "\u{e007f}" },
  ])("takes $what out", ({ value, gone }) => {
    const shown = printable(value);
    expect(shown).not.toContain(gone);
    expect(shown).toContain("?");
  });

  /**
   * The blocklist's cost, stated as a test so it stays true: these values are legitimately
   * international — a hostname, a workflow path, a name somebody chose — and mangling them would
   * make a refusal harder to act on than the escape sequence it was protecting against.
   */
  it.each([
    "build-server-04.internal",
    "sähköposti.example",
    "服务器-01",
    "run_2024.06-a",
  ])("leaves %s exactly as it is", (value) => {
    expect(printable(value)).toBe(value);
  });

  /**
   * The widening's own cost, held to the same standard as the widening. Each of these carries a
   * character adjacent to one of the new ranges and is a name somebody could legitimately have: an
   * ordinary hyphen next to the soft hyphen, real Hangul syllables next to the fillers, a Khmer word
   * next to the inherent vowels, an emoji whose variation selector was *not* what made it an emoji,
   * and three whose variation selector *is* it — U+FE0F, which the range stops one code point short
   * of on purpose. A range written one code point too wide mangles these, and mangling a value is how
   * a refusal becomes harder to act on than the escape sequence it was protecting against. The three
   * VS16 cases are the ones the previous version of this list stepped around: every value in it
   * carried a character *adjacent* to a new range and none carried a legitimate member of one, so the
   * widening that mangled `feature/<heart>-love` was watched by a case built from a check mark, which
   * needs no selector at all.
   */
  it.each([
    "build-server-04",
    "\ud55c\uad6d\uc5b4-01",
    "\u1780\u17d2\u1798\u17c1\u179a",
    "server-\u2713",
    "feature/\u2764\ufe0f-love",
    "warn-\u26a0\ufe0f",
    "\u2b50\ufe0f-star",
  ])("leaves %s alone, though it sits next to a range that goes", (value) => {
    expect(printable(value)).toBe(value);
  });

  it("caps the length, because a message that scrolls itself away has failed", () => {
    const long = "h".repeat(PRINTABLE_LIMIT * 3);
    expect(printable(long)).toHaveLength(PRINTABLE_LIMIT + 3);
    expect(printable(long).endsWith("...")).toBe(true);
  });

  /**
   * A caller with a legitimately longer value passes its own limit — a filename inside a path the
   * operator has to act on is the case that exists. The default is what a hostname needs.
   */
  it("lets a caller raise the cap without raising it for everyone", () => {
    const name = "n".repeat(100);
    expect(printable(name, 128)).toBe(name);
    expect(printable(name)).toHaveLength(PRINTABLE_LIMIT + 3);
  });

  it("does not lengthen a value it leaves alone", () => {
    expect(printable("")).toBe("");
    expect(printable("h".repeat(PRINTABLE_LIMIT))).toHaveLength(PRINTABLE_LIMIT);
  });
});
