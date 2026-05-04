# ruflo-federation

The comms layer for multi-agent AI. Cross-installation agent federation with zero-trust security, PII-gated data flow, and compliance-grade audit trails.

## Install

```
/plugin marketplace add ruvnet/ruflo
/plugin install ruflo-federation@ruflo
```

## What's Included

- **Zero-Trust Federation**: Agents discover peers and prove identity via mTLS + ed25519 before any data moves
- **PII Pipeline**: 14-type detection with per-trust-level policies (BLOCK/REDACT/HASH/PASS) and adaptive confidence calibration
- **5-Tier Trust Model**: UNTRUSTED → VERIFIED → ATTESTED → TRUSTED → PRIVILEGED with behavioral scoring
- **Compliance Modes**: HIPAA, SOC2, GDPR audit trails as first-class primitives
- **Secure Messaging**: HMAC-signed envelopes with dual AI Defence gates (outbound + inbound)
- **Byzantine Consensus**: BFT for state mutations across untrusted federation peers
- **Budget Circuit Breaker (ADR-097)**: per-call `maxHops` (default 8), optional `maxTokens` / `maxUsd` caps, and constant-string `HOP_LIMIT_EXCEEDED` / `BUDGET_EXCEEDED` errors that defang recursive delegation loops and runaway cost cascades

## Budget & Circuit Breaker

`/federation send` accepts optional cumulative-spend caps so a single delegation cannot spawn an unbounded fan-out:

```bash
/federation send <node-id> task-assignment '{"task":"…"}' \
  --max-hops 4 \
  --max-tokens 50000 \
  --max-usd 0.25
```

| Field | Default when omitted | Notes |
|---|---|---|
| `maxHops` | `8` | `0` disallows remote delegation entirely. Hard ceiling 64. |
| `maxTokens` | unbounded | Σ tokens across the whole hop chain. Hard ceiling 1B. |
| `maxUsd` | unbounded | Σ USD across hops. Hard ceiling $1M. |
| `hopCount` | `0` | Pass-through for messages being re-forwarded. |
| `spent.{tokens,usd}` | `0` | Caller-reported usage from previous legs. Negatives clamped to 0. |

Validation rejects `NaN`, ±`Infinity`, negative numbers, and non-integer hop counts up front. Errors surface as constant strings with no remaining-budget echo, so a malicious caller cannot use response codes as an oracle to probe configured thresholds.

Phase 1 enforces at the **send** side. Phase 2 (peer state machine: ACTIVE / SUSPENDED / EVICTED) and Phase 3 (`ruflo-cost-tracker` integration for unified spend reporting) ship in follow-up releases.

## Commands

| Command | Description |
|---------|-------------|
| `/federation-init` | Generate keypair and initialize federation on this node |
| `/federation-status` | Show peers, sessions, trust levels, and health |
| `/federation-audit` | Query structured audit logs with compliance filtering |

## Agents

| Agent | Description |
|-------|-------------|
| `federation-coordinator` | Orchestrates discovery, handshake, trust evaluation, and secure message routing |

## Requires

- `ruflo-core` plugin (provides MCP server)
- `@sparkleideas/security` (cryptographic primitives)
