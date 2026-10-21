import { parse as parseIni } from 'ini';
import { isMap } from 'yaml';
import type { NpmrcData } from '../files/npmrc.js';
import type { PnpmWorkspaceData } from '../files/pnpm-workspace.js';

/** The registry a project installs one `@scope` from. */
export interface ScopeRegistry {
  url: string;
  source: 'set in .npmrc' | 'set in pnpm-workspace.yaml' | 'pnpm built-in';
}

/**
 * Registry per `@scope` as the project configures it, in pnpm's precedence:
 * pnpm's built-in `@jsr` route, then `@scope:registry=` in .npmrc, then
 * `registries` in pnpm-workspace.yaml. User-level config such as ~/.npmrc is
 * not read, and routes for the default registry are ignored.
 */
export function readScopeRegistries(
  npmrc: NpmrcData | null,
  workspace: PnpmWorkspaceData | null,
): Map<string, ScopeRegistry> {
  const routes = new Map<string, ScopeRegistry>([
    ['@jsr', { url: 'https://npm.jsr.io/', source: 'pnpm built-in' }],
  ]);
  if (npmrc) {
    for (const [key, value] of Object.entries(parseIni(npmrc.raw))) {
      const scope = /^(@[^:]+):registry$/.exec(key)?.[1];
      // pnpm 11 drops a project .npmrc registry URL with an env placeholder
      // and installs from the default registry instead.
      if (scope !== undefined && typeof value === 'string' && !/\$\{[^}]+\}/.test(value)) {
        routes.set(scope, { url: value, source: 'set in .npmrc' });
      }
    }
  }
  const node = workspace?.document.get('registries', true);
  if (workspace && isMap(node)) {
    // Only this node is converted: the whole document may hold aliases that
    // yaml's alias-count limit rejects, which would fail the run for nothing.
    for (const [scope, url] of workspaceRoutes(node.toJS(workspace.document))) {
      routes.set(scope, { url, source: 'set in pnpm-workspace.yaml' });
    }
  }
  return routes;
}

/**
 * pnpm accepts two shapes for `registries`: `{ '@scope': url }`, and since
 * v11.23 `{ [url]: { scopes: ['@scope'] } }`. Each entry is read by its own
 * shape, since pnpm rejects a map that mixes them anyway.
 */
function* workspaceRoutes(registries: unknown): Generator<[scope: string, url: string]> {
  if (!isRecord(registries)) return;
  for (const [key, value] of Object.entries(registries)) {
    if (typeof value === 'string') {
      if (isScope(key)) yield [key, value];
    } else if (isRecord(value) && Array.isArray(value.scopes)) {
      for (const scope of value.scopes) {
        if (typeof scope === 'string' && isScope(scope)) yield [scope, key];
      }
    }
  }
}

/** `@` alone names the default registry in `scopes`, and no package's scope elsewhere. */
function isScope(value: string): boolean {
  return value.startsWith('@') && value.length > 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
