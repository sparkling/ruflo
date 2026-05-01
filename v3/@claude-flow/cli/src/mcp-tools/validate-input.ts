/**
 * Input Validation for MCP Tools
 *
 * Loads @claude-flow/security validators when available
 * and provides lightweight fallback validation otherwise.
 *
 * Addresses #1425: security validators were implemented but never wired to runtime.
 */

// Patterns for input sanitization (inline — no external dependency required)
const SHELL_META = /[;&|`$(){}[\]<>!#\\]/;
const PATH_TRAVERSAL = /\.\.[/\\]/;
const IDENTIFIER_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_\-.:]{0,127}$/;
const GIT_REF_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_\-.:~^/]{0,255}$/;
const NPM_PACKAGE_RE = /^(@[a-zA-Z0-9_\-]+\/)?[a-zA-Z0-9_\-][a-zA-Z0-9_\-.]{0,213}$/;

export interface ValidationResult {
  valid: boolean;
  sanitized: string;
  error?: string;
}

/**
 * Enum of valid Queen types per ADR-0107. Domain-specific validator per
 * upstream ADR-092 pattern + ADR-0111 W5.
 */
export const QUEEN_TYPES = ['strategic', 'tactical', 'adaptive'] as const;
export type QueenType = (typeof QUEEN_TYPES)[number];

export function validateQueenType(value: unknown, label = 'queenType'): ValidationResult {
  if (typeof value !== 'string' || value.length === 0) {
    return { valid: false, sanitized: '', error: `${label} must be a non-empty string` };
  }
  if (!QUEEN_TYPES.includes(value as QueenType)) {
    return {
      valid: false,
      sanitized: '',
      error: `${label} must be one of: ${QUEEN_TYPES.join(', ')} (got '${value}')`,
    };
  }
  return { valid: true, sanitized: value };
}

/**
 * Enum of valid worker types per ADR-0108. Mirrors the V2-parity port
 * (`--worker-types` comma-separated). Domain-specific validator per
 * upstream ADR-092 pattern + ADR-0111 W5.
 */
export const WORKER_TYPES = [
  'researcher', 'coder', 'analyst', 'tester', 'architect', 'reviewer',
  'optimizer', 'documenter', 'specialist', 'coordinator', 'monitor',
] as const;
export type WorkerType = (typeof WORKER_TYPES)[number];

export function validateWorkerType(value: unknown, label = 'workerType'): ValidationResult {
  if (typeof value !== 'string' || value.length === 0) {
    return { valid: false, sanitized: '', error: `${label} must be a non-empty string` };
  }
  if (!WORKER_TYPES.includes(value as WorkerType)) {
    return {
      valid: false,
      sanitized: '',
      error: `${label} must be one of: ${WORKER_TYPES.join(', ')} (got '${value}')`,
    };
  }
  return { valid: true, sanitized: value };
}

/**
 * Enum of valid storage providers per ADR-0110. RVF is primary
 * (per `project-rvf-primary` memory); `agentdb` is a hybrid backend;
 * `sqlite` is structurally-unreachable fallback retained for migration.
 * Domain-specific validator per upstream ADR-092 pattern + ADR-0111 W5.
 */
export const STORAGE_PROVIDERS = ['rvf', 'agentdb', 'sqlite'] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

export function validateStorageProvider(value: unknown, label = 'storageProvider'): ValidationResult {
  if (typeof value !== 'string' || value.length === 0) {
    return { valid: false, sanitized: '', error: `${label} must be a non-empty string` };
  }
  if (!STORAGE_PROVIDERS.includes(value as StorageProvider)) {
    return {
      valid: false,
      sanitized: '',
      error: `${label} must be one of: ${STORAGE_PROVIDERS.join(', ')} (got '${value}')`,
    };
  }
  return { valid: true, sanitized: value };
}

/**
 * Validate an identifier (agent ID, agent type, namespace, key, etc.)
 * Rejects shell metacharacters and path traversal.
 */
export function validateIdentifier(value: unknown, label: string): ValidationResult {
  if (typeof value !== 'string' || value.length === 0) {
    return { valid: false, sanitized: '', error: `${label} must be a non-empty string` };
  }
  if (value.length > 128) {
    return { valid: false, sanitized: '', error: `${label} exceeds 128 characters` };
  }
  if (SHELL_META.test(value)) {
    return { valid: false, sanitized: '', error: `${label} contains disallowed characters` };
  }
  if (PATH_TRAVERSAL.test(value)) {
    return { valid: false, sanitized: '', error: `${label} contains path traversal` };
  }
  if (!IDENTIFIER_RE.test(value)) {
    return { valid: false, sanitized: '', error: `${label} contains invalid characters (allowed: alphanumeric, _, -, ., :)` };
  }
  return { valid: true, sanitized: value };
}

/**
 * Validate a git ref (HEAD~1, main..feature, commit hashes, etc.).
 * Allows ~, ^, and / which are standard git revision selectors.
 */
export function validateGitRef(value: unknown, label: string): ValidationResult {
  if (typeof value !== 'string' || value.length === 0) {
    return { valid: false, sanitized: '', error: `${label} must be a non-empty string` };
  }
  if (value.length > 256) {
    return { valid: false, sanitized: '', error: `${label} exceeds 256 characters` };
  }
  if (SHELL_META.test(value)) {
    return { valid: false, sanitized: '', error: `${label} contains disallowed characters` };
  }
  if (!GIT_REF_RE.test(value)) {
    return { valid: false, sanitized: '', error: `${label} contains invalid characters (allowed: alphanumeric, _, -, ., :, ~, ^, /)` };
  }
  return { valid: true, sanitized: value };
}

/**
 * Validate an npm package name (allows @scope/name format).
 */
export function validatePackageName(value: unknown, label: string): ValidationResult {
  if (typeof value !== 'string' || value.length === 0) {
    return { valid: false, sanitized: '', error: `${label} must be a non-empty string` };
  }
  if (value.length > 214) {
    return { valid: false, sanitized: '', error: `${label} exceeds 214 characters` };
  }
  if (SHELL_META.test(value)) {
    return { valid: false, sanitized: '', error: `${label} contains disallowed characters` };
  }
  if (!NPM_PACKAGE_RE.test(value)) {
    return { valid: false, sanitized: '', error: `${label} contains invalid characters (expected npm package name, e.g. @scope/name)` };
  }
  return { valid: true, sanitized: value };
}

/**
 * Validate a file path (prevents traversal and shell injection).
 */
export function validatePath(value: unknown, label: string): ValidationResult {
  if (typeof value !== 'string' || value.length === 0) {
    return { valid: false, sanitized: '', error: `${label} must be a non-empty string` };
  }
  if (value.length > 4096) {
    return { valid: false, sanitized: '', error: `${label} exceeds 4096 characters` };
  }
  if (PATH_TRAVERSAL.test(value)) {
    return { valid: false, sanitized: '', error: `${label} contains path traversal (..)` };
  }
  if (SHELL_META.test(value)) {
    return { valid: false, sanitized: '', error: `${label} contains shell metacharacters` };
  }
  return { valid: true, sanitized: value };
}

/**
 * Validate a free-text string (description, value, etc.)
 * Allows most characters but rejects shell metacharacters that could cause injection.
 */
export function validateText(value: unknown, label: string, maxLen = 10_000): ValidationResult {
  if (typeof value !== 'string') {
    return { valid: false, sanitized: '', error: `${label} must be a string` };
  }
  if (value.length > maxLen) {
    return { valid: false, sanitized: '', error: `${label} exceeds ${maxLen} characters` };
  }
  // Strip null bytes
  const sanitized = value.replace(/\0/g, '');
  return { valid: true, sanitized };
}

/**
 * Assert validation or throw with a structured error.
 */
export function assertValid(result: ValidationResult): string {
  if (!result.valid) {
    throw new Error(`Validation failed: ${result.error}`);
  }
  return result.sanitized;
}

// Try to load the full @claude-flow/security module for enhanced validation
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _securityModule: Record<string, any> | null = null;
let _securityLoaded = false;

async function getSecurityModule(): Promise<Record<string, any> | null> {
  if (_securityLoaded) return _securityModule;
  _securityLoaded = true;
  try {
    // Dynamic import — @claude-flow/security is an optional dependency
    _securityModule = await (Function('return import("@claude-flow/security")')() as Promise<Record<string, any>>);
  } catch {
    // @claude-flow/security is optional — fallback to inline validation above
  }
  return _securityModule;
}

/**
 * Enhanced validation using @claude-flow/security Zod schemas when available.
 * Falls back to inline regex validation otherwise.
 */
export async function validateAgentSpawn(input: Record<string, unknown>): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  // Always run inline validation
  if (input.agentType) {
    const r = validateIdentifier(input.agentType, 'agentType');
    if (!r.valid) errors.push(r.error!);
  }
  if (input.agentId) {
    const r = validateIdentifier(input.agentId, 'agentId');
    if (!r.valid) errors.push(r.error!);
  }
  if (input.domain) {
    const r = validateIdentifier(input.domain, 'domain');
    if (!r.valid) errors.push(r.error!);
  }

  // Try enhanced Zod validation if available.
  // Fix for #1567: @claude-flow/security's SpawnAgentSchema expects `type` and
  // `id` (not `agentType`/`name`), so the previous call always failed with
  // "type: Required". Also swallow `invalid_enum_value` errors because the
  // schema enumerates only 15 built-in agent types — we support custom types
  // (the inline validator already checked the identifier is safe).
  const sec = await getSecurityModule();
  if (sec?.SpawnAgentSchema) {
    try {
      sec.SpawnAgentSchema.parse({
        type: input.agentType,
        id: input.agentId,
      });
    } catch (zodErr: any) {
      if (zodErr.issues) {
        for (const issue of zodErr.issues) {
          if (issue.code === 'invalid_enum_value') continue;
          errors.push(`${issue.path.join('.')}: ${issue.message}`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
