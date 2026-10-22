import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractText, docxText } from "../shared/extract-text.mjs";

const docxBytes = new Uint8Array(readFileSync(new URL("./fixtures/sample.docx", import.meta.url)));
const docxFile = new File([docxBytes], "paper.docx");

test("docx body text is extracted with paragraphs and entities", () => {
  const text = docxText(docxBytes);
  assert.ok(text.includes("Method and Data Collection"));
  assert.ok(text.includes("eleven engineers & three product managers"));
  assert.ok(text.includes('"describe a decision you reversed"'));
  assert.ok(!text.includes("<w:"));
  assert.ok(/\n\n/.test(text), "paragraph breaks preserved");
});

test("extractText dispatches a docx by magic bytes and extension", async () => {
  const r = await extractText(docxFile);
  assert.equal(r.kind, "docx");
  assert.ok(r.text.includes("Data Collection"));
  assert.equal(r.error, undefined);
});

test("plain text files pass through unchanged", async () => {
  const f = new File([Buffer.from("Hello paper, this is plain text.")], "notes.txt");
  const r = await extractText(f);
  assert.equal(r.kind, "text");
  assert.equal(r.text, "Hello paper, this is plain text.");
});

test("binary non-pdf non-docx files are rejected with guidance", async () => {
  const bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03]);
  const r = await extractText(new File([bytes], "old.doc"));
  assert.ok(r.error.includes(".docx"));
  assert.equal(r.text, undefined);
});

test("zip files that are not docx are rejected", async () => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
  const r = await extractText(new File([bytes], "archive.zip"));
  assert.ok(r.error.includes("zip"));
});

test("a renamed pdf is still detected by magic bytes", async () => {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
  // truncated pdf will fail parsing; assert the error is a pdf error, not a fallback
  const r = await extractText(new File([bytes], "mystery.bin"));
  assert.equal(r.kind, "pdf");
  assert.ok(r.error);
});
