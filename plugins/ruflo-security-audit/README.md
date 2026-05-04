# ruflo-security-audit

Security review, dependency scanning, policy gates, and CVE monitoring.

## Install

```
/plugin marketplace add ruvnet/ruflo
/plugin install ruflo-security-audit@ruflo
```

## What's Included

- **Security Scanning**: Full-depth scan with `security scan --depth full`
- **CVE Monitoring**: Automated CVE detection and remediation guidance
- **Input Validation**: Zod-based validation at system boundaries via `@sparkleideas/security`
- **Path Security**: Traversal prevention and safe executor for command injection protection
- **Policy Gates**: Configurable security policies for CI/CD pipelines
- **Threat Modeling**: Automated threat analysis and risk assessment

## Patterns to scan for (audit_1776853149979 follow-up)

The 3.6.25 release closed a class of shell-injection bugs. When auditing downstream code, the scanner should flag these patterns:

- **`execSync(string)` with template-literal args** — replace with `execFileSync(cmd, argv, { shell: false })`. Closed sites: `github-safe.js`, `statusline.js/cjs` (git calls), `mcp-tools/github-tools.ts` (`gh pr/issue/run`), `update/executor.ts` (`npm install`).
- **Numeric MCP inputs cast as `number`** — TypeScript casts don't run at runtime. A `prNumber: "1; rm -rf /"` slips through. Mitigate via `toPositiveInt(value)` (see `src/mcp-tools/github-tools.ts`).
- **Untrusted package specs flowing into `npm install`** — gate via `isSafePackageSpec(pkg, version)` regex check (see `src/update/executor.ts`). Defense-in-depth even with `execFileSync`.
- **Loader-hijack env vars** (`LD_PRELOAD`, `NODE_OPTIONS`, `DYLD_*`) flowing into a child process env — gate via `validateEnv()` (see `src/mcp-tools/validate-input.ts`).
- **Plaintext secrets at rest** in `.claude-flow/sessions/`, `.claude-flow/terminals/store.json`, `.swarm/memory.db` — paired with [ADR-096](../../v3/docs/adr/ADR-096-encryption-at-rest.md) opt-in encryption (`CLAUDE_FLOW_ENCRYPT_AT_REST=1`). Confirm gate state via `ruflo doctor -c encryption`.
- **MCP stdin DoS** — un-newlined input piped into the MCP server. The host caps the buffer at 10MB by default; downstream MCP wrappers should enforce equivalent limits.

A `ruflo verify` round-trip confirms 55 witnesses (27 regression-fix + 28 per-source-file capability) match the signed manifest byte-for-byte.

## Requires

- `ruflo-core` plugin (provides MCP server)
