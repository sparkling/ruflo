/**
 * controller-intercept.ts — Module-level singleton pool (ADR-0076 Phase 4)
 *
 * Prevents dual controller construction between ControllerRegistry and
 * AgentDBService. Both registries call getOrCreate() instead of direct
 * construction — first caller wins, second gets the existing instance.
 *
 * This solves the cache-divergence problem where two separate AgentDB
 * objects each maintain their own controller pools with different
 * in-memory state.
 *
 * @module @claude-flow/memory/controller-intercept
 */

const _instances = new Map<string, unknown>();

/**
 * Get an existing controller instance or create one.
 * First caller's factory wins; subsequent calls return the cached instance.
 */
export function getOrCreate<T>(name: string, factory: () => T): T {
  if (_instances.has(name)) return _instances.get(name) as T;
  const inst = factory();
  _instances.set(name, inst);
  return inst;
}

/**
 * Get an existing controller instance without creating one.
 * Returns undefined if the controller hasn't been created yet.
 */
export function getExisting<T>(name: string): T | undefined {
  return _instances.get(name) as T | undefined;
}

/**
 * Check if a controller instance exists in the pool.
 */
export function has(name: string): boolean {
  return _instances.has(name);
}

/**
 * Get all registered controller names.
 */
export function listControllers(): string[] {
  return [..._instances.keys()];
}

/**
 * Get the total number of registered controllers.
 */
export function controllerCount(): number {
  return _instances.size;
}

/**
 * Reset the singleton pool (for testing only).
 */
export function resetInterceptPool(): void {
  _instances.clear();
}
