import assert from "node:assert/strict";
import { test } from "node:test";
import { DRIVERS } from "../src/backends/index.ts";
import { checkDocument, emptyDocument, readDraft, type ConfigDocument, type ImageConfig } from "../src/core/document.ts";
import { imageChoices, namedImage, projectImage, withImage } from "../src/core/project-images.ts";
import { imagesText, imageWords, type ImageOptionView } from "../src/plugin/views.ts";

const IMAGE: ImageConfig = { kinds: ["linux", "linux-desktop-cpu"], script: "#!/bin/bash\napt-get install -y tailscale\n", check: "tailscale version\n", bake: "auto", projects: ["prj_one"], source: { script: ".bb/box-setup.sh", check: ".bb/box-check.sh" }, updated: "2026-10-03T10:00:00.000Z" };
const problemsOf = (document: ConfigDocument) => checkDocument(document, {}, DRIVERS).filter((problem) => problem.path.startsWith("images"));

test("a project's image reads from the configuration, and comes back as it was (049)", () => {
  const draft = readDraft({ ...emptyDocument(), images: { "rust-tools": IMAGE } }, DRIVERS);
  assert.deepEqual(draft.problems, []);
  assert.deepEqual(draft.document.images, { "rust-tools": IMAGE });
  assert.deepEqual(problemsOf(draft.document), []);
  assert.equal(readDraft(emptyDocument(), DRIVERS).document.images, undefined, "a document without images has none");
});

test("an image's shape and its checks: its name, Linux kinds that exist, its projects, its size, and one image a project's kind (049)", () => {
  const shape = readDraft({ ...emptyDocument(), images: { a: { kinds: [], script: " ", projects: ["p"], bake: "sometimes", extra: 1 }, b: "no" } }, DRIVERS);
  assert.deepEqual(
    shape.problems.map((problem) => problem.path),
    ["images.a.kinds", "images.a.script", "images.a.bake", "images.a.extra", "images.b"],
  );
  assert.equal(shape.document.images, undefined, "an image in the wrong shape is left out, so its problems block the write");

  const checked = problemsOf({
    ...emptyDocument(),
    images: {
      standard: { ...IMAGE, projects: ["prj_two"] },
      "Bad Name": { ...IMAGE, projects: ["prj_three"] },
      windows: { ...IMAGE, kinds: ["windows-desktop", "nonsense"], projects: ["prj_four"] },
      first: IMAGE,
      twin: { ...IMAGE, kinds: ["linux"] },
      large: { ...IMAGE, projects: ["prj_five"], script: "x".repeat(256 * 1024 + 1) },
    },
  });
  assert.deepEqual(
    checked.map((problem) => [problem.path, problem.message.split(".")[0]]),
    [
      ["images.standard", 'Name an image with a lower-case letter first, then letters, digits and "-", up to 40, and not "standard"'],
      ["images.Bad Name", 'Name an image with a lower-case letter first, then letters, digits and "-", up to 40, and not "standard"'],
      ["images.windows.kinds", "An image's script is a Linux one for now, and windows-desktop is not a Linux kind"],
      ["images.windows.kinds", 'There is no kind "nonsense"'],
      ["images.twin.kinds", "Project prj_one's linux boxes would get both first and twin"],
      ["images.large.script", "The script is 257 KiB; BB Box keeps up to 256 KiB"],
    ],
  );
});

test("a project's boxes of a kind get its image, and an image is set and removed in the document", () => {
  const document = withImage(emptyDocument(3), "rust-tools", IMAGE);
  assert.deepEqual(projectImage(document, "prj_one", "linux"), { name: "rust-tools", image: IMAGE });
  assert.equal(projectImage(document, "prj_one", "linux-desktop"), null, "a kind it does not cover");
  assert.equal(projectImage(document, "prj_two", "linux"), null, "another project");
  assert.equal(projectImage(document, null, "linux"), null, "a thread with no project");
  assert.equal(document.revision, 3);
  const removed = withImage(document, "rust-tools", null);
  assert.equal(removed.images, undefined);
  assert.equal(projectImage(removed, "prj_one", "linux"), null);
});

test("a box's choice of image: the project's first, the default, then standard, then other projects'; by name whichever project it is of (049)", () => {
  const document = withImage(withImage(withImage(emptyDocument(), "rust-tools", IMAGE), "zebra", { ...IMAGE, projects: ["prj_two"] }), "alpha", { ...IMAGE, kinds: ["linux"], projects: ["prj_three"] });
  assert.deepEqual(imageChoices(document, "prj_one", "linux"), [{ name: "rust-tools", mine: true }, { name: "standard", mine: false }, { name: "alpha", mine: false }, { name: "zebra", mine: false }]);
  assert.deepEqual(imageChoices(document, "prj_one", "linux-desktop-cpu").map((choice) => choice.name), ["rust-tools", "standard", "zebra"]);
  assert.deepEqual(imageChoices(document, "prj_nine", "linux").map((choice) => choice.name), ["standard", "alpha", "rust-tools", "zebra"]);
  assert.deepEqual(imageChoices(document, "prj_one", "linux-desktop"), [], "no image covers it: no choice");
  assert.equal(namedImage(document, "zebra", "linux")?.name, "zebra");
  assert.equal(namedImage(document, "alpha", "linux-desktop-cpu"), null);
  assert.equal(namedImage(document, "nope", "linux"), null);
});

test("box_list's images per kind, and a box's image in its details (049)", () => {
  const option = (name: string, mine: boolean, changes: Partial<ImageOptionView> = {}): ImageOptionView => ({ name, kinds: ["linux"], projects: [{ id: "prj_x", name: "Example" }], mine, builds: [], spares: [], ...changes });
  const images = [option("rust-tools", true, { builds: [{ kind: "linux", backend: "proxmox-lxc", build: "build.20261003-021500-3f9c", built: "2026-10-03T02:15:00.000Z" }] }), option("other", false)];
  assert.equal(imagesText(images, "linux"), " Images: rust-tools (this project's, the default), built ahead on proxmox-lxc; standard; other (Example).");
  assert.equal(imagesText([option("other", false)], "linux"), " Images: standard (the default); other (Example).");
  assert.equal(imagesText(images, "macos"), "");
  // Its spares (#440): where one is ready, or being made.
  const spared = [option("rust-tools", true, { builds: images[0]!.builds, spares: [{ kind: "linux", backend: "proxmox-lxc", ready: 1, making: 0 }] })];
  assert.equal(imagesText(spared, "linux"), " Images: rust-tools (this project's, the default), built ahead on proxmox-lxc with a spare ready; standard.");
  const making = [option("rust-tools", true, { builds: images[0]!.builds, spares: [{ kind: "linux", backend: "proxmox-lxc", ready: 0, making: 1 }] })];
  assert.match(imagesText(making, "linux"), /built ahead on proxmox-lxc with a spare being made;/);
  assert.equal(imageWords({ name: "rust-tools", state: "baked", build: "build.20261002-021500-3f9c", from: "9123" }), "rust-tools, built 2 October");
  assert.equal(imageWords({ name: "rust-tools", state: "done", seconds: 22 }), "rust-tools, its script ran as the box started, in 22 s");
});
