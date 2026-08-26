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
 * **What it catches, and what it does not.** Ten classes of drift are distinguishable, and every
 * verdict below was established by diverging one side of the contract in one place and watching
 * `tsc --noEmit`, not by reading the types:
 *
 * 1. A member typed `any`. Caught, by IsAny inside Exact. Without that guard, `any` satisfies
 *    both directions against anything and the member is reported as conforming.
 * 2. Method-syntax bivariance. A parameter *narrowed* under method syntax is caught, because the
 *    declaration writes every function as an arrow property and the bivariance exemption does not
 *    reach the comparison. Method syntax with the parameter types unchanged is not caught, and
 *    should not be: it is the same member type, spelled differently. Indexed access normalises a
 *    method into its arrow property, so the identity comparison added for classes 8 and 9 leaves
 *    that verdict where it was.
 * 3. Optionality. Caught, by Exact — `T` and `T | undefined` each fail one direction.
 * 4. A `readonly` modifier. Caught, by SameReadonly, at the top level and one level down: a
 *    `readonly` dropped from `git.dir` is now reached by DriftedWithin, which asks SameReadonly
 *    the same question of the sub-API's own members. Exact cannot see a modifier at all, because
 *    TypeScript ignores `readonly` when it relates two types.
 * 5. A restated signature widened or narrowed — `string` for a literal union, `unknown` for a
 *    parameter, a different return type. Caught, by Exact.
 * 6. The runtime naming the contract's own interface — `git: GitApi` — instead of restating the
 *    shape. Not caught here, and not closeable here: the two sides are then genuinely one type,
 *    and no type-level comparison can tell that from a faithful restatement.
 *    scripts/verify-contract-gate.sh greps for it, which is the only reason that guard exists.
 * 7. A member of a *sub-API* typed `any` — `branch: any` inside the restated GitApi. Caught, by
 *    DriftedWithin. It was not before, and the reason is worth stating: Exact compares whole
 *    members, a sub-API is one member, and a shape holding an `any` is assignable in both
 *    directions to the declared shape because the `any` inside it is — IsAny at the top level
 *    never looked in.
 * 8. A dropped trailing optional parameter — a runtime `exec` that takes the command and ignores
 *    ExecOptions. Caught, by IdenticalTo. Assignability cannot see it in either direction,
 *    because a callee may always ignore an argument its caller passes.
 * 9. An unexercised type-parameter default — `<T>` where the declaration wrote `<T = string>`.
 *    Caught, by IdenticalTo. This one is not cosmetic: without the default, `ctx.agent({ prompt })`
 *    hands back `AgentResult<unknown>`, so `.output` stops being a string. Assignability cannot
 *    see it either, because relating two generic signatures unifies their type parameters and
 *    never asks what either would instantiate to on its own — and neither can Parameters<> or
 *    ReturnType<>, which report `unknown` for both spellings.
 * 10. A required field flipped optional. Caught where the runtime restates the shape — at the top
 *    level and within a sub-API, by Exact, which fails one direction on the added `undefined`.
 *    Not caught inside an interface both sides merely name: that is the orthogonal limit below.
 *
 * One limit is orthogonal to all ten: this file never reaches inside the interfaces the members
 * mention. Both sides name AgentOptions and Project, so comparing those members compares a type
 * with itself, and deleting or narrowing a field within one is invisible. That is also why the
 * limit is not a hole in the runtime's direction — there is nowhere in a shared interface for the
 * runtime to put an `any`, because it does not restate one. What the limit leaves unguarded is the
 * declaration changing under the workflows already written against it, and the
 * construction-position fixtures under test/fixtures/v1-corpus are the gate for that. For class 10
 * they needed help: an object literal supplying every field still compiles when one of them turns
 * optional, so an exhaustive sweep of the declaration found eight fields nothing objected to. The
 * required-key witnesses at the foot of test/fixtures/v1-corpus/construction.ts are what closes it
 * there, and scripts/verify-contract-gate.sh watches one of the eight fail.
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
 * Not identity, and the gap is not academic. TypeScript ignores `readonly` when it relates two
 * types, so this alone cannot tell a readonly member from a writable one; and a function stays
 * assignable in both directions when it loses a trailing optional parameter or a type-parameter
 * default. SameReadonly and IdenticalTo below cover those; the header of this file records what
 * the set of them does and does not reach.
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

