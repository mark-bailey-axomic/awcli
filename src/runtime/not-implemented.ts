/**
 * Thrown when a workflow reaches a member awcli declares but has not built yet.
 *
 * The contract is frozen before the machinery behind it (BR-033), so a v1 declaration promises
 * twelve members while most of them are still ahead. An operator meeting one needs to know
 * that this is a gap in the tool rather than a mistake in their workflow, and what to do about
 * it. Returning undefined instead would tell them neither, and would surface as a confusing
 * failure somewhere else entirely.
 *
 * The message names the member, the version that lacks it, and the check that would have
 * avoided it. It deliberately does not name a ticket: tracker ids drift as tickets are split
 * and renumbered, and an operator outside the team cannot read one anyway. The id is kept on
 * the error for maintainers rather than printed at them.
 *
 * A workflow should never see this. ctx.version.supports() answers false for every member that
 * would raise it, so a workflow that feature-detects takes the other branch; this is what one
 * that does not gets.
 *
 * Named rather than anonymous so the loader can recognise it and report it as a limitation of
 * the tool rather than as a workflow crash.
 */
export class NotYetImplementedError extends Error {
  constructor(
    /** The member reached, as a workflow author writes it — e.g. `git.branch`. */
    readonly member: string,
    /** Internal: the unit that delivers it, for maintainers. Never shown to an operator. */
    readonly ticket: string,
    /** The awcli build that lacks it, so an operator knows what to compare against. */
    readonly awcliVersion: string,
  ) {
    super(
      `ctx.${member} is part of the awcli context contract but is not implemented in awcli ${awcliVersion}. ctx.version.supports("${member.split(".")[0]}") answers false for it; a workflow must take the other branch.`,
    );
    this.name = "NotYetImplementedError";
  }
}
