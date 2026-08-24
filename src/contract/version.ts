/**
 * The contract's version, which is deliberately not awcli's version.
 *
 * They move independently. awcli ships fixes and features continuously, while this surface
 * is frozen and grows only additively (BR-033). Starting at 1.0.0 while the binary is still
 * 0.x says which of the two is settled — and a repository's declared range gates the binary
 * (BR-003), so nothing depends on the two numbers ever agreeing.
 *
 * Bump the minor to add a member; a major means a member was removed or narrowed, which is
 * the one change the version range gate exists to make visible. The minor half of that is
 * enforced — additive-only.test.ts holds it against the growth of CONTEXT_SURFACE — and the
 * major half is not, because no test can tell a deliberate breaking change from an accident.
 * The frozen corpus under test/fixtures/v1-corpus is what makes an accidental one fail.
 */
export const CONTRACT_VERSION = "1.0.0";
