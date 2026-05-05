# ruflo-wasm

Sandboxed WASM agent creation, execution, and gallery sharing.

## Install

```
/plugin marketplace add ruvnet/ruflo
/plugin install ruflo-wasm@ruflo
```

## Features

- **Sandbox isolation**: Agents run in WASM with no host filesystem access
- **Agent lifecycle**: Create, prompt, configure tools, export, terminate
- **Community gallery**: Browse, search, and publish WASM agents
- **Portable**: Export agents that run on any WASM runtime

## Commands

- `/wasm` -- List running agents and browse gallery

## Skills

- `wasm-agent` -- Create and manage sandboxed WASM agents
- `wasm-gallery` -- Browse and publish agents in the community gallery

## Compatibility

- **CLI:** pinned to `@claude-flow/cli` v3.6 major+minor.
- **WASM runtime:** built on `@ruvector/rvagent-wasm` + `@ruvector/ruvllm-wasm`. Both are declared in `@claude-flow/cli`'s `optionalDependencies` per [ADR-070 (Implemented)](../../v3/implementation/adrs/ADR-070-rvagent-wasm-completion.md). Without those packages, runtime falls through to the graceful-degradation path and the MCP tools no-op.
- **Verification:** `bash plugins/ruflo-wasm/scripts/smoke.sh` is the contract.

## MCP surface (10 tools)

All defined at `v3/@claude-flow/cli/src/mcp-tools/wasm-agent-tools.ts`:

### Agent lifecycle (7)

| Tool | Purpose |
|------|---------|
| `wasm_agent_create` | Spin up a sandboxed WASM agent |
| `wasm_agent_prompt` | Send a prompt to the agent |
| `wasm_agent_tool` | Invoke a tool inside the sandbox |
| `wasm_agent_list` | List active WASM agents |
| `wasm_agent_terminate` | Stop a WASM agent |
| `wasm_agent_files` | Read/write files in the sandbox |
| `wasm_agent_export` | Export agent state |

### Gallery (3)

| Tool | Purpose |
|------|---------|
| `wasm_gallery_list` | Browse community-published WASM agents |
| `wasm_gallery_search` | Search the gallery |
| `wasm_gallery_create` | Publish a WASM agent to the gallery |

## Sandbox isolation

WASM agents run with **no host filesystem access** by default. The `wasm_agent_files` tool exposes a sandboxed virtual filesystem; the host filesystem is not reachable from inside the WASM module.

For prompt-injection defense inside the sandbox, the [ruflo-aidefence 3-gate pattern](../ruflo-aidefence/docs/adrs/0001-aidefence-contract.md) applies to any output flowing back to the host LLM.

## Namespace coordination

This plugin owns the `wasm-gallery` AgentDB namespace (kebab-case, follows the convention from [ruflo-agentdb ADR-0001 §"Namespace convention"](../ruflo-agentdb/docs/adrs/0001-agentdb-optimization.md)). Reserved namespaces (`pattern`, `claude-memories`, `default`) MUST NOT be shadowed.

`wasm-gallery` indexes published WASM agents (manifest, version, signature, download count). Accessed via `memory_*` (namespace-routed).

## Verification

```bash
bash plugins/ruflo-wasm/scripts/smoke.sh
# Expected: "11 passed, 0 failed"
```

## Architecture Decisions

- [`ADR-0001` — ruflo-wasm plugin contract (10-tool MCP surface, ADR-070 integration cross-reference, sandbox isolation, smoke as contract)](./docs/adrs/0001-wasm-contract.md)

## Related Plugins

- `ruflo-agentdb` — namespace convention owner
- `ruflo-aidefence` — 3-gate pattern applies to sandbox output flowing back to the host LLM
- `ruflo-ruvector` — the underlying ruvector substrate that ships @ruvector/rvagent-wasm
