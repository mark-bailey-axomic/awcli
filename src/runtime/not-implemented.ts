/**
 * Thrown when a workflow reaches a member awcli declares but has not built yet.
 *
 * The contract is frozen before the machinery behind it (BR-033), so a v1 declaration
 * promises twelve members while most of them are still ahead. An operator meeting one needs
 * to know two things immediately: that this is a gap in the tool rather than a mistake in
 * their workflow, and which release closes it. Returning undefined instead would tell them
 * neither, and would surface as a confusing failure somewhere else entirely.
 *
 * A workflow should never see this. ctx.version.supports() answers false for every member
 * that would raise it, so a workflow that feature-detects takes the other branch; this is
 * what one that does not gets.
 *
 * Named rather than anonymous so the loader can recognise it and report it as a limitation
 * of the tool rather than as a workflow crash.
 */
export class NotYetImplementedError extends Error {
  constructor(
    /** The member reached, as a workflow author writes it — e.g. `git.branch`. */
    readonly member: string,
    /** The ticket that delivers it. */
    readonly ticket: string,
  ) {
    super(
      `ctx.${member} is part of the awcli context contract but is not implemented in this version. It arrives with ${ticket}; until then, ctx.version.supports("${member.split(".")[0]}") answers false and a workflow must take the other branch.`,
    );
    this.name = "NotYetImplementedError";
  }
}
