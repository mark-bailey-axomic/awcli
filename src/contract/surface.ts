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
 * It exists so that removing or renaming a member fails a test while adding one passes
 * (BR-033). That only works while this stays a copy nobody edits: the moment it is updated
 * to match a rename, it has stopped being evidence of anything. Editing it is declaring a
 * major version.
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