/** Whether both sides agree on K's `readonly`. */
type SameReadonly<Declared, Runtime, K extends keyof Declared & keyof Runtime> =
  IsWritable<Declared, K> extends IsWritable<Runtime, K> ? true : false;

/**
 * Identity rather than mutual assignability, for one member type.
 *
 * The same invariant position IsWritable uses, for the same reason: it is one of the few places
 * TypeScript compares two types rather than relating them. Exact<> is blind to everything
 * assignability is blind to, and two of those things are drift a workflow author would feel. A
 * function that loses a trailing optional parameter stays assignable in both directions, because
 * a callee may always ignore an argument. A generic signature that loses a type-parameter default
 * stays assignable in both directions, because relating two generic signatures unifies their
 * type parameters and never asks what either would instantiate to on its own.
 *
 * Confined to function types by SignatureDrift below, because the warning on IsWritable stands:
 * this comparison separates object types that are mutually assignable but spelled differently,
 * and the runtime restates every shape by hand. Function types are the exception worth having,
 * and they are safe in the one way that matters — indexed access hands over a method as its
 * arrow property, so method syntax with the parameter types unchanged is identical here, which
 * is the verdict class 2 requires.
 */
type IdenticalTo<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;

/**
 * Whether a function-typed member's signature drifted somewhere Exact<> cannot look.
 *
 * Both sides have to be functions for the question to mean anything. A runtime handing back data
 * where the declaration promised a function is drift, but it is Exact's to report — saying it
 * twice would put the same member in two error messages and leave the second looking like a
 * second problem.
 */
type SignatureDrift<Declared, Runtime> = Declared extends (...args: never[]) => unknown
  ? Runtime extends (...args: never[]) => unknown
    ? IdenticalTo<Declared, Runtime> extends true
      ? false
      : true
    : false
  : false;

/**
 * The members of one sub-API whose runtime type is not the declared one, named `owner.member`.
 *
 * Exact<> compares whole members, and a sub-API is one member: `git` is compared as a shape, and
 * a shape holding an `any` is assignable in both directions to the declared shape because the
 * `any` inside it is. So this walks one level and asks each of the three questions the top-level
 * comparison asks — `any`, the `readonly` modifier, the signature — of the members within.
 *
 * One level, and not all of them. Every type these signatures mention is the contract's own and
 * is therefore shared, so a walk that kept going would compare a type with itself until it
 * reached Scope, whose ctx is a WorkflowContext again — an instantiation-depth error rather than
 * a check. The corpus fixtures are the gate for interiors; this is the gate for the shapes the
 * runtime restates by hand.
 *
 * The name is a template literal rather than K, so the compiler's error text says which method
 * of which sub-API to go and look at. A member whose type has no keys — every top-level function,
 * whose `keyof` is `never` — contributes nothing here and is left to DriftedIn.
 */
type DriftedWithin<Declared, Runtime, K extends keyof Declared & keyof Runtime> = {
  [P in keyof Declared[K] & keyof Runtime[K]]: IsAny<Runtime[K][P]> extends true
    ? `${K & string}.${P & string}`
    : SignatureDrift<Declared[K][P], Runtime[K][P]> extends true
      ? `${K & string}.${P & string}`
      : SameReadonly<Declared[K], Runtime[K], P> extends true
        ? never
        : `${K & string}.${P & string}`;
}[keyof Declared[K] & keyof Runtime[K]];

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
      ? SignatureDrift<
          WorkflowContext<State>[K],
          RuntimeContextFor<State>[K]
        > extends true
        ? K
        : never
      : K
    : K;
}[keyof WorkflowContext<State> & keyof RuntimeContextFor<State>];

/** The same question, one level down: `owner.member` for each sub-API member that drifted. */
type DriftedWithinAnyOf<State> = {
  [K in keyof WorkflowContext<State> & keyof RuntimeContextFor<State>]: DriftedWithin<
    WorkflowContext<State>,
    RuntimeContextFor<State>,
    K
  >;
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
export type SubApisMatchContract = NoneOf<DriftedWithinAnyOf<Record<string, unknown>>>;
export type SubApisMatchContractForADeclaredState = NoneOf<
  DriftedWithinAnyOf<DeclaredStateProbe>
>;
export type RuntimeDeliversEveryDeclaredMember = NoneOf<
  MissingFrom<Record<string, unknown>>
>;
export type RuntimePromisesNothingExtra = NoneOf<Undeclared>;
export type SurfaceListIsComplete = NoneOf<Unenumerated>;
