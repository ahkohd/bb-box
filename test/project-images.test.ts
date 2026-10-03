import assert from "node:assert/strict";
import { test } from "node:test";
import { DRIVERS } from "../src/backends/index.ts";
import { checkDocument, emptyDocument, readDraft, type ConfigDocument, type ImageConfig } from "../src/core/document.ts";
import { projectImage, withImage } from "../src/core/project-images.ts";

const IMAGE: ImageConfig = { kinds: ["linux", "linux-desktop-cpu"], script: "#!/bin/bash\napt-get install -y tailscale\n", check: "tailscale version\n", bake: "auto", projects: ["prj_one"], source: { script: ".bb/box-setup.sh", check: ".bb/box-check.sh" }, updated: "2026-10-03T10:00:00.000Z" };
const problemsOf = (document: ConfigDocument) => checkDocument(document, {}, DRIVERS).filter((problem) => problem.path.startsWith("images"));

test("a project's image reads from the configuration, and comes back as it was (049)", () => {
  const draft = readDraft({ ...emptyDocument(), images: { "rust-tailscale": IMAGE } }, DRIVERS);
  assert.deepEqual(draft.problems, []);
  assert.deepEqual(draft.document.images, { "rust-tailscale": IMAGE });
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
      ["images.large.script", "The script is 257 KiB; bb-box keeps up to 256 KiB"],
    ],
  );
});

test("a project's boxes of a kind get its image, and an image is set and removed in the document", () => {
  const document = withImage(emptyDocument(3), "rust-tailscale", IMAGE);
  assert.deepEqual(projectImage(document, "prj_one", "linux"), { name: "rust-tailscale", image: IMAGE });
  assert.equal(projectImage(document, "prj_one", "linux-desktop"), null, "a kind it does not cover");
  assert.equal(projectImage(document, "prj_two", "linux"), null, "another project");
  assert.equal(projectImage(document, null, "linux"), null, "a thread with no project");
  assert.equal(document.revision, 3);
  const removed = withImage(document, "rust-tailscale", null);
  assert.equal(removed.images, undefined);
  assert.equal(projectImage(removed, "prj_one", "linux"), null);
});
