import { StrictMode } from 'react';
import { z } from 'zod';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { Workspace } from '../src/app/files-ui/Workspace.tsx';
import { BoxFiles } from '../src/app/files.tsx';
import { forgetLive } from '../src/app/common.tsx';
import { WorkspaceLifetime } from '../src/app/files-ui/WorkspaceLifetime.tsx';
import { clearWorkspaces, restoreWorkspace, takeWorkspace, keepWorkspace, forgetWorkspaceBox, workspaceBoxes, WORKSPACE_LIMIT, WORKSPACE_BYTES } from '../src/app/files-ui/workspace-memory.ts';

vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
Element.prototype.scrollIntoView = () => {};
afterEach(() => { cleanup(); clearWorkspaces(); forgetLive(); localStorage.clear(); });
const input = z.object({ path: z.string().nullable().optional(), recursive: z.boolean().optional(), refresh: z.boolean().optional() });
const content = Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n');
const hash = 'a'.repeat(64);
const tree = (path = '/home/box', paths = ['readme.txt'], directories = ['src']) => ({ error: null, path, paths, directories, truncated: false, partial: false, cached: false });
const read = () => ({ error: null, kind: 'text', content, sha256: hash, sizeBytes: content.length });
const handlers = {
  'files.tree': async (value: unknown) => { const request = input.parse(value); return request.path?.endsWith('/src') ? tree(request.path, ['one.ts'], []) : tree(request.path ?? '/home/box'); },
  'files.read': async () => read(),
};
const props = { threadId: 'thr_one', boxId: 'bx_one', os: 'linux' as const };
const mount = (rpc: Record<string, (value: unknown) => unknown> = handlers, overrides = {}) => renderSlot({ component: Workspace }, { ...props, ...overrides }, { rpc });
async function edit() {
  fireEvent.click(await screen.findByRole('treeitem', { name: 'readme.txt' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Edit readme.txt' });
}

test('dirty draft, original hash, selection, scroll, folders and tabs survive an immediate remount and quiet refresh', async () => {
  const write = vi.fn(async () => ({ error: null, outcome: 'saved', sha256: 'b'.repeat(64), sizeBytes: 5 }));
  const rpc = { ...handlers, 'files.write': write };
  const first = mount(rpc);
  fireEvent.click(await screen.findByRole('treeitem', { name: 'src' }));
  fireEvent.click(await screen.findByRole('treeitem', { name: 'one.ts' }));
  const editor = await edit();
  fireEvent.change(editor, { target: { value: `${content}\ndraft` } });
  editor.setSelectionRange(13, 29, 'backward');
  fireEvent.select(editor);
  editor.scrollTop = 350;
  editor.scrollLeft = 18;
  fireEvent.scroll(editor);
  const treePort = screen.getByRole('tree').parentElement!;
  treePort.scrollTop = 80;
  fireEvent.scroll(treePort);
  first.unmount();
  const pending = new Promise<ReturnType<typeof tree>>(() => {});
  mount({ ...rpc, 'files.tree': async () => pending });
  const restored = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Edit readme.txt' });
  expect(restored.value).toBe(`${content}\ndraft`);
  expect([restored.selectionStart, restored.selectionEnd, restored.selectionDirection]).toEqual([13, 29, 'backward']);
  expect([restored.scrollTop, restored.scrollLeft]).toEqual([350, 18]);
  expect(screen.getByRole('treeitem', { name: 'src' }).getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('treeitem', { name: 'one.ts' })).toBeTruthy();
  expect(screen.getByRole('tree').parentElement!.scrollTop).toBe(80);
  expect(Array.from(screen.getByRole('list', { name: 'Open files' }).querySelectorAll('[aria-current], button[title]')).filter((tab) => !tab.getAttribute('aria-label')).map((tab) => tab.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('one.ts'), expect.stringContaining('readme.txt')]));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(write).toHaveBeenCalledWith(expect.objectContaining({ expectedSha256: hash, content: `${content}\ndraft` })));
  expect(JSON.stringify(localStorage)).not.toContain('draft');
});

test('find, search options and results restore while quick open stays closed', async () => {
  const search = vi.fn(async () => ({ error: null, hits: [{ path: 'readme.txt', line: 1, column: 1, preview: 'line 0' }], truncated: false }));
  const rpc = { ...handlers, 'files.search': search };
  const first = mount(rpc);
  await edit();
  fireEvent.click(screen.getByRole('button', { name: 'Find in file' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Find in file' }), { target: { value: 'line' } });
  const field = screen.getByRole('searchbox', { name: 'Search in files' });
  fireEvent.change(field, { target: { value: 'line' } });
  fireEvent.click(screen.getByRole('button', { name: /Match whole word/ }));
  await screen.findByRole('list', { name: 'Search results' });
  await waitFor(() => expect(screen.getByLabelText('Search summary').textContent).toContain('1 result'));
  fireEvent.click(screen.getByRole('button', { name: 'Go to file by name' }));
  first.unmount();
  mount({ ...rpc, 'files.search': async () => new Promise(() => {}) });
  expect(screen.queryByRole('textbox', { name: 'Go to file' })).toBeNull();
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Find in file' }).value).toBe('line');
  expect(screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search in files' }).value).toBe('line');
  expect(screen.getByRole('button', { name: /Match whole word/ }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByLabelText('Search summary').textContent).toContain('1 result');
});

test('root and hidden explorer restore and state is isolated by thread and box', async () => {
  const first = mount();
  await edit();
  fireEvent.click(screen.getByRole('button', { name: 'Hide the file explorer' }));
  first.unmount();
  const other = mount(handlers, { threadId: 'thr_other' });
  expect(screen.queryByRole('textbox', { name: 'Edit readme.txt' })).toBeNull();
  other.unmount();
  const otherBox = mount(handlers, { boxId: 'bx_other' });
  expect(screen.queryByRole('textbox', { name: 'Edit readme.txt' })).toBeNull();
  otherBox.unmount();
  const restored = mount();
  expect(screen.getByRole('textbox', { name: 'Edit readme.txt' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Show the file explorer' }));
  const path = screen.getByRole('textbox', { name: 'Path' });
  fireEvent.change(path, { target: { value: '/project' } });
  fireEvent.submit(path.closest('form')!);
  await waitFor(() => expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Path' }).value).toBe('/project'));
  restored.unmount();
  mount();
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Path' }).value).toBe('/project');
});

test('late file reads cannot replace a draft in the next mount', async () => {
  let complete: (value: ReturnType<typeof read>) => void = () => {};
  const pending = new Promise<ReturnType<typeof read>>((resolve) => { complete = resolve; });
  const first = mount({ ...handlers, 'files.read': async () => pending });
  fireEvent.click(await screen.findByRole('treeitem', { name: 'readme.txt' }));
  first.unmount();
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Edit readme.txt' }), { target: { value: 'new draft' } });
  await act(async () => complete({ ...read(), content: 'stale' }));
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Edit readme.txt' }).value).toBe('new draft');
});

test('memory drops the least recently used workspaces at both limits and rejects an oversized snapshot', () => {
  for (let index = 0; index <= WORKSPACE_LIMIT; index++) keepWorkspace(takeWorkspace('thread', `box-${index}`));
  expect(workspaceBoxes()).toHaveLength(WORKSPACE_LIMIT);
  expect(workspaceBoxes()).not.toContain('box-0');
  const recent = takeWorkspace('thread', 'box-1');
  recent.state.root = '/kept';
  keepWorkspace(recent);
  keepWorkspace(takeWorkspace('thread', 'new'));
  expect(workspaceBoxes()).not.toContain('box-2');
  clearWorkspaces();
  for (let index = 0; index < 3; index++) {
    const memory = takeWorkspace('thread', `large-${index}`);
    memory.state.names = ['x'.repeat(WORKSPACE_BYTES / 2 - 1000)];
    keepWorkspace(memory);
  }
  expect(workspaceBoxes()).toEqual(['large-1', 'large-2']);
  const oversized = takeWorkspace('thread', 'oversized');
  oversized.state.names = ['x'.repeat(WORKSPACE_BYTES)];
  keepWorkspace(oversized);
  expect(workspaceBoxes()).not.toContain('oversized');
});

test('release removes all threads and prevents live state from being retained again', () => {
  keepWorkspace(takeWorkspace('one', 'released'));
  keepWorkspace(takeWorkspace('two', 'released'));
  const live = takeWorkspace('three', 'released');
  keepWorkspace(takeWorkspace('one', 'kept'));
  forgetWorkspaceBox('released');
  keepWorkspace(live);
  expect(workspaceBoxes()).toEqual(['kept']);
});

test('release observed by the app overlay drops a hidden workspace', async () => {
  const memory = takeWorkspace('one', 'released');
  memory.state.root = '/old';
  keepWorkspace(memory);
  renderSlot({ component: WorkspaceLifetime }, {}, { rpc: { boxPage: async () => ({ box: null }) } });
  await waitFor(() => expect(workspaceBoxes()).toEqual([]));
});

const box = { id: 'bx_one', name: 'build-1', os: 'linux', terminal: true, state: 'ready', device: null };
test('thread Files has no name bar, while a switcher keeps its box name', async () => {
  const rpc = { ...handlers, boxPage: async () => ({ box }) };
  const first = renderSlot({ component: BoxFiles }, props, { rpc });
  await screen.findByRole('treeitem', { name: 'readme.txt' });
  expect(screen.queryByText('build-1')).toBeNull();
  expect(first.container.querySelector('[data-files]')?.firstElementChild?.className).not.toContain('border-b');
  first.unmount();
  renderSlot({ component: BoxFiles }, { ...props, otherViews: () => <button>Terminal</button> }, { rpc });
  expect(screen.getByText('build-1')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Terminal' })).toBeTruthy();
});


test('each tab keeps its cursor and scroll and a collapsed active folder stays collapsed', async () => {
  const first = mount();
  const editor = await edit();
  editor.setSelectionRange(9, 20);
  fireEvent.select(editor);
  editor.scrollTop = 200;
  fireEvent.scroll(editor);
  fireEvent.click(screen.getByRole('treeitem', { name: 'src' }));
  fireEvent.click(await screen.findByRole('treeitem', { name: 'one.ts' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  const second = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Edit src/one.ts' });
  second.setSelectionRange(4, 7);
  fireEvent.select(second);
  second.scrollTop = 120;
  fireEvent.scroll(second);
  fireEvent.click(screen.getByRole('treeitem', { name: 'src' }));
  first.unmount();
  mount();
  expect(screen.getByRole('treeitem', { name: 'src' }).getAttribute('aria-expanded')).toBe('false');
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Edit src/one.ts' }).selectionEnd).toBe(7);
  fireEvent.click(screen.getByRole('button', { name: 'readme.txt' }));
  const restored = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Edit readme.txt' });
  expect([restored.selectionStart, restored.selectionEnd, restored.scrollTop]).toEqual([9, 20, 200]);
});

test('preview text selection and scroll survive remount', async () => {
  const rpc = { ...handlers, 'files.tree': async () => tree('/home/box', ['README.md'], []), 'files.read': async () => ({ ...read(), content: '# Example text to select' }) };
  const first = mount(rpc);
  fireEvent.click(await screen.findByRole('treeitem', { name: 'README.md' }));
  const preview = await screen.findByRole('region', { name: 'Preview of README.md' });
  const node = screen.getByTestId('bb-markdown').firstChild!;
  window.getSelection()?.setBaseAndExtent(node, 3, node, 10);
  fireEvent(document, new Event('selectionchange'));
  preview.scrollTop = 90;
  fireEvent.scroll(preview);
  first.unmount();
  expect(restoreWorkspace(props.threadId, props.boxId).views.get('README.md')?.textSelection).toEqual({ anchor: 3, focus: 10 });
  mount(rpc);
  expect(window.getSelection()?.toString()).toBe('xample ');
  expect(screen.getByRole('region', { name: 'Preview of README.md' }).scrollTop).toBe(90);
});

test('strict effect replay does not lose restored state or leave an extra live workspace', async () => {
  const first = mount();
  const editor = await edit();
  fireEvent.change(editor, { target: { value: 'strict draft' } });
  first.unmount();
  const StrictWorkspace = () => <StrictMode><Workspace {...props} /></StrictMode>;
  const second = renderSlot({ component: StrictWorkspace }, {}, { rpc: handlers });
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Edit readme.txt' }).value).toBe('strict draft');
  second.unmount();
  forgetWorkspaceBox(props.boxId);
  expect(workspaceBoxes()).toEqual([]);
});

test('an older release check cannot discard a workspace after a newer ready reply', async () => {
  keepWorkspace(takeWorkspace('one', 'bx_one'));
  let complete: (value: { box: null }) => void = () => {};
  const pending = new Promise<{ box: null }>((resolve) => { complete = resolve; });
  let calls = 0;
  const slot = renderSlot({ component: WorkspaceLifetime }, {}, { rpc: { boxPage: async () => ++calls === 1 ? pending : { box } } });
  await slot.emitRealtime('changed', null);
  await act(async () => complete({ box: null }));
  expect(workspaceBoxes()).toEqual(['bx_one']);
});

test('a released BoxFiles removes the snapshot and a back control keeps the name', async () => {
  let released = false;
  const rpc = { ...handlers, boxPage: async () => ({ box: released ? null : box }) };
  const slot = renderSlot({ component: BoxFiles }, { ...props, onBack: { label: 'Boxes', href: '/boxes' } }, { rpc });
  await edit();
  expect(screen.getByText('build-1')).toBeTruthy();
  released = true;
  await slot.emitRealtime('changed', null);
  await screen.findByText('build-1 has been released.');
  expect(workspaceBoxes()).toEqual([]);
});

test('a workspace with an unsaved edit is never evicted, past the count or the byte limit', () => {
  const dirty = takeWorkspace('thr_dirty', 'bx_dirty');
  dirty.state.tabs = [{ path: 'notes.md', file: null, error: null, draft: 'x'.repeat(WORKSPACE_BYTES + 1), sha256: hash, mode: 'edit', save: { kind: 'idle' } } as never];
  keepWorkspace(dirty);
  for (let index = 0; index < WORKSPACE_LIMIT + 2; index += 1) keepWorkspace(takeWorkspace(`thr_${index}`, `bx_${index}`));
  expect(restoreWorkspace('thr_dirty', 'bx_dirty').state.tabs?.[0]?.draft?.length).toBe(WORKSPACE_BYTES + 1);
  expect(workspaceBoxes()).toContain('bx_dirty');
});
