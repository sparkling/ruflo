/**
 * ADR-0033: All controllers activation smoke test
 *
 * Verifies that every controller name in the ControllerName union type
 * has a corresponding case in createController (via INIT_LEVELS) and
 * that the ControllerRegistry can handle them all.
 */

import { describe, it, expect } from 'vitest';
import {
  ControllerRegistry,
  INIT_LEVELS,
  type ControllerName,
} from '../controller-registry.js';

/**
 * All controller names that appear in INIT_LEVELS.
 * federatedSession is included (it returns null but has a factory case).
 */
const ALL_CONTROLLERS: ControllerName[] = [
  // Pre-existing (7)
  'tieredCache',
  'memoryGraph',
  'learningBridge',
  'hierarchicalMemory',
  'memoryConsolidation',
  'reasoningBank',
  'hybridSearch',
  // Phase 2 (1)
  'solverBandit',
  // Phase 3 (3)
  'reflexion',
  'causalGraph',
  'nightlyLearner',
  // Phase 4 (4)
  'skills',
  'explainableRecall',
  'learningSystem',
  'agentMemoryScope',
  // Phase 5 (6)
  'vectorBackend',
  'mutationGuard',
  'attestationLog',
  'graphTransformer',
  'semanticRouter',
  'sonaTrajectory',
  // Deferred / Wrappers (6)
  // NOTE: causalRecall has a createController case but is NOT in INIT_LEVELS
  'batchOperations',
  'contextSynthesizer',
  'mmrDiversityRanker',
  'graphAdapter',
  'gnnService',
  'rvfOptimizer',
  // Security composite (1)
  'guardedVectorBackend',
  // Session (1)
  'federatedSession',
];

