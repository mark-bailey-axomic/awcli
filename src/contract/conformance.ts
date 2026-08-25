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
 * **What it catches, and what it does not.** Six classes of drift are distinguishable, and every
 * verdict below was established by diverging the runtime one place and watching `tsc --noEmit`,
 * not by reading the types:
 *
 * 1. A member typed `any`. Caught, by IsAny inside Exact. Without that guard, `any` satisfies
 *    both directions against anything and the member is reported as conforming.
 * 2. Method-syntax bivariance. A parameter *narrowed* under method syntax is caught, because the
 *    declaration writes every function as an arrow property and the bivariance exemption does not
 *    reach the comparison. Method syntax with the parameter types unchanged is not caught, and
 *    should not be: it is the same member type, spelled differently.
 * 3. Optionality. Caught, by Exact — `T` and `T | undefined` each fail one direction.
 * 4. A `readonly` modifier. Caught on a top-level member, by SameReadonly, and only there. Exact
 *    cannot see a modifier at all, because TypeScript ignores `readonly` when it relates two
 *    types; a `readonly` dropped inside a sub-API, on `git.dir`, is not reached. A recursive probe
 *    would have to walk function and union types to close a hole nothing has yet hit.
 * 5. A restated signature widened or narrowed — `string` for a literal union, `unknown` for a
 *    parameter, a different return type. Caught, by Exact.
 * 6. The runtime naming the contract's own interface — `git: GitApi` — instead of restating the
 *    shape. Not caught here, and not closeable here: the two sides are then genuinely one type,
 *    and no type-level comparison can tell that from a faithful restatement.
 *    scripts/verify-contract-gate.sh greps for it, which is the only reason that guard exists.
 *
 * One limit is orthogonal to all six: this file never reaches inside the interfaces the members
 * mention. Both sides name AgentOptions and Project, so comparing those members compares a type
 * with itself, and deleting or narrowing a field within one is invisible. The
 * construction-position fixtures under test/fixtures/v1-corpus are the gate for that.
 */

/** True only for `any`, which is assignable in both directions to everything. */
type IsAny<T> = 0 extends 1 & T ? true : false;

/**
 * Assignability in both directions, which is as close to identity as that relation reaches.
 *
 * One direction alone would accept a runtime that returns more than it promised, or accepts
 * less. Three details matter and none is decoration: the tuple wrappers stop a union being
 * distributed and compared member by member; the failure branches are `false` rather than
 * `never`, because `never extends true` is true and a `never` here would report every drifting
 * member as no drift at all; and `any` is excluded first, because it satisfies both directions
 * against anything, so a member annotated `any` in the runtime has no link to the declaration
 * and would otherwise be reported as conforming.
 *
 * Not identity, and the gap is not academic: TypeScript ignores `readonly` when it relates two
 * types, so this alone cannot tell a readonly member from a writable one. SameReadonly below
 * covers that; the header of this file records what the pair does and does not reach.
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
 * True when K is writable on T.
 *
 * Exact<> cannot see a modifier at all: TypeScript ignores `readonly` when it relates two types,
 * so a runtime handing out a writable member satisfies a declaration that promised a readonly
 * one, in both directions. This asks a different question of one type — does stripping
 * `readonly` from K change the shape? — and the answer is no exactly when K was not readonly to
 * begin with. `{ [P in K]: T[K] }` over a K constrained to `keyof T` is the homomorphic form, the
 * one `Pick` uses, so it carries T's modifier across; `-readonly` removes it.
 *
 * The two shapes are compared in the return type of a generic signature, one of the few
 * positions TypeScript compares invariantly rather than by assignability. That comparison is far
 * too strict for real member types — it separates types that are mutually assignable but spelled
 * differently, and the runtime restates every shape by hand — which is why it is confined to
 * this one question about one type.
 */
type IsWritable<T, K extends keyof T> =
  (<X>() => X extends { [P in K]: T[K] } ? 1 : 2) extends <X>() => X extends {
    -readonly [P in K]: T[K];
  }
    ? 1
    : 2
    ? true
    : false;

/** Whether both sides agree on K's `readonly`. Top-level members only — see the header. */
type SameReadonly<Declared, Runtime, K extends keyof Declared & keyof Runtime> =
  IsWritable<Declared, K> extends IsWritable<Runtime, K> ? true : false;

/**
 * The names of the members whose runtime type is not the declared one, for one instantiation
 * of the state shape. A member the runtime never defined is reported by MissingFrom instead.
 *
 * Collapsing to names rather than to a boolean is what puts the member into the compiler's
 * error text, so the build failure says which one to go and look at.
 */
type DriftedIn<State> = {
  [K in keyof WorkflowContext<State> & keyof RuntimeContextFor<State>]: Exact<
    WorkflowContext<State>[K],
    RuntimeContextFor<State>[K]
  > extends true
    ? SameReadonly<WorkflowContext<State>, RuntimeContextFor<State>, K> extends true
      ? never
      : K
    : K;
}[keyof WorkflowContext<State> & keyof RuntimeContextFor<State>];

/** Members the declaration promises that the runtime does not hand out at all. */
type MissingFrom<State> = Exclude<
  keyof WorkflowContext<State>,
  keyof RuntimeContextFor<State>
>;

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
export type RuntimeDeliversEveryDeclaredMember = NoneOf<
  MissingFrom<Record<string, unknown>>
>;
export type RuntimePromisesNothingExtra = NoneOf<Undeclared>;
export type SurfaceListIsComplete = NoneOf<Unenumerated>;
