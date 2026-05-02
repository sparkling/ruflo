---
name: ruflo-doctor
description: Run health checks on the Ruflo installation and fix common issues
argument-hint: "[--fix]"
allowed-tools: Bash(npx *)
---
Run `npx @sparkleideas/cli@latest doctor --fix` to diagnose and auto-repair common issues.

Checks: Node.js 20+, npm 9+, git, config validity, daemon status, memory database, API keys, MCP servers, disk space, TypeScript.

Targeted fixes:
- Memory: `npx @sparkleideas/cli@latest memory init --force`
- Daemon: `npx @sparkleideas/cli@latest daemon start`
- Config: `npx @sparkleideas/cli@latest config reset`
