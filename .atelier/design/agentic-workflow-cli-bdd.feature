# feature: agentic-workflow-cli
# artifact: bdd-scenarios
# status: Approved
# source: agentic-workflow-cli-rules.md
# Each scenario is tagged with the business rule it verifies.

Feature: Running agentic workflows from a global command-line tool

  As an operator
  I want to run a TypeScript workflow against any repository on my machines
  So that agents do work unattended, safely, and I can tell afterwards what happened

  Background:
    Given I have awcli installed globally
    And I have a workflow named "triage" in my global workflow library

  # ─── Environment preconditions — refusals before any side effect ───

  @BR-001
  Scenario: Native Windows is refused with a route forward
    Given I am on a native Windows session rather than a Linux environment
    When I run the "triage" workflow
    Then the run is refused before anything is created
    And I am told to run awcli inside a Linux environment on Windows, keeping my clones there

  @BR-002
  Scenario: A directory that is not a repository is refused
    Given a target directory that is not under version control
    When I run the "triage" workflow against it
    Then the run is refused
    And I am told the target must be a repository, and how to make it one

  @BR-003
  Scenario: An awcli older than the repository requires is refused
    Given a repository requiring awcli version ">=0.6 <2"
    And my installed awcli is version "0.4.1"
    When I run the "triage" workflow
    Then the run is refused, naming both the required range and my version

  @BR-003
  Scenario: An awcli within the required range proceeds
    Given a repository requiring awcli version ">=0.6 <2"
    And my installed awcli is version "1.9.0"
    When I run the "triage" workflow
    Then the run proceeds

  @BR-003
  Scenario: A repository that requires nothing accepts any version
    Given a repository that declares no required awcli version
    When I run the "triage" workflow
    Then the run proceeds

  @BR-004
  Scenario: A requested container is never silently downgraded
    Given a workflow that asks for its agent to run in a container
    And container support is unavailable on this machine
    When I run that workflow
    Then the run fails, telling me container support is unavailable
    And the agent is not started with weaker isolation instead

  @BR-004
  Scenario: A workflow that asks for no container is unaffected by its absence
    Given a workflow whose agents run without a container
    And container support is unavailable on this machine
    When I run that workflow
    Then it runs normally

  # ─── Validation — caught at the earliest point that names the cause ───

  @BR-005
  Scenario: A workflow file with no usable entry point is refused
    Given a workflow file that exports no default entry point
    When I run it
    Then the run is refused before any run data is created
    And I am told the file must export a default function

  @BR-006
  Scenario: A portable workflow meeting a repository that lacks a fact it needs
    Given a workflow that uses the repository's declared test command
    And a repository whose profile declares no test command
    When I run that workflow against it
    Then the run is refused at startup naming the missing profile field
    And no agent is started

  @BR-006
  Scenario: The free-form part of a profile carries no guarantee
    Given a workflow that reads a value from the free-form part of the repository's profile
    And the repository declares no such value
    When I run that workflow
    Then the run is not refused
    And the workflow observes the value as absent, to handle as it sees fit

  @BR-007
  Scenario: Asking for tagged output the prompt never requests
    Given a workflow that asks the agent for a tagged result
    And the workflow's prompt never asks the agent to produce that tag
    When I run it
    Then the run is refused at startup
    And I am told the prompt must ask for the tag

  @BR-008
  Scenario: A value that cannot be stored is rejected where it was set
    Given a running workflow
    When it puts a value into shared state that cannot be stored as plain data
    Then the assignment fails immediately, naming the key

  @BR-009
  Scenario: Stored state no longer matching the shape the workflow declares
    Given a workflow that declares the shape of its shared state
    And stored state from an earlier version of that workflow that no longer matches
    When I run the workflow
    Then the run is refused at startup, reporting what failed to match
    And I am offered the option to reset the stored state

  # ─── Concurrency and permission ───

  @BR-010
  Scenario: Two runs of the same name cannot overlap
    Given the "triage" run is already in progress
    When a scheduled job starts the "triage" run again
    Then the second run is refused, naming the run already in progress
    And the first run continues undisturbed

  @BR-011
  Scenario: Differently named runs may overlap
    Given the "triage" run is already in progress against a repository
    When I start a "release-notes" run against the same repository
    Then both runs proceed

  @BR-035
  Scenario: A lock left by a killed run is reclaimed automatically
    Given the "triage" run was killed by a reboot while holding its lock
    When I run "triage" again
    Then the stale lock is reclaimed
    And the output says it was reclaimed and why

  @BR-035
  Scenario: A slow run keeps its lock
    Given the "triage" run has been working for three hours and is still alive
    When another "triage" run is started
    Then the second run is refused
    And the lock is not reclaimed

  @BR-012
  Scenario: A parallel branch may read shared state but not write it
    Given a workflow that starts four agents in parallel
    When one of those branches tries to record its result into shared state
    Then that write fails immediately
    And the failure names the supported pattern — return the result and record it in the workflow body

  @BR-012
  Scenario: The workflow body records results returned from its branches
    Given a workflow that starts four agents in parallel
    When each branch returns its result to the workflow body
    And the body records all four into shared state
    Then all four results are stored

  @BR-013
  Scenario: Parallel agents never share a working copy
    Given a workflow that starts three agents in parallel
    When they run
    Then each agent has its own working copy on its own branch
    And no agent observes another's changes

  # ─── Isolation and safety ───

  @BR-014
  Scenario: The default protects my checkout
    Given a repository with uncommitted changes on my current branch
    And a workflow that requests no particular isolation
    When I run it
    Then the agent works in a fresh working copy on its own branch
    And my uncommitted changes and current branch are untouched

  @BR-014
  Scenario: Working on the live checkout requires asking for it
    Given a workflow with no say in which working copy it is given
    When I run it and ask for my live checkout myself
    Then the agent works in my checkout directly
    And that choice is stated in the run's output

  @BR-036
  Scenario: Resuming a run reattaches the branch it already had
    Given the "triage" run created a branch during an earlier iteration
    When I resume that run
    Then it reattaches the same branch
    And no second branch is created for the same slot

  @BR-036
  Scenario: Branches survive the run that made them
    Given a run that completed successfully and left three branches
    When the run ends
    Then all three branches remain for me to review

  @BR-036
  Scenario: Collecting tidies only what is safe to remove
    Given a month of nightly runs has left many branches
    And some carry unmerged commits while others are merged or empty
    When I collect them
    Then the merged and empty branches whose working copies are gone are removed
    And every branch carrying unmerged commits is left alone

  @BR-015
  Scenario: Every agent call states how isolated it is
    Given a workflow with one agent running without a container
    When I run it
    Then the output states that isolation is a working copy only
    And that the wider filesystem and the network remain reachable

  @BR-038
  Scenario: A workflow's paths are read against the working copy it was given
    Given a workflow that reads a file named relative to the repository
    When I run it from a completely different directory
    Then the file it reads is the one in the working copy this iteration was given
    And nothing is read relative to the directory I started awcli from

  @BR-038
  Scenario: A path that climbs out of the working copy is refused
    Given a workflow whose path climbs out of the working copy by mistake
    When I run it
    Then the read is refused, naming the path and saying it left the working copy
    And no file outside the working copy is read or written

  @BR-038
  Scenario: A path given from the root of the machine is refused
    Given a workflow that names a file by its full path from the root of the machine
    When I run it
    Then the read is refused
    And it is refused even when that path happens to point inside the working copy

  @BR-038
  Scenario: A link pointing out of the working copy is refused
    Given a working copy containing a link whose target lies outside it
    When a workflow writes through that link
    Then the write is refused, naming the path
    And a read through the same link is refused on the same terms

  @BR-038
  Scenario: Reaching outside the working copy on purpose is not refused
    Given a workflow that runs a command reading a file elsewhere on the machine
    When I run it
    Then the command runs and reads that file
    And the run is not refused
    And the output still states that isolation is a working copy only

  @BR-016
  Scenario: Credentials are lent to a container, never baked into it
    Given a workflow whose agent runs in a container
    When the container is prepared and the agent runs
    Then my agent credentials are available to it for the life of the run
    And no credential is written into the container image

  @BR-039
  Scenario: The environment a workflow is given holds none of awcli's own credentials
    Given awcli is supplying its own agent credentials to the agent for this run
    When a workflow reads the environment it was given
    Then no credential awcli supplies appears in it, under any name
    And each of them is indistinguishable from a variable that was never set

  @BR-039
  Scenario: My own environment is still there, secrets and all
    Given I have secrets of my own in the environment I started awcli from
    When a workflow reads the environment it was given
    Then my own variables are readable by name, values included
    And only the credentials awcli itself supplies were removed

  @BR-039
  Scenario: A command the workflow runs still sees the whole environment
    Given a workflow that runs a command reporting its own environment
    When I run it
    Then that command sees the environment its execution target actually has
    And the credentials left out of the record were not removed from the machine

  # ─── Execution and termination ───

  @BR-017
  Scenario: The tool drives the loop and carries state across passes
    Given a workflow that records a counter in shared state
    When I run it for three iterations
    Then the workflow is invoked three times
    And each invocation observes the counter left by the previous one

  @BR-018
  Scenario: Finishing the work early is reported as finished
    Given a workflow requested to run for ten iterations
    When it declares itself done during the fourth
    Then the run ends after four iterations
    And the run is reported as finished

  @BR-018
  Scenario: Exhausting the iterations is incomplete unless the workflow says otherwise
    Given a workflow that makes no declaration about its limits
    And it is requested to run for ten iterations
    When all ten are consumed without it declaring itself done
    Then the run is reported as incomplete, having run out of room

  @BR-018
  Scenario: A monitor-style workflow declares that exhausting its limits is expected
    Given a workflow that declares limit-exhaustion to be expected completion
    And it is requested to run for a fixed time
    When that time is consumed without it declaring itself done
    Then the run is reported as finished

  @BR-018
  Scenario: The time limit ends a run the iteration count would not have
    Given a workflow requested to run for twenty iterations within one hour
    When the hour elapses during the sixth iteration
    Then the run ends
    And the reason given is the time limit, not the iteration count

  @BR-037
  Scenario: Declaring done lets work already in flight finish
    Given a workflow that started four agents in parallel
    When it declares itself done after the first reports back
    Then the other three are allowed to finish and commit
    And their results are discarded
    And the run is then reported as finished

  @BR-037
  Scenario: Interrupting is still the immediate stop
    Given a workflow that has declared itself done with three agents still finishing
    When I interrupt the run
    Then those agents are stopped at once
    And whatever they had committed remains in their branches

  @BR-019
  Scenario: One bad iteration does not end the night
    Given a workflow requested to run for five iterations
    When the second iteration fails
    Then the remaining iterations still run
    And the run reports one failed iteration among five

  @BR-019
  Scenario: A run where nothing succeeded is a failed run
    Given a workflow requested to run for three iterations
    When all three fail
    Then the run itself is reported as failed

  @BR-019
  Scenario: A precondition failure stops the loop immediately
    Given a workflow requested to run for five iterations
    When the required version range is not satisfied
    Then no iteration runs
    And the run is refused rather than retried

  @BR-020
  Scenario: A malformed result is re-asked for, not re-done
    Given an agent that has completed its work and committed it
    When it produces a tagged result that fails validation
    Then it is asked once more only to produce a corrected result, changing nothing
    And when it does, the iteration succeeds

  @BR-020
  Scenario: A result that stays malformed costs the iteration, not the work
    Given an agent that has completed its work and committed it
    When its tagged result fails validation twice
    Then the iteration fails, reporting what failed to validate
    And the agent's committed work remains in its working copy
    And the loop continues to the next iteration

  @BR-021
  Scenario: Interrupting a run leaves nothing locked and loses nothing
    Given a run in progress with an agent working in a container
    When I interrupt it
    Then the agent is stopped and the container removed
    And the working copies are left on disk for me to inspect
    And the run's lock is released so I can start again

  @BR-022
  Scenario: An agent that goes silent fails its iteration
    Given an agent that produces no output at all for longer than the idle limit
    When the limit passes
    Then that iteration fails
    And the reason given is that the agent went silent

  @BR-022
  Scenario: An agent that finished but has not exited is treated as successful
    Given an agent that has signalled it finished its work
    And its process has not exited because something it started holds the output open
    When the grace period passes
    Then the iteration is treated as successful
    And the output notes that the agent process lingered

  # ─── Durability and resumption ───

  @BR-023
  Scenario: A crash mid-iteration does not discard what was recorded
    Given a workflow that records progress as it goes
    When it is killed forty minutes into an iteration
    And I run it again
    Then the progress it recorded before the crash is still there

  @BR-024
  Scenario: Resuming restores the work and says what it inherited
    Given a run that died during its fourth iteration leaving uncommitted files
    When I resume it
    Then it continues from the fifth iteration
    And it reports the working copy's position and the uncommitted files it inherited

  @BR-024
  Scenario: Starting fresh discards state and working copies together
    Given a run with stored state and existing working copies
    When I start it fresh
    Then both the stored state and the working copies are discarded
    And the run begins as if for the first time

  # ─── Observability and attribution ───

  @BR-025
  Scenario: Every run can be explained the next morning
    Given a run that failed overnight
    When I read its record
    Then it states which awcli version ran it, which agent version, and where the repository stood

  @BR-026
  Scenario: Detail that cannot be read degrades once and loudly
    Given an agent whose detailed output awcli cannot interpret
    When the run proceeds
    Then a single warning is given
    And the affected detail is reported as unknown
    And the run is not failed for this reason

  @BR-027
  Scenario: Spend is reported and a threshold warns
    Given a spend threshold is configured
    When cumulative spend crosses it during a run
    Then a warning is given
    And the run continues

  @BR-027
  Scenario: A threshold that cannot be measured says so up front
    Given a spend threshold is configured
    And spend cannot be measured for the agent in use
    When the run starts
    Then I am told once that spend cannot be measured
    And I am not left believing the threshold is active

  @BR-028
  Scenario: Four agents at once stay readable
    Given a workflow running four agents in parallel
    When I watch the terminal
    Then I see a compact summary rather than four interleaved outputs
    And each agent's full output is available in its own log

  # ─── Workspace hygiene and portability ───

  @BR-029
  Scenario: The workflow library stays clean enough to sync between machines
    Given I keep my global workflow library under version control
    When I run workflows from it on both of my machines
    Then the library contains only workflows
    And no machine-local state, cache, or log has been written into it

  @BR-030
  Scenario: The generated ignore entry is written once and then left alone
    Given a repository set up for awcli
    When I edit the generated ignore entry
    And I run a workflow again
    Then my edit is preserved
    And my committed awcli files were never added to it

  @BR-031
  Scenario: A project's own workflow shadows the shared one
    Given a workflow named "triage" in my global library
    And the project also has a workflow named "triage"
    When I run "triage" against that project
    Then the project's workflow is used

  @BR-031
  Scenario: The shared workflow is used when the project has none
    Given a workflow named "triage" in my global library
    And the project has no workflow of that name
    When I run "triage" against that project
    Then the global workflow is used

  @BR-031
  Scenario: An explicit path is always honoured
    Given a workflow file at a path outside both libraries
    When I run it by path
    Then that file is used

  @BR-032
  Scenario: A repository in another language needs nothing installed
    Given a Python repository with no JavaScript package manifest and no installed dependencies
    When I run the "triage" workflow against it
    Then it runs
    And nothing was installed into that repository

  @BR-032
  Scenario: A workflow that reaches past the context takes on that requirement itself
    Given a workflow that imports third-party code of its own
    And a repository with no installed dependencies to satisfy it
    When I run that workflow
    Then it fails on its own import, not on anything awcli requires
    And the failure makes clear the requirement came from the workflow

  @BR-033
  Scenario: A workflow written earlier still runs on a later awcli
    Given a workflow written against an earlier version of the context
    When I run it on a later awcli within the same major version
    Then it runs unchanged

  @BR-034
  Scenario: A rehearsal is free and touches nothing real
    Given a run named "triage" with stored state from previous real runs
    When I rehearse the workflow without a real agent
    Then results are produced in the same shape a real agent would give
    And no agent is invoked and no spend is incurred
    And the real run's stored state is untouched

  @BR-034
  Scenario: A rehearsal still creates a working copy
    Given a workflow that reads the repository's recent history
    When I rehearse it
    Then a working copy is created
    And what it reads behaves as it will in earnest
