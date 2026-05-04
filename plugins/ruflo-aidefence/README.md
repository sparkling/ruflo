# ruflo-aidefence

AI safety scanning, PII detection, prompt injection defense, and adaptive threat learning.

## Install

```
/plugin marketplace add ruvnet/ruflo
/plugin install ruflo-aidefence@ruflo
```

## Features

- **Safety scanning**: Detect prompt injection, jailbreak attempts, and adversarial content
- **PII detection**: Flag emails, SSNs, API keys, and other sensitive data
- **Adaptive learning**: Train defenses on confirmed threats to improve detection
- **Threat classification**: Categorize threats with confidence scores

## Defense-in-depth pairing (ruflo 3.6.25+)

This plugin pairs with three runtime hardening features that ship in the host (ADR-095 / ADR-096 / audit_1776853149979):

- **Loader-hijack denylist** — `validateEnv()` rejects `LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`, `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, `DYLD_FALLBACK_LIBRARY_PATH`, `DYLD_FORCE_FLAT_NAMESPACE`, `NODE_OPTIONS`, `NODE_PATH` at the `terminal_create` MCP boundary. Adding any of these to a child process is functionally RCE; threat scoring should treat a denylist-enforcing host as substantially less exposed.
- **File mode 0600 / dir mode 0700** on session, terminal, and memory stores via `fs-secure.writeFileRestricted` — cross-user-on-host reads blocked at the OS layer.
- **Encryption at rest** (opt-in via `CLAUDE_FLOW_ENCRYPT_AT_REST=1`) — AES-256-GCM with magic-byte (`RFE1`) backward-compat sniff. Reports involving memory.db / sessions / terminal-history exfiltration should account for the gate state (`ruflo doctor -c encryption`).

## Commands

- `/aidefence` -- Detection stats and threat analysis dashboard

## Skills

- `safety-scan` -- Scan inputs for prompt injection and unsafe content
- `pii-detect` -- Detect PII in text, code, and configurations
