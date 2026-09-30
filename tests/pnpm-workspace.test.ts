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

describe('comments around removed entries', () => {
  async function prune(
    content: string,
    edit: (doc: NonNullable<Awaited<ReturnType<typeof loadPnpmWorkspace>>>['document']) => void,
  ): Promise<string> {
    const cwd = await withTempProject(content);
    const data = await loadPnpmWorkspace(cwd);
    edit(data!.document);
    await savePnpmWorkspace(data!);
    return readFile(path.join(cwd, 'pnpm-workspace.yaml'), 'utf8');
  }

  it('moves a section header separated by a blank line to the next top-level key', async () => {
    const after = await prune(
      `packages:
  - 'apps/*'

# ==== supply chain ====
# section text

# allow sharp's build script
onlyBuiltDependencies:
  - sharp

# age comment
minimumReleaseAge: 10080
`,
      (doc) => removeKey(doc, 'onlyBuiltDependencies'),
    );
    expect(after).toBe(`packages:
  - 'apps/*'

# ==== supply chain ====
# section text

# age comment
minimumReleaseAge: 10080
`);
  });

  it('keeps a group comment for the next entry of the same package', async () => {
    const after = await prune(
      `overrides:
  # --- tmp ---
  # detail
  tmp@<=0.2.3: '>=0.2.4'
  tmp@<0.2.6: '>=0.2.6'
`,
      (doc) => removeFromMap(doc, 'overrides', ['tmp@<=0.2.3'], overridePackage),
    );
    expect(after).toBe(`overrides:
  # --- tmp ---
  # detail
  tmp@<0.2.6: '>=0.2.6'
`);
  });

  it('drops a comment that only described removed entries', async () => {
    const after = await prune(
      `overrides:
  # --- tmp ---
  tmp@<=0.2.3: '>=0.2.4'
  tmp@<0.2.6: '>=0.2.6'

  # --- sharp ---
  sharp@<1.0.0: '^1.0.0'
`,
      (doc) => removeFromMap(doc, 'overrides', ['tmp@<=0.2.3', 'tmp@<0.2.6'], overridePackage),
    );
    expect(after).toBe(`overrides:
  # --- sharp ---
  sharp@<1.0.0: '^1.0.0'
`);
  });

  it('does not hand a comment to an entry that has its own', async () => {
    const after = await prune(
      `overrides:
  foo@<1.0.0: '^1.0.0'
  # 2.x needs its own fix
  foo@>=2.0.0 <2.1.0: '^2.1.0'
  # 5.x has a different advisory
  foo@>=5.0.0 <5.0.9: '^5.0.9'
`,
      (doc) => removeFromMap(doc, 'overrides', ['foo@>=2.0.0 <2.1.0'], overridePackage),
    );
    expect(after).toBe(`overrides:
  foo@<1.0.0: '^1.0.0'
  # 5.x has a different advisory
  foo@>=5.0.0 <5.0.9: '^5.0.9'
`);
  });

  it('keeps blank-line-separated paragraphs of a removed last sequence item', async () => {
    const after = await prune(
      `minimumReleaseAgeExclude:
  - undici

  # everything below is temporary

  # nanoid fix is too new
  - nanoid
minimumReleaseAge: 10080
`,
      (doc) => removeFromSequence(doc, 'minimumReleaseAgeExclude', ['nanoid']),
    );
    expect(after).toContain('# everything below is temporary');
    expect(after).not.toContain('nanoid');
  });
});

describe('comments around removed entries (edge cases)', () => {
  async function prune(
    content: string,
    edit: (doc: NonNullable<Awaited<ReturnType<typeof loadPnpmWorkspace>>>['document']) => void,
  ): Promise<string> {
    const cwd = await withTempProject(content);
    const data = await loadPnpmWorkspace(cwd);
    edit(data!.document);
    await savePnpmWorkspace(data!);
    return readFile(path.join(cwd, 'pnpm-workspace.yaml'), 'utf8');
  }

  it('keeps a header that is separated by a blank line and has no own comment below it', async () => {
    const after = await prune('p: 1\n\n# H\n\na:\n  - x\nb: 1\n', (doc) => removeKey(doc, 'a'));
    expect(after).toBe('p: 1\n\n# H\n\nb: 1\n');
  });

  it('keeps a blank line between a carried header and the entry it lands on', async () => {
    const after = await prune('p: 1\n\n# H\n\n# own\na:\n  - x\nb: 1\n', (doc) =>
      removeKey(doc, 'a'),
    );
    expect(after).toBe('p: 1\n\n# H\n\nb: 1\n');
  });

  it('keeps a header in a CRLF file', async () => {
    const after = await prune('p: 1\r\n\r\n# H\r\n\r\n# own\r\na:\r\n  - x\r\nb: 1\r\n', (doc) =>
      removeKey(doc, 'a'),
    );
    expect(after).toContain('# H');
    expect(after).not.toContain('# own');
  });

  it('keeps a header inside a key whose items were all removed', async () => {
    const after = await prune('a:\n  - x\n\n  # inner H\n\n  # c2\n  - y\nb: 1\n', (doc) => {
      removeFromSequence(doc, 'a', ['x', 'y']);
      removeKey(doc, 'a');
    });
    expect(after).toContain('# inner H');
    expect(after).not.toContain('# c2');
  });

  it('keeps the blank line that separated a removed uncommented item', async () => {
    const after = await prune('a:\n  - k\n\n  - x\n  - y\n', (doc) =>
      removeFromSequence(doc, 'a', ['x']),
    );
    expect(after).toBe('a:\n  - k\n\n  - y\n');
  });
});

function overridePackage(key: string): string {
  const at = key.lastIndexOf('@');
  return at > 0 ? key.slice(0, at) : key;
}
