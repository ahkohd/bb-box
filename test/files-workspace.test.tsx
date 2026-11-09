import { z } from "zod";
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { clearWorkspaces } from '../src/app/files-ui/workspace-memory.ts';
import { Workspace } from '../src/app/files-ui/Workspace.tsx';
import type { FilesTree } from '../src/core/files-tree.ts';

vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
Element.prototype.scrollIntoView = () => {};
afterEach(() => { cleanup(); clearWorkspaces(); localStorage.clear(); });
const request = z.object({ path: z.string().nullable().optional(), recursive: z.boolean().optional(), refresh: z.boolean().optional() });
const tree = (path = '/home/box', paths: string[] = [], directories = ['src']): FilesTree => ({ error: null, path, paths, directories, truncated: false, partial: false, cached: false });
function deferred() {
  let resolve: (result: FilesTree) => void = () => {};
  const promise = new Promise<FilesTree>((done) => { resolve = done; });
  return { promise, resolve };
}
test('one RPC draws a shallow tree before background index and expansion survives delayed root refresh', async () => {
  const refresh = deferred();
  const index = deferred();
  const calls: string[] = [];
  renderSlot({ component: Workspace }, { threadId: 'thr_ui', boxId: 'bx_ui', os: 'linux' }, { rpc: {
    'files.tree': async (value: unknown) => {
      const input = request.parse(value);
      calls.push(input.recursive ? 'index' : input.path?.endsWith('/src') ? 'expand' : input.refresh ? 'refresh' : 'open');
      if (input.recursive) return index.promise;
      if (input.path?.endsWith('/src')) return tree(input.path, ['one.ts'], []);
      if (input.refresh) return refresh.promise;
      return { ...tree(), cached: true };
    },
  } });
  await screen.findByRole('treeitem', { name: 'src' });
  expect(calls[0]).toBe('open');
  fireEvent.click(screen.getByRole('treeitem', { name: 'src' }));
  await screen.findByRole('treeitem', { name: 'one.ts' });
  await act(async () => refresh.resolve(tree()));
  expect(screen.getByRole('treeitem', { name: 'one.ts' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Go to file by name' }));
  expect(screen.getByText('File names are still filling.')).toBeTruthy();
  await act(async () => index.resolve(tree('/home/box', ['src/one.ts'])));
  await waitFor(() => expect(screen.queryByText('File names are still filling.')).toBeNull());
});
test('wide layout puts the tree on the right and the mirrored toggle at breadcrumb end', async () => {
  const result = renderSlot({ component: Workspace }, { threadId: 'thr_ui', boxId: 'bx_ui', os: 'linux' }, { rpc: { 'files.tree': async () => tree() } });
  await screen.findByRole('treeitem', { name: 'src' });
  const resize = screen.getByRole('separator', { name: 'Resize the file explorer' });
  expect(resize.nextElementSibling?.querySelector('[role=tree]')).toBeTruthy();
  expect(resize.previousElementSibling?.querySelector('[aria-label="Hide the file explorer"]')).toBeTruthy();
  const toggle = screen.getByRole('button', { name: 'Hide the file explorer' });
  expect(toggle.parentElement?.lastElementChild).toBe(toggle);
  expect(toggle.querySelector('.rotate-180')).toBeTruthy();
  result.unmount();
});

test('navigation clears old quick-open names and pending folder skeletons', async () => {
  const folder = deferred();
  renderSlot({ component: Workspace }, { threadId: 'thr_ui', boxId: 'bx_ui', os: 'linux' }, { rpc: {
    'files.tree': async (value: unknown) => {
      const input = request.parse(value);
      if (input.path?.endsWith('/src')) return folder.promise;
      if (input.path === '/next') return input.recursive ? { error: 'Cannot read index.' } : tree('/next', [], ['other']);
      return input.recursive ? tree('/home/box', ['old.txt']) : tree();
    },
  } });
  await screen.findByRole('treeitem', { name: 'src' });
  fireEvent.click(screen.getByRole('treeitem', { name: 'src' }));
  await screen.findByRole('status', { name: 'Loading folder' });
  const path = screen.getByRole('textbox', { name: 'Path' });
  fireEvent.change(path, { target: { value: '/next' } });
  fireEvent.submit(path.closest('form')!);
  await screen.findByRole('treeitem', { name: 'other' });
  expect(screen.queryByRole('status', { name: 'Loading folder' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Go to file by name' }));
  await waitFor(() => expect(screen.queryByText('File names are still filling.')).toBeNull());
  expect(screen.queryByText('old.txt')).toBeNull();
  await act(async () => folder.resolve(tree('/home/box/src', ['late.ts'], [])));
  expect(screen.queryByText('late.ts')).toBeNull();
});

test('unreadable and invalid child paths keep the rest of the tree', async () => {
  const paths: (string | null | undefined)[] = [];
  renderSlot({ component: Workspace }, { threadId: 'thr_ui', boxId: 'bx_ui', os: 'linux' }, { rpc: {
    'files.tree': async (value: unknown) => {
      const input = request.parse(value);
      paths.push(input.path);
      return input.path?.endsWith('/denied') ? { error: 'That folder cannot be read.' } : tree('/home/box', ['kept.txt'], ['denied', 'back\\slash']);
    },
  } });
  await screen.findByRole('treeitem', { name: 'denied' });
  fireEvent.focus(screen.getByRole('treeitem', { name: 'denied' }));
  await act(async () => {});
  expect(screen.getByRole('treeitem', { name: 'kept.txt' })).toBeTruthy();
  const before = paths.filter((path) => path === null).length;
  fireEvent.click(screen.getByRole('treeitem', { name: 'back\\slash' }));
  await screen.findByText('That folder path cannot be opened.');
  expect(paths.filter((path) => path === null).length).toBe(before);
});

test('refresh rereads expanded branches and replaces their direct children', async () => {
  let version = 1;
  renderSlot({ component: Workspace }, { threadId: 'thr_ui', boxId: 'bx_ui', os: 'linux' }, { rpc: {
    'files.tree': async (value: unknown) => {
      const input = request.parse(value);
      return input.path?.endsWith('/src') ? tree('/home/box/src', [`file-${version}.ts`], []) : tree();
    },
  } });
  fireEvent.click(await screen.findByRole('treeitem', { name: 'src' }));
  await screen.findByRole('treeitem', { name: 'file-1.ts' });
  version = 2;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh files' }));
  await screen.findByRole('treeitem', { name: 'file-2.ts' });
  expect(screen.queryByRole('treeitem', { name: 'file-1.ts' })).toBeNull();
});

test('dotfile changes reload expanded folders and folder caps are shown', async () => {
  let reads = 0;
  renderSlot({ component: Workspace }, { threadId: 'thr_ui', boxId: 'bx_ui', os: 'linux' }, { rpc: {
    'files.tree': async (value: unknown) => {
      const input = request.parse(value);
      if (input.path?.endsWith('/src')) { reads++; return { ...tree('/home/box/src', ['one.ts'], []), truncated: true }; }
      return tree();
    },
  } });
  fireEvent.click(await screen.findByRole('treeitem', { name: 'src' }));
  await screen.findByRole('treeitem', { name: 'one.ts' });
  await screen.findByText('Showing the first 5,000 entries. Open a smaller folder to see more.');
  fireEvent.click(screen.getByRole('button', { name: 'Show dotfiles' }));
  await waitFor(() => expect(reads).toBeGreaterThan(1));
  expect(screen.getByRole('treeitem', { name: 'one.ts' })).toBeTruthy();
});

test('creation completing after navigation does not return to the old folder', async () => {
  let complete: (value: { error: null }) => void = () => {};
  const creation = new Promise<{ error: null }>((resolve) => { complete = resolve; });
  renderSlot({ component: Workspace }, { threadId: 'thr_ui', boxId: 'bx_ui', os: 'linux' }, { rpc: {
    'files.tree': async (value: unknown) => { const input = request.parse(value); return tree(input.path ?? '/home/box'); },
    'files.create': async () => creation,
  } });
  await screen.findByRole('treeitem', { name: 'src' });
  fireEvent.click(screen.getByLabelText('Create'));
  fireEvent.click(screen.getByRole('button', { name: 'New file' }));
  const name = screen.getByRole('textbox', { name: 'New file name' });
  fireEvent.change(name, { target: { value: 'created.txt' } });
  fireEvent.submit(name.closest('form')!);
  const path = screen.getByRole('textbox', { name: 'Path' });
  fireEvent.change(path, { target: { value: '/next' } });
  fireEvent.submit(path.closest('form')!);
  await waitFor(() => expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Path' }).value).toBe('/next'));
  await act(async () => complete({ error: null }));
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Path' }).value).toBe('/next');
});

test('search options appear only with focus or text and leave a full input', async () => {
  renderSlot({ component: Workspace }, { threadId: 'thr_ui', boxId: 'bx_ui', os: 'linux' }, { rpc: { 'files.tree': async () => tree() } });
  await screen.findByRole('treeitem', { name: 'src' });
  const input = screen.getByRole('searchbox', { name: 'Search in files' });
  const options = () => screen.queryAllByRole('button', { name: /Match case|Match whole word|Use regular expression/ });
  expect(input.getAttribute('placeholder')).toBe('Search');
  expect(input.className).toContain('min-w-[9rem]');
  expect(options()).toHaveLength(0);
  fireEvent.focus(input);
  expect(options()).toHaveLength(3);
  expect(input.parentElement?.contains(options()[0])).toBe(false);
  fireEvent.blur(input);
  expect(options()).toHaveLength(0);
  fireEvent.change(input, { target: { value: 'example' } });
  fireEvent.blur(input);
  expect(options()).toHaveLength(3);
});

for (const count of [1, 2]) test(`footer counts ${count} files`, async () => {
  renderSlot({ component: Workspace }, { threadId: 'thr_ui', boxId: 'bx_ui', os: 'linux' }, { rpc: { 'files.tree': async () => tree('/home/box', Array.from({ length: count }, (_, index) => `${index}.txt`), []) } });
  expect(await screen.findByText(`${count} ${count === 1 ? 'file' : 'files'}`)).toBeTruthy();
});

test('Markdown preview passes the original source to the host renderer', async () => {
  const content = '# Example project\n\nA box with files ready to edit.\n';
  renderSlot({ component: Workspace }, { threadId: 'thr_ui', boxId: 'bx_ui', os: 'linux' }, { rpc: {
    'files.tree': async () => tree('/home/box', ['README.md'], []),
    'files.read': async () => ({ error: null, kind: 'text', content, sha256: 'a'.repeat(64), sizeBytes: content.length }),
  } });
  const file = await screen.findByRole('treeitem', { name: 'README.md' });
  await act(async () => fireEvent.click(file));
  expect(screen.getByTestId('bb-markdown').textContent).toBe(content);
});

test('expanded folder toggle retries a missing listing', async () => {
  let reads = 0;
  renderSlot({ component: Workspace }, { threadId: 'thr_ui', boxId: 'bx_ui', os: 'linux' }, { rpc: {
    'files.tree': async (value: unknown) => {
      const input = request.parse(value);
      if (input.path?.endsWith('/src')) { reads++; return { error: 'Try again.' }; }
      return tree();
    },
  } });
  fireEvent.click(await screen.findByRole('treeitem', { name: 'src' }));
  await screen.findByText('Try again.');
  const before = reads;
  fireEvent.click(screen.getByRole('treeitem', { name: 'src' }));
  await waitFor(() => expect(reads).toBeGreaterThan(before));
});

test('root navigation resets shared expanded paths', async () => {
  renderSlot({ component: Workspace }, { threadId: 'thr_ui', boxId: 'bx_ui', os: 'linux' }, { rpc: {
    'files.tree': async (value: unknown) => { const input = request.parse(value); return input.path?.endsWith('/src') ? tree(input.path, ['one.ts'], []) : tree(input.path ?? '/home/box'); },
  } });
  fireEvent.click(await screen.findByRole('treeitem', { name: 'src' }));
  await screen.findByRole('treeitem', { name: 'one.ts' });
  const path = screen.getByRole('textbox', { name: 'Path' });
  fireEvent.change(path, { target: { value: '/next' } });
  fireEvent.submit(path.closest('form')!);
  await waitFor(() => expect(screen.getByRole('treeitem', { name: 'src' }).getAttribute('aria-expanded')).toBe('false'));
  fireEvent.click(screen.getByRole('treeitem', { name: 'src' }));
  await screen.findByRole('treeitem', { name: 'one.ts' });
});

test('context creation loads parent and refreshes after initial failure', async () => {
  let made = false;
  let reads = 0;
  renderSlot({ component: Workspace }, { threadId: 'thr_ui', boxId: 'bx_ui', os: 'linux' }, { rpc: {
    'files.tree': async (value: unknown) => {
      const input = request.parse(value);
      if (input.path === '/home/box/src') { reads++; return made ? tree(input.path, ['one.ts'], ['made']) : { error: 'Try again.' }; }
      return tree();
    },
    'files.create': async () => { made = true; return { error: null }; },
  } });
  fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'src' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'New folder' }));
  await waitFor(() => expect(reads).toBe(1));
  await screen.findByText('Try again.');
  const name = screen.getByRole('textbox', { name: 'New folder name' });
  fireEvent.change(name, { target: { value: 'made' } });
  fireEvent.submit(name.closest('form')!);
  await screen.findByRole('treeitem', { name: 'made' });
  expect(screen.getByRole('treeitem', { name: 'one.ts' })).toBeTruthy();
});

test('failed index offers current tree files in quick open', async () => {
  const read = vi.fn(async () => ({ error: null, kind: 'text', content: 'known', sha256: 'a'.repeat(64), sizeBytes: 5 }));
  renderSlot({ component: Workspace }, { threadId: 'thr_ui', boxId: 'bx_ui', os: 'linux' }, { rpc: {
    'files.tree': async (value: unknown) => request.parse(value).recursive ? { error: 'Index failed.' } : tree('/home/box', ['known.txt'], []),
    'files.read': read,
  } });
  await screen.findByRole('treeitem', { name: 'known.txt' });
  fireEvent.click(screen.getByRole('button', { name: 'Go to file by name' }));
  await screen.findByText('Index failed.');
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Go to file' }), { key: 'Enter' });
  await waitFor(() => expect(read).toHaveBeenCalledWith(expect.objectContaining({ path: '/home/box/known.txt' })));
});

test('creation refresh wins over an outstanding parent listing', async () => {
  const pending = deferred();
  let made = false;
  renderSlot({ component: Workspace }, { threadId: 'thr_ui', boxId: 'bx_ui', os: 'linux' }, { rpc: {
    'files.tree': async (value: unknown) => {
      const input = request.parse(value);
      if (input.path === '/home/box/src') return made ? tree(input.path, ['one.ts'], ['made']) : pending.promise;
      return tree();
    },
    'files.create': async () => { made = true; return { error: null }; },
  } });
  fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'src' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'New folder' }));
  await screen.findByRole('status', { name: 'Loading folder' });
  const name = screen.getByRole('textbox', { name: 'New folder name' });
  fireEvent.change(name, { target: { value: 'made' } });
  fireEvent.submit(name.closest('form')!);
  await screen.findByRole('treeitem', { name: 'made' });
  await act(async () => pending.resolve(tree('/home/box/src', ['stale.ts'], [])));
  expect(screen.getByRole('treeitem', { name: 'one.ts' })).toBeTruthy();
  expect(screen.getByRole('treeitem', { name: 'made' })).toBeTruthy();
  expect(screen.queryByRole('treeitem', { name: 'stale.ts' })).toBeNull();
});
