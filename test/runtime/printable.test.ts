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
