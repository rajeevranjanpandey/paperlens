// Text extraction for uploads: .txt / .md / .pdf / .docx
// DOCX parsing uses fflate and the document XML directly, so it works the
// same in the browser and in Node. PDF parsing uses pdf.js and only loads
// when a PDF is actually opened, keeping the main bundle small.

import { unzipSync } from "fflate";

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\003\004

function startsWith(buf, magic) {
  return magic.every((b, i) => buf[i] === b);
}

/** A small share of raw control bytes usually means a binary format. */
function looksBinary(text) {
  const sample = text.slice(0, 4000);
  let bad = 0;
  for (const ch of sample) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 32 && c !== 10 && c !== 13 && c !== 9) bad++;
  }
  return sample.length > 0 && bad / sample.length > 0.01;
}

function decodeXmlEntities(s) {
  const AMP = "\u0026"; // & written via escape to survive tooling
  const named = {
    [AMP + "lt;"]: "<",
    [AMP + "gt;"]: ">",
    [AMP + "quot;"]: '"',
    [AMP + "apos;"]: "'",
    [AMP + "amp;"]: AMP,
  };
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(lt|gt|quot|apos|amp);/g, (m) => named[m]);
}

/** Pull body text out of a .docx (word/document.xml). */
export function docxText(buf) {
  const files = unzipSync(buf);
  const entry = files["word/document.xml"];
  if (!entry) throw new Error("This .docx file has no word/document.xml inside it.");
  const xml = new TextDecoder().decode(entry);
  return decodeXmlEntities(
    xml
      .replace(/<\/w:p>/g, "\n\n") // paragraph ends
      .replace(/<w:br[^>]*\/>/g, "\n")
      .replace(/<w:tab[^>]*\/>/g, "\t")
      .replace(/<[^>]+>/g, ""), // everything else is markup
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Group pdf.js text items into lines by vertical position, pages into paragraphs. */
function pageText(items) {
  const lines = [];
  for (const item of items) {
    if (typeof item.str !== "string" || !item.str.trim()) continue;
    const y = Math.round((item.transform?.[5] ?? 0) * 10) / 10;
    const line = lines.find((l) => Math.abs(l.y - y) < 2);
    if (line) line.parts.push(item.str);
    else lines.push({ y, parts: [item.str] });
  }
  lines.sort((a, b) => b.y - a.y); // top of page first
  return lines.map((l) => l.parts.join(" ")).join("\n");
}

async function pdfText(buf) {
  const pdfjs = await import("pdfjs-dist");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    const { default: workerUrl } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  }
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(pageText(content.items));
  }
  await doc.destroy();
  return pages.filter((p) => p.trim()).join("\n\n");
}

/** Read a File (browser) or Blob and return its text. */
export async function extractText(file) {
  const name = file?.name || "";
  const buf = new Uint8Array(await file.arrayBuffer());

  if (startsWith(buf, PDF_MAGIC)) {
    try {
      const text = await pdfText(buf);
      if (text.replace(/\s/g, "").length < 20) {
        return { kind: "pdf", error: "This PDF has no selectable text. It looks like a scan, so there is nothing to check. Try OCR first, or paste the text." };
      }
      return { kind: "pdf", text };
    } catch (e) {
      return { kind: "pdf", error: `Could not read this PDF: ${e?.message || e}` };
    }
  }

  if (startsWith(buf, ZIP_MAGIC) && /\.docx$/i.test(name)) {
    try {
      return { kind: "docx", text: docxText(buf) };
    } catch (e) {
      return { kind: "docx", error: `Could not read this Word file: ${e?.message || e}. Try saving it as .docx again.` };
    }
  }

  if (startsWith(buf, ZIP_MAGIC)) {
    return { kind: "text", error: "This file is a zip archive. PaperLens reads .txt, .md, .pdf and .docx." };
  }

  const text = new TextDecoder().decode(buf);
  if (looksBinary(text)) {
    return {
      kind: "text",
      error: /\.doc$/i.test(name)
        ? "Old .doc files are not supported. Open it in Word and save as .docx."
        : "This file is not plain text, PDF or Word. Try .txt, .md, .pdf or .docx.",
    };
  }
  return { kind: "text", text };
}
