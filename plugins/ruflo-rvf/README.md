# ruflo-rvf

RVF format for portable agent memory, session persistence, and cross-platform transfer.

## Install

```
/plugin marketplace add ruvnet/ruflo
/plugin install ruflo-rvf@ruflo
```

## Features

- **RVF format**: Portable vector memory with embeddings, metadata, and causal graphs
- **Session persistence**: Save and restore complete agent sessions across conversations
- **Cross-project transfer**: Export and import knowledge between projects
- **Claude memory bridge**: Import Claude Code auto-memories into AgentDB
- **Format migration**: Upgrade RVF files across versions

## Encryption at rest (ruflo 3.6.25+)

Sessions persisted by this plugin land at `.claude-flow/sessions/*.json`, which are written through `fs-secure.writeFileRestricted({encrypt:true})` per [ADR-096](../../v3/docs/adr/ADR-096-encryption-at-rest.md). Behavior under the gate:

- **Off by default** (`CLAUDE_FLOW_ENCRYPT_AT_REST` unset / falsy) — sessions are plaintext JSON at mode 0600, same as ruflo 3.6.24 and earlier.
- **On** (`CLAUDE_FLOW_ENCRYPT_AT_REST=1` + `CLAUDE_FLOW_ENCRYPTION_KEY` set to 64-char hex or 44-char base64) — each session save is AES-256-GCM with `RFE1` magic-byte prefix. Session restore transparently decrypts via the magic sniff; legacy plaintext sessions still load unchanged during migration.

When **exporting RVF files for cross-machine transfer**, the encryption gate does NOT apply to the exported bytes — the encryption is at-rest on the *originating* host. If the RVF is itself sensitive, transport security (sealed boxes / signed blobs) is the next phase per the ADR roadmap.

Confirm the gate state with `ruflo doctor -c encryption`.

## Commands

- `/rvf` -- Memory stats, saved sessions, storage metrics

## Skills

- `rvf-manage` -- Manage RVF files for portable memory
- `session-persist` -- Persist and restore agent sessions
