/**
 * Unit tests for `ruflo skill list` — ADR-0216 Option E.
 *
 * Verifies the command:
 *   - is registered (closes F-15-001 broken-promise)
 *   - exposes `skill` (singular, the advertised form) + `skills` alias
 *   - enumerates a `.claude/skills/` tree (the EMITTED dir, not source)
 *   - flags SKILL.md-less dirs without skipping them
 *   - parses frontmatter `description` from each `SKILL.md`
 *   - supports `--format json`
 *   - fails cleanly when no `.claude/skills/` exists
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { skillCommand } from '../src/commands/skill.js';
import type { CommandContext } from '../src/types.js';

describe('ADR-0216 — `ruflo skill list` command', () => {
  let tmpRoot: string;
  let writeOutput: string[];
  let writeErrOutput: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'ruflo-skill-list-'));
    writeOutput = [];
    writeErrOutput = [];
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((data: any) => {
      writeOutput.push(String(data));
      return true;
    });
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((data: any) => {
      writeErrOutput.push(String(data));
      return true;
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('command surface: skill with subcommand list (advertised spelling)', () => {
    expect(skillCommand.name).toBe('skill');
    expect(skillCommand.aliases).toContain('skills');
    const listSub = skillCommand.subcommands?.find((s) => s.name === 'list');
    expect(listSub).toBeDefined();
    expect(listSub?.action).toBeDefined();
  });

  it('fails loud when no .claude/skills/ exists at the cwd', async () => {
    const listSub = skillCommand.subcommands?.find((s) => s.name === 'list')!;
    const ctx: CommandContext = {
      flags: { cwd: tmpRoot, _: [] },
    } as any;
    const result = await listSub.action!(ctx);
    expect(result?.success).toBe(false);
    expect(result?.exitCode).toBe(1);
    // Error went to stderr
    const errText = writeErrOutput.join('');
    expect(errText).toMatch(/No skills directory/);
  });

  it('lists skill dirs from a fixture tree (json format)', async () => {
    // Build a fixture .claude/skills/ tree with three dirs:
    //  - swarm-orchestration : has SKILL.md with description
    //  - dual-mode           : no SKILL.md (whitelisted SKILL.md-less)
    //  - github-code-review  : SKILL.md without description
    const skillsDir = join(tmpRoot, '.claude', 'skills');
    mkdirSync(join(skillsDir, 'swarm-orchestration'), { recursive: true });
    writeFileSync(
      join(skillsDir, 'swarm-orchestration', 'SKILL.md'),
      '---\nname: swarm-orchestration\ndescription: Orchestrate multi-agent swarms\n---\n\n# Body\n',
    );
    mkdirSync(join(skillsDir, 'dual-mode'), { recursive: true });
    // No SKILL.md — but helper md files
    writeFileSync(join(skillsDir, 'dual-mode', 'README.md'), '# Dual mode helper\n');
    mkdirSync(join(skillsDir, 'github-code-review'), { recursive: true });
    writeFileSync(
      join(skillsDir, 'github-code-review', 'SKILL.md'),
      '---\nname: github-code-review\n---\n\n# Body\n',
    );

    const listSub = skillCommand.subcommands?.find((s) => s.name === 'list')!;
    const ctx: CommandContext = {
      flags: { cwd: tmpRoot, format: 'json', _: [] },
    } as any;
    const result = await listSub.action!(ctx);

    expect(result?.success).toBe(true);
    const data = result?.data as Array<{ name: string; hasSkillMd: boolean; description: string }>;
    expect(data).toBeDefined();
    expect(data.length).toBe(3);
    // Sorted alphabetically
    expect(data.map((d) => d.name)).toEqual([
      'dual-mode',
      'github-code-review',
      'swarm-orchestration',
    ]);
    // dual-mode: no SKILL.md
    expect(data.find((d) => d.name === 'dual-mode')?.hasSkillMd).toBe(false);
    // swarm-orchestration: has SKILL.md + description
    const swarm = data.find((d) => d.name === 'swarm-orchestration');
    expect(swarm?.hasSkillMd).toBe(true);
    expect(swarm?.description).toBe('Orchestrate multi-agent swarms');
    // github-code-review: has SKILL.md but no description
    const gh = data.find((d) => d.name === 'github-code-review');
    expect(gh?.hasSkillMd).toBe(true);
    expect(gh?.description).toBe('');
  });

  it('text format prints a table and skill count summary', async () => {
    const skillsDir = join(tmpRoot, '.claude', 'skills');
    mkdirSync(join(skillsDir, 'sparc-methodology'), { recursive: true });
    writeFileSync(
      join(skillsDir, 'sparc-methodology', 'SKILL.md'),
      '---\nname: sparc-methodology\ndescription: SPARC orchestration\n---\n',
    );

    const listSub = skillCommand.subcommands?.find((s) => s.name === 'list')!;
    const ctx: CommandContext = {
      flags: { cwd: tmpRoot, _: [] },
    } as any;
    const result = await listSub.action!(ctx);

    expect(result?.success).toBe(true);
    const stdoutText = writeOutput.join('');
    // Header
    expect(stdoutText).toMatch(/Claude Code skills/);
    // Skill name
    expect(stdoutText).toMatch(/sparc-methodology/);
    // Total summary
    expect(stdoutText).toMatch(/Total: 1 skill/);
  });
});