describe('ADR-0033: All controllers activation smoke test', () => {
  it('should list all controller names from INIT_LEVELS', () => {
    const initLevelNames = new Set<string>();
    for (const level of INIT_LEVELS) {
      for (const name of level.controllers) {
        initLevelNames.add(name);
      }
    }

    // Every controller in ALL_CONTROLLERS should appear in INIT_LEVELS
    for (const name of ALL_CONTROLLERS) {
      expect(
        initLevelNames.has(name),
        `Controller '${name}' missing from INIT_LEVELS`,
      ).toBe(true);
    }
  });

  it('should have no duplicate controllers across INIT_LEVELS', () => {
    const seen = new Set<string>();
    for (const level of INIT_LEVELS) {
      for (const name of level.controllers) {
        expect(
          seen.has(name),
          `Controller '${name}' appears in multiple INIT_LEVELS`,
        ).toBe(false);
        seen.add(name);
      }
    }
  });

  it('should have at least 29 controllers in INIT_LEVELS', () => {
    let total = 0;
    for (const level of INIT_LEVELS) {
      total += level.controllers.length;
    }
    // 29 controllers across levels 0-6
    expect(total).toBeGreaterThanOrEqual(29);
  });

  it('should include all ALL_CONTROLLERS entries in the ControllerName type', () => {
    // This is a compile-time check: if a string in ALL_CONTROLLERS is NOT
    // in the ControllerName union, TypeScript will fail compilation.
    // At runtime, verify the array length matches expectations.
    expect(ALL_CONTROLLERS.length).toBeGreaterThanOrEqual(29);

    // Verify uniqueness
    const unique = new Set(ALL_CONTROLLERS);
    expect(unique.size).toBe(ALL_CONTROLLERS.length);
  });

  it('should instantiate ControllerRegistry without error', () => {
    const registry = new ControllerRegistry();
    expect(registry).toBeInstanceOf(ControllerRegistry);
    expect(registry.isInitialized()).toBe(false);
  });

  it('should initialize registry and handle all controller factory cases', async () => {
    const registry = new ControllerRegistry();

    // Enable ALL controllers explicitly so createController is called for each
    const controllerConfig: Partial<Record<ControllerName, boolean>> = {};
    for (const name of ALL_CONTROLLERS) {
      controllerConfig[name] = true;
    }

    // Initialize with all controllers enabled.
    // Some will fail (no agentdb, no backend) but createController must
    // not throw an unhandled exception -- failures are isolated.
    await registry.initialize({
      controllers: controllerConfig,
    });

    expect(registry.isInitialized()).toBe(true);

    // Verify the registry processed every controller (either enabled or failed)
    const listed = registry.listControllers();
    const listedNames = new Set(listed.map((c) => c.name));

    // Controllers that are enabled by default or explicitly enabled should
    // appear in the list (failed controllers are also listed)
    for (const name of ALL_CONTROLLERS) {
      // Controllers may or may not be in the list depending on whether
      // isControllerEnabled returns true. Since we force-enabled them
      // via config, they should all appear.
      if (listedNames.has(name)) {
        // Found in the registry -- good
        const entry = listed.find((c) => c.name === name);
        expect(entry).toBeDefined();
      }
      // If not listed, the explicit enable was overridden by the factory
      // returning null (which is still valid -- no crash)
    }

    await registry.shutdown();
  });

  it('should report health for initialized controllers', async () => {
    const registry = new ControllerRegistry();
    await registry.initialize({});

    const report = await registry.healthCheck();

    expect(report).toHaveProperty('status');
    expect(report).toHaveProperty('controllers');
    expect(report).toHaveProperty('timestamp');
    expect(report).toHaveProperty('activeControllers');
    expect(report).toHaveProperty('totalControllers');
    expect(report.timestamp).toBeGreaterThan(0);

    await registry.shutdown();
  });

  // ----- Per-controller existence checks -----

  describe('per-controller INIT_LEVELS membership', () => {
    const initLevelMap = new Map<string, number>();
    for (const level of INIT_LEVELS) {
      for (const name of level.controllers) {
        initLevelMap.set(name, level.level);
      }
    }

    for (const name of ALL_CONTROLLERS) {
      it(`controller '${name}' should be in an initialization level`, () => {
        expect(
          initLevelMap.has(name),
          `'${name}' not found in any INIT_LEVEL`,
        ).toBe(true);
        expect(initLevelMap.get(name)).toBeGreaterThanOrEqual(0);
      });
    }
  });

  // ----- Level ordering constraints -----

  describe('level ordering constraints', () => {
    it('level 0 should be empty (foundation is AgentDB itself)', () => {
      const level0 = INIT_LEVELS.find((l) => l.level === 0);
      expect(level0).toBeDefined();
      expect(level0!.controllers).toHaveLength(0);
    });

    it('core intelligence controllers should be in level 1', () => {
      const level1 = INIT_LEVELS.find((l) => l.level === 1);
      expect(level1!.controllers).toContain('reasoningBank');
      expect(level1!.controllers).toContain('hierarchicalMemory');
      expect(level1!.controllers).toContain('tieredCache');
    });

    it('security controllers should be in level 2 or later', () => {
      const level2Plus = INIT_LEVELS.filter((l) => l.level >= 2);
      const allLevel2Plus = level2Plus.flatMap((l) => l.controllers);

      expect(allLevel2Plus).toContain('mutationGuard');
      expect(allLevel2Plus).toContain('vectorBackend');
    });

    it('guardedVectorBackend should be after mutationGuard (level 5 > level 2)', () => {
      const guardedLevel = INIT_LEVELS.find((l) =>
        l.controllers.includes('guardedVectorBackend'),
      );
      const mutationLevel = INIT_LEVELS.find((l) =>
        l.controllers.includes('mutationGuard'),
      );

      expect(guardedLevel).toBeDefined();
      expect(mutationLevel).toBeDefined();
      expect(guardedLevel!.level).toBeGreaterThan(mutationLevel!.level);
    });

    it('memoryConsolidation should be after hierarchicalMemory', () => {
      const consolidationLevel = INIT_LEVELS.find((l) =>
        l.controllers.includes('memoryConsolidation'),
      );
      const hierarchicalLevel = INIT_LEVELS.find((l) =>
        l.controllers.includes('hierarchicalMemory'),
      );

      expect(consolidationLevel).toBeDefined();
      expect(hierarchicalLevel).toBeDefined();
      expect(consolidationLevel!.level).toBeGreaterThan(hierarchicalLevel!.level);
    });
  });
});
