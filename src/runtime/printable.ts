/**
 * Strings that came off disk, or out of another program, made safe to put in a message.
 *
 * awcli's messages quote things awcli did not write: a lock file's `host` and `run` arrive from a
 * file in the repository, a leftover's filename from a directory listing, a run name from the
 * command line, a probe's reason from `ps`'s stderr. Printed straight to a terminal, an escape
 * sequence in any of them repaints the screen, and the operator can be shown a refusal that says
 * something awcli never said. A refusal is the whole of some of these units' interface, so that is
 * not a cosmetic problem: the message is the product.
 *
 * Two classes go, and the second is the one that keeps being missed. Control characters — C0 and C1
 * — are what a terminal acts on. The bidirectional controls are not control characters by that
 * definition, and are worse in one respect: they reverse the *rendering* of everything after them,
 * so a host of "evil\u202Emoc.elpmaxe" displays as though it read example.com, and a refusal
 * quoting it sends the operator to look at the wrong machine. The zero-width and invisible-format
 * characters go with them, for the narrower version of the same reason: they make two different
 * strings render identically.
 *
 * A blocklist, and the limit of that is worth writing down rather than assuming away. An allowlist
 * would be a guarantee, where this is a list of what has been thought of; the reason there is not
 * one is that every value passing through here is legitimately international — a hostname, a
 * workflow path, a name somebody chose — so an allowlist narrow enough to be worth having would
 * mangle ordinary input. Each range below was added because the ranges already there turned out not
 * to cover the next thing tried. Expect that again: add the range, and a case to the test.
 *
 * One module rather than one copy per unit. Three of them quote foreign values, and ranges kept in
 * three places are ranges that end up differing by one class.
 */

/**
 * How much of a value a message will show.
 *
 * A hostname is not 4kB long, and a message that scrolls the real explanation off the screen has
 * failed at the only job it has. A caller quoting something with a legitimately longer form — a
 * filename inside a path the operator has to act on — passes its own limit.
 */
export const PRINTABLE_LIMIT = 64;

/**
 * C0 and C1 controls; the bidi marks, embeddings, overrides and isolates; the zero-width and
 * invisible-format characters, including the byte-order mark, which arrives at the front of
 * anything that has been through a Windows editor and renders as nothing at all.
 *
 * Then the classes that render as blank or as nothing without belonging to any of those groups, added
 * because the docblock above invites exactly this and each one was measured passing through the
 * previous pattern unchanged: the soft hyphen (U+00AD) and the combining grapheme joiner (U+034F);
 * the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), which are ordinary letters as far as a
 * terminal's width calculation goes and blank as far as a reader is concerned; the Khmer inherent
 * vowels (U+17B4, U+17B5), which are the same trick in another script; and the variation selectors
 * U+FE00-U+FE0E, which attach to the character before them and can be repeated without limit.
 *
 * That last range stops one code point short of the block, and U+FE0F's exclusion is the cost side of
 * this blocklist rather than the benefit side. VS16 is the emoji presentation selector: it is what
 * makes a heart, a warning sign or a star render as the emoji the operator typed, so a branch called
 * `feature/<heart>-love` or a slot called `warn-<sign>` is an ordinary name and not a hidden payload.
 * Stripping it put a `?` into a name with nothing wrong with it, and then did worse: `workspace.ts`
 * decides whether to append `unshowablePathNote` by asking this function whether it changed anything,
 * so a mangled emoji made a refusal tell the operator that the path they were reading "addresses
 * something other than the working copy". That was untrue and self-inflicted. A variation selector
 * also cannot do what the rest of this class does — it modifies a base character that renders, so it
 * can neither hide content nor repaint a terminal on its own, and the unbounded-repetition case it
 * was added for is what `PRINTABLE_LIMIT` already answers.
 *
 * And the Unicode tags block (U+E0000-U+E007F), which is the one worth naming on its own. Its 128
 * code points render as nothing at all in every terminal, and U+E0020-U+E007F are a full shadow ASCII
 * alphabet — so an arbitrary sentence can be carried inside a value that looks like `main`. It was
 * out of reach of the previous pattern twice over: by range, and by shape, because it is non-BMP and
 * the pattern had no `u` flag, so it would have had to be spelled as a surrogate range. The `u` flag
 * is what makes `\u{e0000}` mean the code point rather than two units, and it is the reason this is
 * one class rather than an alternation.
 *
 * Every one of these is legal in a filename, and all but the first two ranges are legal in a git
 * refname as well — `git check-ref-format` accepts a branch containing U+200B and U+202E, and one
 * carrying a C1 control, measured on git 2.55 — so both channels this module exists for can carry
 * them.
 *
 * "Rejects only the C0 controls" is what this said, and it was wrong in the direction that matters
 * here: git's ref rules ban the C0 controls *and DEL*, and DEL is a member of this very pattern —
 * the sentence justifying the pattern excluded one of the things the pattern is for. It bans plenty
 * besides, none of which is a character that renders as nothing: space, `~`, `^`, `:`, `?`, `*`,
 * `[`, `\`, `..` and a `.lock` suffix, all measured the same way. `run-identity.ts` enumerates the
 * ones awcli's own names have to meet, and `workspace.ts` states the same distinction where it
 * decides not to sanitise a branch before putting it in a contract field.
 */
const UNPRINTABLE =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\u3164\ufe00-\ufe0e\ufeff\uffa0\u{e0000}-\u{e007f}]/gu;

export function printable(value: string, limit: number = PRINTABLE_LIMIT): string {
  const stripped = value.replace(UNPRINTABLE, "?");
  return stripped.length > limit ? `${stripped.slice(0, limit)}...` : stripped;
}
