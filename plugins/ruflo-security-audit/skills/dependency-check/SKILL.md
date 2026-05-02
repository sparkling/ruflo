---
name: dependency-check
description: Scan project dependencies for known vulnerabilities and CVEs
argument-hint: "[--path PATH]"
allowed-tools: Bash(npx * npm *) mcp__ruflo__memory_store Read
---
Check dependencies for CVEs and outdated packages:

```bash
npx @sparkleideas/cli@latest security cve --check
npx @sparkleideas/cli@latest security audit --include-dev
npm audit --json
```

| Severity | Action |
|----------|--------|
| critical | Block deployment, fix immediately |
| high | Fix before next release |
| moderate | Schedule fix within sprint |
| low | Track in backlog |

Auto-fix: `npx @sparkleideas/cli@latest security cve --fix`

For continuous monitoring, dispatch via MCP:
`mcp__ruflo__hooks_worker-dispatch({ trigger: "audit" })`
