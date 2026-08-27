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
 */
const UNPRINTABLE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

export function printable(value: string, limit: number = PRINTABLE_LIMIT): string {
  const stripped = value.replace(UNPRINTABLE, "?");
  return stripped.length > limit ? `${stripped.slice(0, limit)}...` : stripped;
}
