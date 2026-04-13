/**
 * controller-intercept.ts — Module-level singleton pool (ADR-0076 Phase 4)
 *
 * Prevents dual controller construction. All callers use getOrCreate()
 * instead of direct construction — first caller wins, second gets the
 * existing instance.
 *
 * ADR-0085: AgentDBService reference removed — no such class exists.
 * ControllerRegistry (bootstrapped by memory-router) is the sole registrar.
 *
 * @module @claude-flow/memory/controller-intercept
 */
/**
 * Get an existing controller instance or create one.
 * First caller's factory wins; subsequent calls return the cached instance.
 */
export declare function getOrCreate<T>(name: string, factory: () => T): T;
/**
 * Get an existing controller instance without creating one.
 * Returns undefined if the controller hasn't been created yet.
 */
export declare function getExisting<T>(name: string): T | undefined;
/**
 * Check if a controller instance exists in the pool.
 */
export declare function has(name: string): boolean;
/**
 * Get all registered controller names.
 */
export declare function listControllers(): string[];
/**
 * Get the total number of registered controllers.
 */
export declare function controllerCount(): number;
/**
 * Reset the singleton pool (for testing only).
 */
export declare function resetInterceptPool(): void;
//# sourceMappingURL=controller-intercept.d.ts.map