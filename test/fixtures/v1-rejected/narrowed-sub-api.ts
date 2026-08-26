// Rejected fixture — every line marked below MUST NOT COMPILE. See ../v1-corpus/README.md.
//
// Sub-API members are arrow properties, not methods, so strictFunctionTypes makes their
// parameters contravariant. Under method syntax this narrowing was accepted as a GitApi,
// which is what left the conformance gate blind to nine of the twelve members.

const narrowed: GitApi = {
  branch: () => Promise.resolve("main"),
  log: () => Promise.resolve([]),
  diff: () => Promise.resolve(""),
  commit: (message: "feat" | "fix") => Promise.resolve({ sha: "a", subject: message }), // must-not-compile
};

export default narrowed;
