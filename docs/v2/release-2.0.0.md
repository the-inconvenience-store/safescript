# SafeScript 2.0.0 release record

SafeScript 2.0.0 is one coordinated package set: contracts, engine, worker, SDK, CLI, and conformance metadata. The release freezes worker protocol 1.0, fixture schema 1.0.0, action ABI 2.0, and the published failure catalogue.

The release gate builds each package, creates its npm tarball, installs only those tarballs into a clean directory, and exercises the installed SDK, worker, CLI, fixtures, and conformance corpus on Node.js 22 and 24 across every supported platform. The checked-in [machine-readable release record](../../conformance/evidence/release/2.0.0.json) pins the normative hashes and security review, while the [upgrade record](../../conformance/evidence/release/v1-to-v2-upgrade.json) identifies the executable v1-to-v2 regeneration test.

Registry publication remains a distinct final operation. It requires an authenticated npm identity with permission to publish the `@safescript` scope; release-gate success does not claim that registry publication occurred.
