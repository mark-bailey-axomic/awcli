/**
 * The enumerated context surface.
 *
 * A list of names has to exist somewhere: ctx.version.supports() answers from it, and a
 * type cannot be iterated at run time. The `satisfies` clause is what keeps it from
 * drifting out of step with the declaration — a name that is not a member of
 * WorkflowContext fails to compile here, and conformance.ts catches the other direction, a
 * member nobody added to this list.
 */

/**
 * The surface as awcli implements it today.
 *
 * Ordered as the declaration and the TDD's Contracts table order it, so the three read the
 * same way. Append here when adding a member; never remove.
 */
export const CONTEXT_SURFACE = [
  "agent",
  "sandbox",
  "state",
  "args",
  "project",
  "git",
  "exec",
  "fs",
  "log",
  "env",
  "schema",
  "version",
] as const satisfies readonly (keyof WorkflowContext)[];

export type ContextMember = (typeof CONTEXT_SURFACE)[number];

/**
 * The surface as it was frozen for v1 — a fixed record, not a live list.
 *
 * What actually stops a member being removed or renamed is elsewhere: every one of the twelve
 * is exercised by the frozen corpus, so removing one stops those fixtures compiling, and
 * conformance.ts catches a member dropped from CONTEXT_SURFACE but left in the declaration.
 * This copy adds the count that the version rule needs — the contract's minor must have moved
 * once per member added since v1 — and a record of what v1 was that does not shift when
 * CONTEXT_SURFACE does.
 *
 * That only works while nobody edits it to match a rename. Updating this list is not a way to
 * make a test pass; it is a statement that the major version changed.
 */
export const V1_SURFACE_BASELINE = [
  "agent",
  "sandbox",
  "state",
  "args",
  "project",
  "git",
  "exec",
  "fs",
  "log",
  "env",
  "schema",
  "version",
] as const;
