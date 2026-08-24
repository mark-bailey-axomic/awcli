import type { ContextMember } from "./surface.js";
import type { RuntimeContext } from "../runtime/context.js";

/**
 * The drift gate.
 *
 * ADR-0002 inverts the usual direction: awcli.d.ts is the specification, and the runtime is
 * checked against it. This file is that check. It has no run-time content and nothing
 * imports it — it earns its place by being compiled, which is why `npm run build` runs the
 * type checker over src before tsup rather than leaving it to a command someone can skip.
 * scripts/verify-contract-gate.sh proves it actually bites.
 */

/**
 * Identity, not assignability.
 *
 * One direction alone would accept a runtime that returns more than it promised, or accepts
 * less. Both directions accept only the same type. Two details matter and neither is
 * decoration: the tuple wrappers stop a union being distributed and compared member by
 * member, and the failure branches are `false` rather than `never` — `never extends true`
 * is true, so a `never` here would report every drifting member as no drift at all.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * The names of the members whose runtime type is not the declared one. A member the runtime
 * never defined counts too, that being the sharpest kind of drift.
 *
 * Collapsing to names rather than to a boolean is what puts the member into the compiler's
 * error text, so the build failure says which one to go and look at.
 */
type Drifted = {
  [K in keyof WorkflowContext]: K extends keyof RuntimeContext
    ? Exact<WorkflowContext[K], RuntimeContext[K]> extends true
      ? never
      : K
    : K;
}[keyof WorkflowContext];

/** Members the runtime hands out that the contract never promised. */
type Undeclared = Exclude<keyof RuntimeContext, keyof WorkflowContext>;

/** Members the declaration has that CONTEXT_SURFACE forgot, so supports() would deny them. */
type Unenumerated = Exclude<keyof WorkflowContext, ContextMember>;

/** Fails to compile unless its argument is `never`, quoting whatever was not. */
type NoneOf<Members extends never> = Members;

export type RuntimeMatchesContract = NoneOf<Drifted>;
export type RuntimePromisesNothingExtra = NoneOf<Undeclared>;
export type SurfaceListIsComplete = NoneOf<Unenumerated>;
