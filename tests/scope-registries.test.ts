import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadNpmrc } from '../src/files/npmrc.js';
import { loadPnpmWorkspace } from '../src/files/pnpm-workspace.js';
import { readScopeRegistries } from '../src/registry/scope-registries.js';

const JSR = ['@jsr', { url: 'https://npm.jsr.io/', source: 'pnpm built-in' }];

async function load(files: { npmrc?: string; workspaceYaml?: string }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'prune-test-'));
  if (files.npmrc !== undefined) await writeFile(path.join(dir, '.npmrc'), files.npmrc);
  if (files.workspaceYaml !== undefined) {
    await writeFile(path.join(dir, 'pnpm-workspace.yaml'), files.workspaceYaml);
  }
  return readScopeRegistries(await loadNpmrc(dir), await loadPnpmWorkspace(dir));
}

describe('readScopeRegistries', () => {
  it("returns only pnpm's built-in @jsr route when neither file configures any", async () => {
    expect([...(await load({}))]).toEqual([JSR]);
    expect([
      ...(await load({ npmrc: 'save-exact=true\n', workspaceYaml: 'packages: []\n' })),
    ]).toEqual([JSR]);
  });

  it('reads @scope:registry from .npmrc and nothing else', async () => {
    const routes = await load({
      npmrc: [
        'registry=https://mirror.example/',
        '# @commented:registry=https://commented.example/',
        '@octo-org:registry = https://npm.octo-org.example/',
        '//npm.octo-org.example/:always-auth=true',
        'save-exact=true',
      ].join('\n'),
    });

    expect([...routes]).toEqual([
      JSR,
      ['@octo-org', { url: 'https://npm.octo-org.example/', source: 'set in .npmrc' }],
    ]);
  });

  it('ignores a .npmrc route with an env placeholder, as pnpm 11 does', async () => {
    const routes = await load({ npmrc: '@octo-org:registry=${OCTO_REGISTRY}\n' });

    expect([...routes]).toEqual([JSR]);
  });

  it('reads the scope-keyed registries map from pnpm-workspace.yaml', async () => {
    const routes = await load({
      workspaceYaml: [
        'registries:',
        '  default: https://mirror.example/',
        "  '@octo-org': https://npm.octo-org.example/",
      ].join('\n'),
    });

    expect([...routes]).toEqual([
      JSR,
      ['@octo-org', { url: 'https://npm.octo-org.example/', source: 'set in pnpm-workspace.yaml' }],
    ]);
  });

  it('reads the url-keyed registries map from pnpm-workspace.yaml', async () => {
    const routes = await load({
      workspaceYaml: [
        'registries:',
        '  https://npm.octo-org.example/:',
        '    serverType: artifactory',
        "    scopes: ['@octo-org', '@octo-tools']",
        '  https://mirror.example/:',
        "    scopes: ['@']",
        '  https://described-only.example/:',
        '    supportsTimeField: true',
      ].join('\n'),
    });

    const source = 'set in pnpm-workspace.yaml';
    expect([...routes]).toEqual([
      JSR,
      ['@octo-org', { url: 'https://npm.octo-org.example/', source }],
      ['@octo-tools', { url: 'https://npm.octo-org.example/', source }],
    ]);
  });

  it('ranks pnpm-workspace.yaml over .npmrc, and both over the built-in route', async () => {
    const routes = await load({
      npmrc: [
        '@octo-org:registry=https://old.octo-org.example/',
        '@jsr:registry=https://jsr-mirror.example/',
      ].join('\n'),
      workspaceYaml: "registries:\n  '@octo-org': https://npm.octo-org.example/\n",
    });

    expect(routes.get('@octo-org')).toEqual({
      url: 'https://npm.octo-org.example/',
      source: 'set in pnpm-workspace.yaml',
    });
    expect(routes.get('@jsr')).toEqual({
      url: 'https://jsr-mirror.example/',
      source: 'set in .npmrc',
    });
  });
});
