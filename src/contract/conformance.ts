import type { ContextMember } from "./surface.js";
import type { RuntimeContext, RuntimeContextFor } from "../runtime/context.js";

/**
 * The drift gate.
 *
 * ADR-0002 inverts the usual direction: awcli.d.ts is the specification, and the runtime is
 * checked against it. This file is that check. It has no run-time content and nothing imports
 * it — it earns its place by being compiled, which is why `npm run build` runs the type checker
 * over the source before tsup rather than leaving it to a command someone can skip.
 * scripts/verify-contract-gate.sh proves it bites.
 *
 * What it does not reach: the interiors of the interfaces the members mention. Both sides name
 * AgentOptions and Project, so comparing them is comparing a type with itself, and deleting a
 * field from one is invisible here. The construction-position fixtures under
 * test/fixtures/v1-corpus are the gate for that.
 */

/** True only for `any`, which is assignable in both directions to everything. */
type IsAny<T> = 0 extends 1 & T ? true : false;

/**
 * Identity, not assignability.
 *
 * One direction alone would accept a runtime that returns more than it promised, or accepts
 * less. Both directions accept only the same type. Three details matter and none is decoration:
 * the tuple wrappers stop a union being distributed and compared member by member; the failure
 * branches are `false` rather than `never`, because `never extends true` is true and a `never`
 * here would report every drifting member as no drift at all; and `any` is excluded first,
 * because it satisfies both directions against anything, so a member annotated `any` in the
 * runtime has no link to the declaration and would otherwise be reported as conforming.
 */
type Exact<A, B> =
  IsAny<A> extends IsAny<B>
    ? [A] extends [B]
      ? [B] extends [A]
        ? true
        : false
      : false
    : false;

/**
 * The names of the members whose runtime type is not the declared one, for one instantiation
 * of the state shape. A member the runtime never defined counts too, that being the sharpest
 * kind of drift.
 *
 * Collapsing to names rather than to a boolean is what puts the member into the compiler's
 * error text, so the build failure says which one to go and look at.
 */
type DriftedIn<State> = {
  [K in keyof WorkflowContext<State>]: K extends keyof RuntimeContextFor<State>
    ? Exact<WorkflowContext<State>[K], RuntimeContextFor<State>[K]> extends true
      ? never
      : K
    : K;
}[keyof WorkflowContext<State>];

/**
 * A state shape as an author writes one: an interface, not the default record.
 *
 * Checking only the default instantiation would green-light a runtime that cannot type as the
 * context a real workflow is handed — every corpus fixture and every real workflow declares
 * `Workflow<Something>` — and the mismatch would surface in the loader as a cast, which is
 * exactly where this check stops applying.
 */
interface DeclaredStateProbe {
  items: string[];
  nested: { count: number };
}

/** Members the runtime hands out that the contract never promised. */
type Undeclared = Exclude<keyof RuntimeContext, keyof WorkflowContext>;

/** Members the declaration has that CONTEXT_SURFACE forgot, so supports() would deny them. */
type Unenumerated = Exclude<keyof WorkflowContext, ContextMember>;

/** Fails to compile unless its argument is `never`, quoting whatever was not. */
type NoneOf<Members extends never> = Members;

export type RuntimeMatchesContract = NoneOf<DriftedIn<Record<string, unknown>>>;
export type RuntimeMatchesContractForADeclaredState = NoneOf<
  DriftedIn<DeclaredStateProbe>
>;
export type RuntimePromisesNothingExtra = NoneOf<Undeclared>;
export type SurfaceListIsComplete = NoneOf<Unenumerated>;
