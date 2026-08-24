# AWCLI-00 — [AWCLI] Project scaffolding and a globally installable walking skeleton

**Points:** 2 · **Source:** new — extracted from AWCLI-01's hidden scope · **Status:** Done

## Problem / Goal

Every other ticket assumes a toolchain that does not exist yet: there is no package manifest, no
test runner, no type checking and no build. AWCLI-01's acceptance criteria — "compiles standalone
in a directory with no installed packages", "a deliberate divergence fails the build" — cannot be
written, let alone verified, until something can compile and run tests. Rather than let the first
real ticket carry project setup as unnamed scope, set it up once and prove the premise while doing
so: a global install that runs from any directory.

## Context

The whole design rests on being globally installed rather than added to each project (PRD P0-1),
so the walking skeleton must be verified *as a global install invoked from an unrelated
directory* — not as a script run from the source tree. That distinction is the premise of the tool
and the easiest thing to accidentally not test.

The reference implementation's toolchain is a known-good starting point for exactly this shape of
project — a bundled, globally installed Node CLI — minus its effect-system dependency, which
ADR-0001 rejects.

## Requirements

### Functional

- Establish a Node package with a single command entry point, installable globally.
- Provide a build that bundles the tool and its loader into a distributable form, so a global
  install carries everything it needs.
- Provide a test runner, a formatter, and strict type checking, each runnable as a named script.
- Provide a walking skeleton: the command runs from a global install in an unrelated directory,
  reports its version, and exits zero.
- Provide continuous integration running the same gates on macOS and Linux.

### Non-Functional

- Strict type checking from the first commit — not enabled later, when it is expensive.
- The full gate suite runs fast enough to be run on every change without thinking about it.
- Dependencies stay minimal: this is a tool that must install cleanly on a colleague's machine.
- No dependency on the operator's project toolchain — the tool is self-contained by design.

## Constraints

- Plain TypeScript with driver ports; no effect system (ADR-0001).
- Modern module format throughout, matching the dynamic import the loader will need (AWCLI-05).
- CI covers macOS and Linux only — native Windows is refused at startup and gets no matrix entry
  (ADR-0007).
- No application logic beyond the version command; capability belongs to the tickets that own it.

## Acceptance Criteria

- [x] `npm install -g` from a clean clone produces a working command on `PATH`.
- [x] The command, invoked from a directory unrelated to the source tree, reports its version and
      exits zero.
- [x] Test, format-check and typecheck each run as a named script and pass on a clean tree.
- [x] A deliberate type error fails the typecheck script with a non-zero exit.
- [x] CI runs the gates on macOS and Linux, and has no Windows job.
- [x] All tests pass, lint clean, type check clean.

## Out of Scope

- Any context, driver, loader or loop behaviour — those are AWCLI-01 onward.
- Publishing to a registry; local global install is the bar for v1.
- The generated repository layout written into a *target* project — AWCLI-22.

## Dependencies

**Blocked by:** None — this is now the first ticket.
**Blocks:** Every other ticket; explicitly AWCLI-01, AWCLI-03, AWCLI-18 (the day-one three).
