/**
 * Debug logging utilities for development and production.
 * Console logging is disabled in production builds.
 */

const DEBUG = import.meta.env.DEV;

/**
 * Log debug messages - only outputs in development mode
 */
export function log(...args: unknown[]): void {
  if (DEBUG) {
    console.log(...args);
  }
}

/**
 * Log warning messages - outputs in both dev and production
 */
export function warn(...args: unknown[]): void {
  if (DEBUG) {
    console.warn(...args);
  } else {
    // In production, still log warnings but without dev-only context
    console.warn(...args);
  }
}

/**
 * Log error messages - always outputs
 */
export function error(...args: unknown[]): void {
  console.error(...args);
}

/**
 * Log debug messages with timestamp - useful for performance tracing
 */
export function logTime(label: string): () => void {
  if (!DEBUG) {
    return () => {};
  }

  console.time(label);
  return () => {
    console.timeEnd(label);
  };
}

/**
 * Log group for organizing related debug output
 */
export function logGroup(label: string, fn: () => void): void {
  if (DEBUG) {
    console.group(label);
    fn();
    console.groupEnd();
  }
}

/**
 * Conditional log - only logs if condition is true
 */
export function logIf(condition: boolean, ...args: unknown[]): void {
  if (DEBUG && condition) {
    console.log(...args);
  }
}