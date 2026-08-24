/**
 * Exit codes, defined once so every later command inherits the same meanings.
 *
 * The first four are the machine-readable form of how a run ends (BR-018): a scheduler
 * reads the code and decides whether to alert, without parsing logs. `REFUSED` is the
 * important one for anything that never got as far as running — a gate rejected it and
 * nothing was touched.
 *
 * Usage errors are refusals. Nothing ran, nothing changed, and reporting them as
 * `FAILED` would tell a scheduler a run was attempted and broke, which is a different
 * and more alarming thing than a mistyped command.
 */
export const EXIT = {
  /** The workflow declared itself done, or exhausted a limit it declared as completion. */
  FINISHED: 0,
  /** Every iteration failed, or the tool broke. */
  FAILED: 1,
  /** A limit was exhausted and the workflow did not declare that as completion. */
  INCOMPLETE: 2,
  /** A gate rejected this before any side effect — including a usage error. */
  REFUSED: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
