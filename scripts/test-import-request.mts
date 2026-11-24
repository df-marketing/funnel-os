import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedFormData, ImportInputError, MAX_IMPORT_BYTES, validateUpload } from "../lib/import/upload-file.ts";

test("bounded multipart preserves regular CSV uploads", async () => {
  const form = new FormData();
  form.append("file", new File(["email,date\nfixture@example.invalid,2026-11-01"], "synthetic.csv"));
  form.append("source", "leads");
  const decoded = await boundedFormData(new Request("http://localhost", { method: "POST", body: form }));
  assert.equal(decoded.get("source"), "leads");
  assert.equal(validateUpload(decoded.get("file")).name, "synthetic.csv");
});
test("streamed uploads are rejected at the limit without Content-Length", async () => {
  const body = new ReadableStream({
    start(controller) {
      const chunk = new Uint8Array(1024 * 1024);
      for (let i = 0; i < Math.ceil(MAX_IMPORT_BYTES / chunk.length) + 2; i++) controller.enqueue(chunk);
      controller.close();
    },
  });
  const request = new Request("http://localhost", {
    method: "POST", body, headers: { "content-type": "multipart/form-data; boundary=synthetic" }, duplex: "half",
  } as RequestInit);
  await assert.rejects(() => boundedFormData(request), (error) => error instanceof ImportInputError && error.status === 413);
});
