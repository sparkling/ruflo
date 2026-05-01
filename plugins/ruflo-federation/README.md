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
- `@claude-flow/security` (cryptographic primitives)
