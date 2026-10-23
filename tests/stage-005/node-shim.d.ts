/**
 * node-shim.d.ts — AUDIT SCAFFOLDING ONLY (Stage 005).
 *
 * This host has no @types/node, so the repo-pinned tsc cannot resolve the
 * 'node:crypto' import in the verified Stage 002 wrapper or the setImmediate
 * global used by services/dispatchRouter.ts (plan §3.2 verbatim). These
 * ambient declarations let the audit transpile the REAL sources unchanged.
 * Production (Ride backend, Node with @types/node) is unaffected: ambient
 * global `setImmediate` merging matches Node's own signature shape, and the
 * module shim only applies to this tsc invocation's program.
 */
declare module 'node:crypto' {
  export function randomUUID(): string;
  export interface Hash {
    update(s: string): Hash;
    digest(enc: string): string;
  }
  export function createHash(algo: string): Hash;
}
declare function setImmediate(callback: () => void): unknown;
