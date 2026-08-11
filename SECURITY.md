# Security Policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in Scrambler, please
report it through **GitHub's private security advisory feature** for this
repository:

<https://github.com/schlangens/scrambler/security/advisories/new>

Do not open a public issue or pull request that discloses the vulnerability.
We will work with you to validate the report, fix the issue, and disclose it
responsibly.

## What to include

- A clear description of the vulnerability and the threat model.
- Steps to reproduce, ideally with a minimal test case or fixture.
- The version or commit you tested against.
- Any suggested remediation, if you have one.

Please use only **synthetic data** in test fixtures and reproductions. Never
include real personal information.

## Supported versions

Only the latest release on the `main` branch is supported with security fixes.
Older releases and tags are not maintained.

## Scope

### In scope

- The source code in this repository (`src/`, `public/`, `scripts/`, `Dockerfile`,
  CI workflows).
- The offline build (`public/scrambler-offline.html`) and its guarantees of
  zero network references.
- Claims about data handling: text masking is client-side, PDF redaction is
  ephemeral and in-memory, and no user data is persisted.

### Out of scope

- The hosted demonstration instance at `https://scramble.scottslab.io`. It is
  provided as a convenience, not as a target for security testing. Please do not
  attempt to attack, test, or probe it.
- Third-party infrastructure, dependencies, or browsers outside of what this
  repository ships.
- Vulnerabilities in end-of-life versions.

## Response commitment

We aim to acknowledge a new report within **5 business days**. For confirmed
vulnerabilities that affect the supported version, we will:

1. Provide an initial assessment within **10 business days**.
2. Work on a fix and coordinate disclosure.
3. Credit the reporter in the advisory unless they prefer to remain anonymous.

This is a small, open-source project, so timelines may shift if a fix requires
changes across multiple sessions or dependencies. We will keep reporters
informed of progress.
