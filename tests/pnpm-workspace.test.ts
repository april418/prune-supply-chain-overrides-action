import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadPnpmWorkspace,
  savePnpmWorkspace,
  readSequenceKeys,
  removeFromSequence,
  readMapEntries,
  removeFromMap,
  isCollectionEmpty,
  removeKey,
} from '../src/files/pnpm-workspace.js';

async function withTempProject(content: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'prune-test-'));
  await writeFile(path.join(dir, 'pnpm-workspace.yaml'), content, 'utf8');
  return dir;
}

const FIXTURE = `# サプライチェーン攻撃対策
onlyBuiltDependencies: []

minimumReleaseAge: 10080
minimumReleaseAgeExclude:
  # fast-uri の説明コメント
  - fast-uri
  - next
  - '@next/env'

overrides:
  fast-uri: '>=3.1.2'
  some-other: '^1.0.0'

trustPolicy: no-downgrade
trustPolicyIgnoreAfter: 10080
`;

describe('pnpm-workspace.yaml IO', () => {
  it('loads scalar settings', async () => {
    const cwd = await withTempProject(FIXTURE);
    const data = await loadPnpmWorkspace(cwd);
    expect(data).not.toBeNull();
    expect(data!.minimumReleaseAge).toBe(10080);
    expect(data!.trustPolicyIgnoreAfter).toBe(10080);
  });

  it('returns null when file is missing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'prune-test-'));
    expect(await loadPnpmWorkspace(dir)).toBeNull();
  });

  it('reads sequence keys', async () => {
    const cwd = await withTempProject(FIXTURE);
    const data = await loadPnpmWorkspace(cwd);
    const keys = readSequenceKeys(data!.document, 'minimumReleaseAgeExclude').map((e) => e.value);
    expect(keys).toEqual(['fast-uri', 'next', '@next/env']);
  });

  it('reads map entries', async () => {
    const cwd = await withTempProject(FIXTURE);
    const data = await loadPnpmWorkspace(cwd);
    const entries = readMapEntries(data!.document, 'overrides');
    expect(entries).toEqual([
      { key: 'fast-uri', value: '>=3.1.2' },
      { key: 'some-other', value: '^1.0.0' },
    ]);
  });

  it('removes sequence values and preserves surrounding comments', async () => {
    const cwd = await withTempProject(FIXTURE);
    const data = await loadPnpmWorkspace(cwd);
    removeFromSequence(data!.document, 'minimumReleaseAgeExclude', ['next']);
    await savePnpmWorkspace(data!);
    const after = await readFile(path.join(cwd, 'pnpm-workspace.yaml'), 'utf8');
    expect(after).toContain('# サプライチェーン攻撃対策');
    expect(after).toContain('# fast-uri の説明コメント');
    expect(after).toContain('- fast-uri');
    expect(after).toContain("- '@next/env'");
    expect(after).not.toMatch(/^\s+- next\s*$/m);
  });

  it('removes map keys', async () => {
    const cwd = await withTempProject(FIXTURE);
    const data = await loadPnpmWorkspace(cwd);
    removeFromMap(data!.document, 'overrides', ['fast-uri']);
    await savePnpmWorkspace(data!);
    const after = await readFile(path.join(cwd, 'pnpm-workspace.yaml'), 'utf8');
    expect(after).not.toContain('fast-uri:');
    expect(after).toContain("some-other: '^1.0.0'");
  });

  it('detects empty collections after removal', async () => {
    const cwd = await withTempProject(`overrides:\n  fast-uri: '>=3.1.2'\n`);
    const data = await loadPnpmWorkspace(cwd);
    removeFromMap(data!.document, 'overrides', ['fast-uri']);
    expect(isCollectionEmpty(data!.document, 'overrides')).toBe(true);
    removeKey(data!.document, 'overrides');
    await savePnpmWorkspace(data!);
    const after = await readFile(path.join(cwd, 'pnpm-workspace.yaml'), 'utf8');
    expect(after).not.toContain('overrides');
  });
});
