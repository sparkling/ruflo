# hook pre-task

Execute pre-task preparations and context loading.

## Usage

```bash
npx claude-flow hook pre-task [options]
```

## Options

- `--description, -d <text>` - Task description for context

## Examples

### Basic pre-task hook

```bash
npx claude-flow hook pre-task --description "Implement user authentication"
```

## Integration

This hook is automatically called by Claude Code when:

- Starting a new task
- Resuming work after a break
- Switching between projects
- Beginning complex operations

Manual usage in agents:

```bash
# In agent coordination
npx claude-flow hook pre-task --description "Your task here"
```

## Output

Returns JSON with:

```json
{
  "continue": true,
  "topology": "hierarchical",
  "agentsSpawned": 5,
  "complexity": "medium",
  "estimatedMinutes": 30,
  "memoryLoaded": true
}
```

## See Also

- `hook post-task` - Post-task cleanup
- `agent spawn` - Manual agent creation
- `memory usage` - Memory management
- `swarm init` - Swarm initialization
