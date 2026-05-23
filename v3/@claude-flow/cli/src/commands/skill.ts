/**
 * V3 CLI Skill Command — ADR-0216 Option E.
 *
 * `ruflo skill list` enumerates Claude Code skills in the current
 * project's `.claude/skills/` directory. This closes the broken-promise
 * F-15-001: `ruflo init` and the generated CLAUDE.md advertise
 * `ruflo skill list` in 5 places (`init.ts:529,889`,
 * `claudemd-generator.ts:154,167,179`) but the command did not exist
 * pre-ADR-0216 (`ruflo skills`, `ruflo skill list` → exit 1 "Unknown
 * command").
 *
 * Design per ADR-0216 §(1):
 *   - Singular `skill` (matches the advertised form) with `skills` alias.
 *   - `list` subcommand enumerates the EMITTED `${cwd}/.claude/skills/`
 *     directly (NOT `findSourceDir`'s source resolution — the ADR's
 *     second-pass note on enumerating the emitted tree).
 *   - SKILL.md frontmatter is parsed to extract `description`.
 *   - `dual-mode/` is enumerated like any other dir but flagged
 *     "(no SKILL.md)" — matches the corpus-shape acceptance whitelist.
 *   - JSON output via `--format json` for scripts.
 *
 * Out of scope (CUT per Option E):
 *   - `skill validate` — redundant TS twin of the corpus-shape shell check.
 *   - `skill show` — `cat` already works.
 *   - `skill install` — `ruflo init skills` already exists.
 *   - dedupe / precedence rules — `copySkills` is single-source.
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { findProjectRoot } from '../mcp-tools/types.js';
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';

interface SkillEntry {
  name: string;
  hasSkillMd: boolean;
  description: string;
  path: string;
}

function parseFrontmatter(content: string): Record<string, string> {
  // Match the leading `---\n...\n---` block. The first key:value lines.
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const lines = m[1].split('\n');
  const fm: Record<string, string> = {};
  for (const line of lines) {
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (kv) {
      fm[kv[1]] = kv[2].trim();
    }
  }
  return fm;
}

function enumerateSkills(skillsDir: string): SkillEntry[] {
  const entries: SkillEntry[] = [];
  let dirEntries;
  try {
    dirEntries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const e of dirEntries) {
    if (!e.isDirectory()) continue;
    const skillPath = join(skillsDir, e.name);
    const skillMdPath = join(skillPath, 'SKILL.md');
    let hasSkillMd = false;
    let description = '';
    if (existsSync(skillMdPath)) {
      try {
        const stat = statSync(skillMdPath);
        if (stat.isFile()) {
          hasSkillMd = true;
          const content = readFileSync(skillMdPath, 'utf8');
          const fm = parseFrontmatter(content);
          description = fm.description || '';
        }
      } catch (err: any) {
        // ENOENT = TOCTOU race between existsSync and statSync → silent.
        // Any other code (EACCES, parse error, etc.) must surface per
        // feedback-no-fallbacks; description stays empty in the response.
        if (err?.code !== 'ENOENT') {
          console.warn('[ruflo.skill.list] failed to read', skillMdPath, err?.message ?? err);
        }
      }
    }
    entries.push({
      name: e.name,
      hasSkillMd,
      description,
      path: skillPath,
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

const listCommand: Command = {
  name: 'list',
  description: 'List Claude Code skills in the current project (.claude/skills/)',
  options: [
    { name: 'format', short: 'f', type: 'string', description: 'Output format: text (default) or json' },
    { name: 'cwd', type: 'string', description: 'Project root to enumerate (default: current working directory)' },
  ],
  examples: [
    { command: 'ruflo skill list', description: 'List all skills emitted into the current project' },
    { command: 'ruflo skill list --format json', description: 'Emit JSON for scripts' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // ADR-0100 §1: anchor on findProjectRoot(), never process.cwd().
    // The `--cwd` flag remains an explicit override for scripts/tests.
    const cwd = (ctx.flags.cwd as string | undefined) ?? findProjectRoot();
    const skillsDir = join(cwd, '.claude', 'skills');

    if (!existsSync(skillsDir)) {
      output.printError(
        `No skills directory at ${skillsDir}.\n` +
        `Run \`ruflo init\` in this project first.`,
      );
      return { success: false, exitCode: 1 };
    }

    const skills = enumerateSkills(skillsDir);
    const format = (ctx.flags.format as string | undefined) ?? 'text';

    if (format === 'json') {
      output.printJson(skills);
      return { success: true, data: skills };
    }

    output.writeln();
    output.writeln(output.bold(`Claude Code skills in ${skillsDir}`));
    output.writeln(output.dim('─'.repeat(70)));

    if (skills.length === 0) {
      output.writeln(output.dim('No skills found.'));
      return { success: true, data: skills };
    }

    output.printTable({
      columns: [
        { key: 'name', header: 'Skill', width: 32 },
        { key: 'status', header: 'SKILL.md', width: 10 },
        { key: 'description', header: 'Description', width: 60 },
      ],
      data: skills.map((s) => ({
        name: s.name,
        status: s.hasSkillMd ? output.success('yes') : output.dim('no'),
        description: s.description || output.dim('(none)'),
      })),
    });

    const withMd = skills.filter((s) => s.hasSkillMd).length;
    output.writeln();
    output.writeln(output.dim(`Total: ${skills.length} skill dir(s); ${withMd} with SKILL.md.`));

    return { success: true, data: skills };
  },
};

export const skillCommand: Command = {
  name: 'skill',
  description: 'Manage Claude Code skills in the current project',
  aliases: ['skills'],
  subcommands: [listCommand],
  examples: [
    { command: 'ruflo skill list', description: 'List skills emitted into the current project' },
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Ruflo Skills'));
    output.writeln(output.dim('Claude Code skill management'));
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('list')}  - List Claude Code skills in the current project`,
    ]);
    output.writeln();
    output.writeln(output.dim('Skills are emitted into .claude/skills/ by `ruflo init`.'));
    return { success: true };
  },
};

export default skillCommand;
