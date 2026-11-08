import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test } from "vitest";
import { BoxDialog, DIALOG_CONTENT, DIALOG_FOOTER, DIALOG_TITLE, DialogButton, DialogCancel, Refused } from "../src/app/box-dialog.tsx";

afterEach(cleanup);

function Release({ act }: { act: () => Promise<string | null> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open release
      </button>
      <BoxDialog open={open} onClose={() => setOpen(false)} title="Release calm-otter?" description="The box stops." busy={busy} refused={refused}>
        <DialogCancel onClick={() => setOpen(false)}>Cancel</DialogCancel>
        <DialogButton
          danger
          busyWords="Releasing…"
          onClick={() => {
            setBusy(true);
            void act().then((why) => {
              setBusy(false);
              if (why) setRefused(why);
              else setOpen(false);
            });
          }}
        >
          Release
        </DialogButton>
      </BoxDialog>
    </>
  );
}

test("a dialog uses one shell: a plain title, no shadow, a gap in the footer, and one destructive button", () => {
  render(
    <BoxDialog
      open
      onClose={() => {}}
      title="Release calm-otter?"
      description="The box stops."
      footer={
        <>
          <DialogCancel>Cancel</DialogCancel>
          <DialogButton danger>Release</DialogButton>
        </>
      }
    >
      <Refused words={null} />
    </BoxDialog>,
  );
  const dialog = screen.getByRole("alertdialog", { name: "Release calm-otter?" });
  expect(dialog.className).toContain("shadow-none");
  expect(dialog.className).toContain("max-h-[calc(100dvh-2rem)]");
  expect(dialog.className).not.toContain("shadow-lg");
  const title = dialog.querySelector("h2");
  expect(title?.className).toContain("text-base");
  expect(title?.className).toContain("font-normal");
  expect(title?.className).not.toContain("font-semibold");
  const footer = dialog.querySelector("div.shrink-0.flex-row");
  expect(footer?.className).toContain("gap-2");
  const release = screen.getByRole("button", { name: "Release" });
  expect(release.className).toContain("bg-destructive");
  expect(release.className).toContain("text-destructive-foreground");
  expect(DIALOG_CONTENT).toContain("shadow-none");
  expect(DIALOG_TITLE).toContain("font-normal");
  expect(DIALOG_FOOTER).toContain("gap-2");
});

test("a dialog shows its busy label and the refusal, and returns focus to the button that opened it", async () => {
  let finish: (why: string | null) => void = () => {};
  render(
    <Release
      act={() =>
        new Promise((resolve) => {
          finish = resolve;
        })
      }
    />,
  );
  const opener = screen.getByRole("button", { name: "Open release" });
  opener.focus();
  fireEvent.click(opener);
  const dialog = await screen.findByRole("alertdialog");
  const release = screen.getByRole("button", { name: "Release" });
  fireEvent.click(release);
  expect(await screen.findByRole("button", { name: "Releasing…" })).toBeTruthy();
  expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  finish("The host refused.");
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "The host refused.");
  expect(screen.getByRole("button", { name: "Release" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(dialog).toBeTruthy();
});
