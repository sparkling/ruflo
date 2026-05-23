# hook post-task

Execute post-task cleanup, performance analysis, and memory storage.

## Usage

```bash
npx claude-flow hook post-task [options]
```

## Options

- `--task-id, -t <id>` - Task identifier for tracking

## Examples

### Basic post-task hook

```bash
npx claude-flow hook post-task --task-id "auth-implementation"
```

## Features

### Neural Learning

- Exports successful patterns
- Updates coordination models
- Improves future performance
- Trains on task outcomes

## Integration

This hook is automatically called by Claude Code when:

- Completing a task
- Switching to a new task
- Ending a work session
- After major milestones

Manual usage in agents:

```bash
# In agent coordination
npx claude-flow hook post-task --task-id "your-task-id"
```

## Output

Returns JSON with:

```json
{
  "taskId": "auth-implementation",
  "duration": 1800000,
  "tokensUsed": 45000,
  "filesModified": 12,
  "performanceScore": 0.92,
  "learningsExported": true,
  "reportPath": "/reports/task-auth-implementation.md"
}
```

## See Also

- `hook pre-task` - Pre-task setup
- `performance report` - Detailed metrics
- `memory usage` - Memory management
- `neural patterns` - Pattern analysis
