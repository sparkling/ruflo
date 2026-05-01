---
name: federation
description: Manage cross-installation agent federation
---
$ARGUMENTS
Manage federation peers, trust, and audit logs. Parse subcommand from $ARGUMENTS.

Usage: /federation <subcommand> [options]

Subcommands:
- `init` -- Generate keypair and initialize federation
- `join <endpoint>` -- Connect to a federation peer
- `leave` -- Leave the federation gracefully
- `peers` -- List known peers with trust levels
- `status` -- Show federation health, sessions, metrics
- `audit [--compliance hipaa|soc2|gdpr] [--since DATE]` -- Query audit logs
- `trust <node-id> [--review]` -- View trust score breakdown
- `config [--pii-policy PATH]` -- Configure PII policies and compliance mode

Steps by subcommand:

**init**: `npx -y -p @claude-flow/plugin-agent-federation@latest ruflo-federation init`
**join**: `npx -y -p @claude-flow/plugin-agent-federation@latest ruflo-federation join ENDPOINT`
**leave**: `npx -y -p @claude-flow/plugin-agent-federation@latest ruflo-federation leave`
**peers**: `npx -y -p @claude-flow/plugin-agent-federation@latest ruflo-federation peers`
**status**: `npx -y -p @claude-flow/plugin-agent-federation@latest ruflo-federation status`
**audit**: `npx -y -p @claude-flow/plugin-agent-federation@latest ruflo-federation audit --compliance MODE --since DATE`
**trust**: `npx -y -p @claude-flow/plugin-agent-federation@latest ruflo-federation trust NODE_ID --review`
**config**: `npx -y -p @claude-flow/plugin-agent-federation@latest ruflo-federation config --pii-policy PATH`
