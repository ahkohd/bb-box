export interface TextSelection {
  anchor: number;
  focus: number;
}

export function readTextSelection(root: HTMLElement): TextSelection | null {
  const selection = window.getSelection();
  if (!selection?.anchorNode || !selection.focusNode || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
  const offset = (node: Node, end: number) => {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, end);
    return range.toString().length;
  };
  return { anchor: offset(selection.anchorNode, selection.anchorOffset), focus: offset(selection.focusNode, selection.focusOffset) };
}

export function restoreTextSelection(root: HTMLElement, saved: TextSelection): void {
  const position = (offset: number) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const length = node.textContent?.length ?? 0;
      if (offset <= length) return { node, offset };
      offset -= length;
      node = walker.nextNode();
    }
    return null;
  };
  const anchor = position(saved.anchor);
  const focus = position(saved.focus);
  if (anchor && focus) window.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
}
