# hook pre-edit

Execute pre-edit validations and agent assignment before file modifications.

## Usage

```bash
npx claude-flow hook pre-edit [options]
```

## Options

- `--file, -f <path>` - File path to be edited

## Examples

### Basic pre-edit hook

```bash
npx claude-flow hook pre-edit --file "src/auth/login.js"
```

## Integration

This hook is automatically called by Claude Code when:

- Using Edit or MultiEdit tools
- Before file modifications
- During refactoring operations
- When updating critical files

Manual usage in agents:

```bash
# Before editing files
npx claude-flow hook pre-edit --file "path/to/file.js"
```

## Output

Returns JSON with:

```json
{
  "continue": true,
  "file": "src/auth/login.js",
  "assignedAgent": "auth-specialist",
  "syntaxValid": true,
  "conflicts": false,
  "backupPath": ".backups/login.js.bak",
  "warnings": []
}
```

## See Also

- `hook post-edit` - Post-edit processing
- `Edit` - File editing tool
- `MultiEdit` - Multiple edits tool
- `agent spawn` - Manual agent creation
