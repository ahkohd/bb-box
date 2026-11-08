import assert from "node:assert/strict";
import { test } from "node:test";
import { activeAfterClose } from "../src/app/files-tabs.ts";

test("closing the open file shows another tab", () => {
  assert.equal(activeAfterClose(["/a", "/b", "/c"], "/b", "/b"), "/c");
  assert.equal(activeAfterClose(["/a"], "/a", "/a"), null);
  assert.equal(activeAfterClose(["/a", "/b"], "/a", "/b"), "/a");
});
