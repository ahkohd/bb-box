import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { Explorer } from "../src/app/files-ui/Explorer.tsx";
import { HOST_ICON_NAMES, ICON_FALLBACK } from "../src/app/files-ui/icon-names.ts";

const FILE_PLUS_MARK = "M12 5.99954H4M8 1.99954V9.99954";
const BOLT = "M13 2 4 14h7l-1 8 9-12h-7z";
const DRAWN = new Set(["FilePlus"]);

installTestPluginRuntime();

afterEach(() => {
  cleanup();
});

function iconLiterals(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/\b(?:icon|name)\s*=\s*(?:"([A-Za-z][A-Za-z0-9]*)"|\{([^}]+)\})/g)) {
    if (match[1] !== undefined) names.push(match[1]);
    else if (match[2] !== undefined) for (const literal of match[2].matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)) names.push(literal[1]);
  }
  return names;
}

function viewSources(): string[] {
  const dir = join(process.cwd(), "src/app/files-ui");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => readFileSync(join(dir, name), "utf8"));
}

test("every icon in the files view is one the host draws, so a missing name cannot fall back to the bolt", () => {
  const names = viewSources().flatMap(iconLiterals);
  expect(names.length).toBeGreaterThan(10);
  const missing = names.filter((name) => !HOST_ICON_NAMES.has(name) && !DRAWN.has(name));
  expect(missing).toEqual([]);
  expect(names).not.toContain(ICON_FALLBACK);
  expect(names).not.toContain("FileAdd");
  expect(names).not.toContain("FolderAdd");
  expect(HOST_ICON_NAMES.has("FolderPlus")).toBe(true);
  expect(HOST_ICON_NAMES.has("FilePlus")).toBe(false);
});

test("new file and new folder use the file-plus and folder-plus icons, not the bolt", () => {
  render(
    <Explorer
      entries={[
        { path: "src", kind: "directory" },
        { path: "notes.md", kind: "file" },
      ]}
      activePath={null}
      isLoading={false}
      error={null}
      truncated={false}
      hiddenSupported
      includeHidden={false}
      onToggleHidden={() => undefined}
      onOpenFile={() => undefined}
      onOpenMatch={() => undefined}
      onRefresh={() => undefined}
      onQuickOpen={() => undefined}
      onCreate={async () => null}
      onRename={async () => null}
      onDelete={async () => null}
      scope={null}
      searchFocusRequest={0}
      header={null}
    />,
  );
  const file = screen.getByRole("button", { name: "New file" });
  const folder = screen.getByRole("button", { name: "New folder" });
  expect(file.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe("FilePlus");
  const marks = Array.from(file.querySelectorAll("path")).map((path) => path.getAttribute("d") ?? "");
  expect(marks.some((mark) => mark.includes(FILE_PLUS_MARK))).toBe(true);
  expect(file.innerHTML).not.toContain(BOLT);
  expect(folder.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe("FolderPlus");
  expect(folder.querySelector("[data-icon-fallback]")?.getAttribute("data-icon-fallback") ?? "").not.toBe(ICON_FALLBACK);
  for (const icon of Array.from(document.querySelectorAll("[data-icon]"))) {
    const name = icon.getAttribute("data-icon");
    expect(name === "FilePlus" || (name !== null && HOST_ICON_NAMES.has(name) && name !== ICON_FALLBACK)).toBe(true);
  }
});

function explorerWhile(isLoading: boolean) {
  return render(
    <Explorer
      entries={[]}
      activePath={null}
      isLoading={isLoading}
      error={null}
      truncated={false}
      hiddenSupported
      includeHidden={false}
      onToggleHidden={() => undefined}
      onOpenFile={() => undefined}
      onOpenMatch={() => undefined}
      onRefresh={() => undefined}
      onQuickOpen={() => undefined}
      onCreate={async () => null}
      onRename={async () => null}
      onDelete={async () => null}
      scope={null}
      searchFocusRequest={0}
      header={null}
    />,
  );
}

test("refresh uses the rotate icon and spins while a folder is read, with no reading line and no file count", () => {
  const { container } = explorerWhile(true);
  const refresh = screen.getByRole("button", { name: "Refresh files" });
  const icon = refresh.querySelector("[data-icon]");
  expect(icon?.getAttribute("data-icon")).toBe("RotateCcw");
  expect(icon?.getAttribute("class") ?? "").toContain("animate-spin");
  expect(container.textContent ?? "").not.toMatch(/Reading/);
  expect(container.textContent ?? "").not.toMatch(/0 files/);
});

test("the search row never wraps, so New folder stays beside the other actions", () => {
  explorerWhile(false);
  const row = screen.getByRole("button", { name: "New folder" }).parentElement;
  expect(row?.className ?? "").not.toContain("flex-wrap");
  expect(screen.getByRole("button", { name: "Refresh files" }).parentElement).toBe(row);
  expect(screen.getByText("This folder has no files yet.")).toBeTruthy();
});
