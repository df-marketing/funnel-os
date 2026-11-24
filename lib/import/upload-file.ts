import { inspectWorksheets, selectedWorksheet } from "./worksheets";

export const MAX_IMPORT_BYTES = 15 * 1024 * 1024;

export class ImportInputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function validateUpload(value: FormDataEntryValue | null): File {
  if (!(value instanceof File)) throw new ImportInputError("No file was uploaded.");
  if (value.size > MAX_IMPORT_BYTES) {
    throw new ImportInputError("That file is over 15MB. Split it and import in parts.", 413);
  }
  if (/\.(?:xls|xlsm|xlsb|xltm|xltx)$/i.test(value.name)) {
    throw new ImportInputError("Choose a CSV or an .xlsx workbook, not a legacy or macro-enabled spreadsheet.");
  }
  return value;
}

export const isWorkbook = (file: File) => /\.xlsx$/i.test(file.name);

export async function inspectUpload(file: File, sheet: string) {
  if (isWorkbook(file) && !sheet) {
    return { kind: "worksheets" as const, sheets: await inspectWorksheets(new Uint8Array(await file.arrayBuffer()), file.name) };
  }
  return { kind: "data" as const, ...await uploadText(file, sheet) };
}

export async function uploadText(file: File, sheet: string) {
  if (!isWorkbook(file)) {
    if (sheet) throw new ImportInputError("Choose a worksheet only when importing an .xlsx workbook.");
    return { text: await file.text(), worksheet: null };
  }
  if (!sheet || sheet.length > 256) throw new ImportInputError("Choose a worksheet before reviewing the import.");
  const selected = await selectedWorksheet(new Uint8Array(await file.arrayBuffer()), file.name, sheet);
  return { text: selected.text, worksheet: selected.name };
}

/** A streaming cap also applies when Content-Length is absent or misleading. */
export async function boundedFormData(request: Request): Promise<FormData> {
  const max = MAX_IMPORT_BYTES + 256 * 1024;
  if (Number(request.headers.get("content-length")) > max) {
    throw new ImportInputError("That upload is too large. Split the file and import in parts.", 413);
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data(?:;|$)/i.test(contentType)) {
    throw new ImportInputError("Send the import as a file upload.", 415);
  }
  const stream = request.body?.getReader();
  if (!stream) throw new ImportInputError("No file was uploaded.");
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await stream.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > max) {
        await stream.cancel().catch(() => undefined);
        throw new ImportInputError("That upload is too large. Split the file and import in parts.", 413);
      }
      parts.push(Uint8Array.from(next.value));
    }
  } finally {
    stream.releaseLock();
  }
  try {
    return await new Response(new Blob(parts), { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new ImportInputError("The file upload is invalid.");
  }
}

export function requireWorkbookAccess(file: File, loginEnforced: boolean) {
  // Do not introduce a new untrusted workbook parser on a public production
  // demo. Local development follows the normal existing demo import policy.
  if (isWorkbook(file) && process.env.NODE_ENV === "production" && !loginEnforced) {
    throw new ImportInputError("Excel imports require a login-enabled workspace.", 403);
  }
}
