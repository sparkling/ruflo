# ruflo-testgen

Test gap detection, coverage analysis, and automated test generation.

## Install

```
/plugin marketplace add ruvnet/ruflo
/plugin install ruflo-testgen@ruflo
```

## What's Included

- **Coverage Gap Detection**: Identify untested code paths with prioritized gap analysis
- **Coverage-Aware Routing**: Route tasks to agents based on test coverage needs
- **Test Generation**: Automated test scaffolding for uncovered modules
- **TDD Support**: London School (mock-first) test patterns with agent coordination
- **testgaps Worker**: Background worker for continuous coverage analysis
- **Integration**: Works with hooks system for post-edit test suggestions

## Requires

- `ruflo-core` plugin (provides MCP server)
