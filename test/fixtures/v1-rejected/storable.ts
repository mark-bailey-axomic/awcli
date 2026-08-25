// Rejected fixture — every line marked below MUST NOT COMPILE. See ../v1-corpus/README.md.
//
// Storable exists to refuse what cannot survive the crossing to disk and back (BR-008), and no
// corpus fixture can check that. Every file there has to compile, so every one of them probes a
// deletion; a declaration that grows *looser* breaks none of them. Adding a function type to the
// union passes the whole v1 corpus clean, which for a type whose only job is refusal leaves the
// thing it is for unpinned. This file is the other direction: one line per kind of value BR-008
// says is not storable, none of which may ever compile.
//
// The live handle is the class the rule names outright — a function, and an object holding one.
// The rest are values with nothing to come back as: undefined, a symbol, a bigint. Then an
// instance whose properties are all methods, which the union refuses for a reason worth stating
// because it looks accidental — TypeScript infers an implicit index signature for an object
// literal type and never for a class or an interface, so Date and Map are not records of
// Storable however they are spelled.

const asFunction: Storable = () => undefined; // must-not-compile
const asUndefined: Storable = undefined; // must-not-compile
const asSymbol: Storable = Symbol("run"); // must-not-compile
const asBigInt: Storable = 9_007_199_254_740_993n; // must-not-compile
const holdingAFunction: Storable = { onDone: () => undefined }; // must-not-compile
const asDate: Storable = new Date(); // must-not-compile
const asMap: Storable = new Map<string, string>(); // must-not-compile

export default {
  asFunction,
  asUndefined,
  asSymbol,
  asBigInt,
  holdingAFunction,
  asDate,
  asMap,
};
