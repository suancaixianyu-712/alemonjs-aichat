import assert from "node:assert/strict";
import test from "node:test";

import { isLikelyLocalImagePath } from "../lib/api/image-source.js";

test("R2 上传把不带点前缀的相对图片识别为本地路径", () => {
  assert.equal(
    isLikelyLocalImagePath("public/image_out/generated-image.png"),
    true,
  );
  assert.equal(isLikelyLocalImagePath("generated-image.jpg"), true);
  assert.equal(isLikelyLocalImagePath("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"), false);
  assert.equal(isLikelyLocalImagePath("/9j/4AAQSkZJRgABAQAAAQABAAD="), false);
});
