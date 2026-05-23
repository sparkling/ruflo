# hook post-edit

Execute post-edit processing including formatting, validation, and memory updates.

## Usage

```bash
npx claude-flow hook post-edit [options]
```

## Options

- `--file, -f <path>` - File path that was edited
- `--train-patterns` - Train neural patterns from edit

## Examples

### Basic post-edit hook

```bash
npx claude-flow hook post-edit --file "src/components/Button.jsx"
```

### Neural training

```bash
npx claude-flow hook post-edit -f "utils/helpers.ts" --train-patterns
```

## Features

### Pattern Training

- Learns from successful edits
- Improves future suggestions
- Adapts to coding style
- Enhances coordination

## Integration

This hook is automatically called by Claude Code when:

- After Edit tool completes
- Following MultiEdit operations
- During file saves
- After code generation

Manual usage in agents:

```bash
# After editing files
npx claude-flow hook post-edit --file "path/to/edited.js"
```

## Output

Returns JSON with:

```json
{
  "file": "src/components/Button.jsx",
  "formatted": true,
  "formatterUsed": "prettier",
  "lintPassed": true,
  "memorySaved": "component/button-refactor",
  "patternsTrained": 3,
  "warnings": [],
  "stats": {
    "linesChanged": 45,
    "charactersAdded": 234
  }
}
```

## See Also

- `hook pre-edit` - Pre-edit preparation
- `Edit` - File editing tool
- `memory usage` - Memory management
- `neural train` - Pattern training
