import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandLine } from '../src/transports/process.ts';
import { readTree, treeScript } from '../src/core/files-tree.ts';
import type { FsBox } from '../src/core/box-fs.ts';

const box: FsBox = { id: 'bx_tree', os: 'linux', state: 'ready', command: true, device: false };
const installed = (shell: string) => shell === 'busybox' ? existsSync('/usr/bin/busybox') : spawnSync('sh', ['-c', `command -v ${shell}`]).status === 0;

for (const shell of ['sh', 'dash', 'busybox']) test(`${shell} draws home in one call and expands only one level`, { skip: installed(shell) ? false : `${shell} is not installed here` }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'files-tree-'));
  const scratch = mkdtempSync(join(tmpdir(), 'files-tree-scratch-'));
  try {
    mkdirSync(join(root, 'folder', 'nested'), { recursive: true });
    mkdirSync(join(root, '.cache'));
    writeFileSync(join(root, '.cache', 'hidden'), '');
    writeFileSync(join(root, 'folder', 'one'), '');
    writeFileSync(join(root, 'folder', 'nested', 'deep'), '');
    writeFileSync(join(root, 'tab\tname'), '');
    for (const name of ['DONE', 'ERR', 'TRUNC', 'back\\slash']) writeFileSync(join(root, name), '');
    writeFileSync(join(root, 'line\nbreak'), '');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    if (shell === 'busybox') for (const command of ['find', 'stat', 'awk', 'mktemp', 'mkfifo', 'rm', 'rmdir']) symlinkSync('/usr/bin/busybox', join(bin, command));
    const runner = new CommandLine({ argv: (script) => shell === 'busybox' ? ['/usr/bin/busybox', 'sh', '-c', script] : [shell, '-c', script], env: { ...process.env, HOME: root, TMPDIR: scratch, PATH: shell === 'busybox' ? bin : process.env.PATH } });
    let calls = 0;
    const run = (script: string, options: Parameters<CommandLine['run']>[1]) => { calls++; return runner.run(script, options); };
    const first = await readTree(box, null, false, false, run);
    assert.equal(calls, 1);
    assert.equal(first.error, null);
    if (first.error !== null) return;
    assert.equal(first.path, root);
    assert.deepEqual(first.directories.sort(), ['bin', 'folder']);
    assert.deepEqual(first.paths.sort(), ['DONE', 'ERR', 'TRUNC', 'back\\slash', 'tab\tname'].sort());
    const expanded = await readTree(box, join(root, 'folder'), false, false, run);
    assert.equal(expanded.error, null);
    if (expanded.error !== null) return;
    assert.deepEqual(expanded.paths, ['one']);
    assert.deepEqual(expanded.directories, ['nested']);
    const visible = await readTree(box, root, true, false, run);
    assert.equal(visible.error, null);
    if (visible.error !== null) return;
    assert.ok(visible.paths.includes('folder/nested/deep'));
    assert.ok(!visible.paths.some((path) => path.startsWith('.cache/')));
    const hidden = await readTree(box, root, true, true, run);
    assert.equal(hidden.error, null);
    if (hidden.error !== null) return;
    assert.ok(hidden.paths.includes('.cache/hidden'));
    assert.deepEqual(readdirSync(scratch), []);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }); }
});
test('incomplete output is refused', async () => {
  const result = await readTree(box, '/tmp', false, false, async () => ({ exitCode: 0, stdout: 'ROOT\0/tmp\0f\0one\0', stderr: '', timedOut: false, truncated: false }));
  assert.notEqual(result.error, null);
});
test('Windows enumeration prunes hidden folders before queuing children', () => {
  const script = treeScript('windows', null, true, false);
  assert.ok(script.includes('Stack[string]'));
  assert.ok(script.includes('$item.Name.StartsWith'));
  assert.ok(!script.includes('-Recurse'));
});

test('partial walks keep valid records and timeouts say to retry', async () => {
  const partial = await readTree(box, '/tmp', true, false, async () => ({exitCode:0,stdout:'ROOT\0/tmp\0f\0readable\0PARTIAL\0DONE\0',stderr:'',timedOut:false,truncated:false}));
  assert.equal(partial.error, null);
  if (partial.error === null) { assert.equal(partial.partial, true); assert.deepEqual(partial.paths, ['readable']); }
  const timeout = await readTree(box, '/tmp', true, false, async () => ({exitCode:124,stdout:'ROOT\0/tmp\0',stderr:'',timedOut:false,truncated:false}));
  assert.equal(timeout.error, 'The box took too long. Try again.');
});
