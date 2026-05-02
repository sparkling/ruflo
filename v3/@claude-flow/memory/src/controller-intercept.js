"use strict";
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
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetInterceptPool = exports.controllerCount = exports.listControllers = exports.has = exports.getExisting = exports.getOrCreate = void 0;
var _instances = new Map();
/**
 * Get an existing controller instance or create one.
 * First caller's factory wins; subsequent calls return the cached instance.
 */
function getOrCreate(name, factory) {
    if (_instances.has(name))
        return _instances.get(name);
    var inst = factory();
    _instances.set(name, inst);
    return inst;
}
exports.getOrCreate = getOrCreate;
/**
 * Get an existing controller instance without creating one.
 * Returns undefined if the controller hasn't been created yet.
 */
function getExisting(name) {
    return _instances.get(name);
}
exports.getExisting = getExisting;
/**
 * Check if a controller instance exists in the pool.
 */
function has(name) {
    return _instances.has(name);
}
exports.has = has;
/**
 * Get all registered controller names.
 */
function listControllers() {
    return __spreadArray([], _instances.keys(), true);
}
exports.listControllers = listControllers;
/**
 * Get the total number of registered controllers.
 */
function controllerCount() {
    return _instances.size;
}
exports.controllerCount = controllerCount;
/**
 * Reset the singleton pool (for testing only).
 */
function resetInterceptPool() {
    _instances.clear();
}
exports.resetInterceptPool = resetInterceptPool;
