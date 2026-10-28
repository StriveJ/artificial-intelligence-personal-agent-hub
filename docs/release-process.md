# Public releases and offline signing

This workflow handles public programs and release materials. Core, Hub, personal instances, and runtime directories are managed separately. Existing service configuration and personal content are outside its scope. Original project code and documentation use Apache-2.0 in the root LICENSE; third-party licenses are retained. Release tools do not change repository visibility.

## Freeze public source

Review and commit the source, then generate release materials from a clean checkout. Read the program version from package.json and use the same version in commands. `pack` and `prepare` build public Git object bytes from the actual commit, preserving binary content, stable ordering, and line-ending independence. The manifest binds sourceCommit, platforms, architecture, protocols, schemas, sequence, and expiry.

The packaging tools default to Windows/Linux x64 with Node 24. A publisher must test and declare the supported scope for each managed release; these defaults do not establish support for every Linux distribution, ARM, macOS, or existing personal installation. Each trust domain requires a sequence greater than prior releases; record its initial sequence when establishing a new domain.

## Prepare a signing request

On the build machine, substitute the reviewed version, immutable release ID, monotonic sequence, and output path:

```sh
node release.mjs prepare --source <clean-hub-checkout> --id <immutable-release-id> --version <package-version> --sequence <monotonic-sequence> --out <signing-request.json>
```

`prepare` needs no private key. Preserve payloadSha256 and record the version, full source commit, file inventory, Core version/commit/content identity/ZIP digest, test evidence, and supported combinations in the release checklist. Requests contain public source content only; never include real configuration or personal data. A signing request is not installable and must not be renamed as a hubpkg.

The same frozen payload and key produce reproducible signatures. A new prepare operation generates new timestamp and expiry fields, so it is a new request requiring digest review. Use a new ID and sequence for expired or changed packages; never overwrite existing packages.

## Release signing keys

Ed25519 release signatures establish package publisher identity and integrity. Git SSH keys authenticate repository access and must not be reused as release private keys.

For an existing trust domain, verify its public key and fingerprint and retain its custody procedure. To establish new trust, the maintainer runs this on the selected offline device or protected directory:

```sh
node release.mjs keygen --out <offline-custody-directory> --key-id <production-release-key-id>
```

Keep private.pem only at the approved custody location, outside source, chat, release attachments, test directories, and installation packages. Distribute only the public key in trust.json. Verify actual access permissions; POSIX mode options alone do not verify Windows ACLs. Synthetic test keys remain in isolated synthetic-only environments and never become production trust.

## Sign and verify offline

On the signing device, compare the request digest with the reviewed digest:

```sh
node release.mjs sign --request <signing-request.json> --expected-payload-sha256 <reviewed-payload-digest> --key <offline-private-key> --key-id <production-key-id> --out <production.hubpkg.json>
node release.mjs verify --package <production.hubpkg.json> --trust <public-trust.json> --expected-key-sha256 <independently-verified-public-key-fingerprint>
```

`sign` checks the request digest, version, signature, and complete contract. Failures leave no final package. It outputs the public-key fingerprint and package digest. `verify` checks protocol/schema restrictions for both roles and declared platforms; it does not replace installation and runtime testing. Publish the verified fingerprint through a trusted channel. A public key downloaded alongside a package from an unknown location is not automatically trusted.

When private-key custody is separate, the build machine receives only the signed package and public trust.json. Reconfirm final payloadSha256 against the accepted request. If only the envelope keyId or signature changes, still verify with the production public key and run a fresh synthetic installation smoke test.

## Final acceptance and delivery

The checklist identifies Core/Hub versions and tags, full commits, Core content identity/ZIP digest, Hub payload/package digests, public-key fingerprint, platforms/contracts, complete gates, and fresh-install/upgrade/recovery/rollback results for actual supported combinations. State any reused model/device evidence and the basis for equivalence.

A checklist may record technical acceptance pending production signing; releaseReady remains false. Mark a candidate ready only after final identity, production trust, delivery, and support scope are verified. Production deployment is recorded separately: source version numbers and passing tests do not establish that a personal service was upgraded.

Use the controlled public Core updater and the independent Hub install-managed.mjs/launcher maintenance chain separately. Do not bypass package source, compatibility or instance validation. A source tag alone does not establish production signing trust or provide a managed installation package. The 1.0.0 source distribution includes these tools without publishing a managed package or signing key.
