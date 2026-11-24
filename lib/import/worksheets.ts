/** Server-only XLSX selection core. No network, database, or filesystem operations.
 * Deliberately refuses unsupported spreadsheet semantics rather than guessing.
 * Call inspectWorksheets first; convert ONLY the explicitly selected candidate.
 */
import { inflateRawSync } from 'node:zlib';
import { readSheet, type SheetData } from 'read-excel-file/node';
import { SaxesParser } from 'saxes';

export const WORKBOOK_LIMITS = Object.freeze({ fileBytes: 16 * 1024 * 1024, entries: 1024,
  entryBytes: 16 * 1024 * 1024, expandedBytes: 64 * 1024 * 1024,
  rows: 100_000, columns: 256, cells: 500_000, text: 1_000_000, outputBytes: 16 * 1024 * 1024 });
type Entry = { name: string; start: number; packed: number; size: number; method: number; crc: number };
export type WorksheetCandidate = { id: string; name: string; visibility: 'visible' | 'hidden' | 'veryHidden'; selectable: boolean };
export class WorkbookImportError extends Error { constructor(message: string) { super(message); this.name = 'WorkbookImportError'; } }
function fail(message: string): never { throw new WorkbookImportError(message); }
function crc32(bytes: Uint8Array): number { let c = 0xffffffff; for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
function archive(bytes: Uint8Array): Map<string, () => Uint8Array> {
  if (bytes.length > WORKBOOK_LIMITS.fileBytes) fail('Workbook exceeds the 16 MiB file limit.');
  const b = Buffer.from(bytes); if (b.length < 22 || b.readUInt32LE(0) !== 0x04034b50) fail('Use an unencrypted .xlsx file, not CSV, .xls, or a renamed file.');
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (b.readUInt32LE(i) === 0x06054b50 && i + 22 + b.readUInt16LE(i + 20) === b.length) { end = i; break; }
  if (end < 0) fail('Malformed ZIP directory.');
  const count = b.readUInt16LE(end + 10), offset = b.readUInt32LE(end + 16), size = b.readUInt32LE(end + 12);
  if (b.readUInt16LE(end + 4) || b.readUInt16LE(end + 6) || b.readUInt16LE(end + 8) !== count || count === 65535 || offset === 0xffffffff || size === 0xffffffff) fail('Split archives and ZIP64 are unsupported.');
  if (count > WORKBOOK_LIMITS.entries || offset + size !== end) fail('Invalid or oversized ZIP directory.');
  const entries: Entry[] = []; const ranges: [number,number][]=[]; const names = new Set<string>(); let at = offset, expanded = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || b.readUInt32LE(at) !== 0x02014b50) fail('Malformed ZIP entry.');
    const flags = b.readUInt16LE(at + 8), method = b.readUInt16LE(at + 10), crc = b.readUInt32LE(at + 16), packed = b.readUInt32LE(at + 20), length = b.readUInt32LE(at + 24);
    const n = b.readUInt16LE(at + 28), extra = b.readUInt16LE(at + 30), comment = b.readUInt16LE(at + 32), local = b.readUInt32LE(at + 42);
    // ZIP bits 1–2 are compression-level hints only for standard DEFLATE
    // (method 8). Keep allowing descriptors/UTF-8, but no encryption or
    // other flags, and keep comparing both copies of the actual flags.
    const allowedFlags = 0x808 | (method === 8 ? 0x6 : 0);
    if (at + 46 + n + extra + comment > end || (flags & ~allowedFlags) !== 0 || ![0, 8].includes(method) || b.readUInt16LE(at + 34)) fail('Encrypted or unsupported ZIP entry.');
    const name = b.subarray(at + 46, at + 46 + n).toString('utf8');
    if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').some(s => s === '..' || s === '.') || /[\x00-\x1f]/.test(name) || names.has(name)) fail('Unsafe or duplicate ZIP path.');
    names.add(name); expanded += length;
    if (length > WORKBOOK_LIMITS.entryBytes || expanded > WORKBOOK_LIMITS.expandedBytes || packed === 0xffffffff) fail('Workbook expansion exceeds safe limits.');
    if (local + 30 > offset || b.readUInt32LE(local) !== 0x04034b50 || b.readUInt16LE(local + 6) !== flags || b.readUInt16LE(local + 8) !== method) fail('Mismatched ZIP headers.');
    const localN = b.readUInt16LE(local + 26), start = local + 30 + localN + b.readUInt16LE(local + 28);
    if (start + packed > offset || b.subarray(local + 30, local + 30 + localN).toString('utf8') !== name) fail('Malformed ZIP payload.');
    if (!(flags & 8) && (b.readUInt32LE(local + 14) !== crc || b.readUInt32LE(local + 18) !== packed || b.readUInt32LE(local + 22) !== length)) fail('Mismatched ZIP sizes.');
    if(ranges.some(([a,z])=>local<z && start+packed>a)) fail('Overlapping ZIP entries are unsupported.');
    ranges.push([local,start+packed]);
    entries.push({ name, start, packed, size: length, method, crc }); at += 46 + n + extra + comment;
  }
  if (at !== end) fail('Unexpected ZIP directory data.');
  return new Map(entries.map(e => [e.name, () => {
    const input = b.subarray(e.start, e.start + e.packed);
    let out: Uint8Array;
    try { out = e.method === 0 ? input : inflateRawSync(input, { maxOutputLength: Math.max(1, e.size) }); }
    catch { return fail('Corrupt or over-expanded ZIP payload.'); }
    if (out.length !== e.size || crc32(out) !== e.crc) fail('ZIP integrity check failed.');
    return out;
  }]));
}

type Preflight = { candidates: WorksheetCandidate[]; date1904: boolean; raw: Map<string, Map<string,string>>; unsupported: Map<string,string>; styles: number[]; cellStyles: Map<string,Map<string,number>> };
function preflight(bytes: Uint8Array, filename: string): Preflight {
  if (!/\.xlsx$/i.test(filename)) fail('Choose .xlsx. CSV uses the existing import; .xls, .xlsm and .xlsb are unsupported.');
  const files = archive(bytes), candidates: WorksheetCandidate[] = [], relationships = new Map<string,{target:string; type:string}>();
  const raw = new Map<string,Map<string,string>>(), unsupported=new Map<string,string>(), cellStyles=new Map<string,Map<string,number>>(); const styles:number[]=[]; let isWorkbook = false, date1904 = false, totalCells = 0;
  for (const part of ['[Content_Types].xml','xl/workbook.xml','xl/_rels/workbook.xml.rels']) if (!files.has(part)) fail('Missing required XLSX workbook part.');
  for (const [name, unpack] of files) {
    if (/vbaProject|externalLinks|embeddings/i.test(name)) fail('Macros, external links and embedded objects are unsupported.');
    // Check actual expansion and CRC of EVERY part, even parts not selected.
    const data = unpack(); if (!/\.(xml|rels)$/i.test(name)) continue;
    let source: string; try { source = new TextDecoder('utf-8',{fatal:true}).decode(data); } catch { return fail('Only UTF-8 XLSX XML parts are supported.'); }
    if (source.includes('\0') || /<!DOCTYPE|<!ENTITY/i.test(source)) fail('DTD and entity declarations are not allowed.');
    if (/encoding\s*=\s*["'](?!utf-8["'])[a-z0-9-]+["']/i.test(source)) fail('Only UTF-8 XLSX XML parts are supported.');
    const parser = new SaxesParser({xmlns:true}); let depth = 0, rowCount = 0, cellCount = 0, nodes = 0, currentCell = '', capturingValue = false;
    const sheetValues = new Map<string,string>(), sheetStyles=new Map<string,number>(); let inCellXfs=false,maxRow=0,maxCol=0;
    const attr = (tag: any, key: string): string => String(tag.attributes[key]?.value ?? '');
    parser.on('error',()=>fail('Malformed XML inside workbook.'));
    parser.on('doctype',()=>fail('DTD is not allowed.'));
    parser.on('opentag',(tag:any)=>{
      if (++depth > 32 || ++nodes > 2_000_000) fail('Workbook XML exceeds safe limits.');
      if(name==='xl/styles.xml' && tag.local==='cellXfs') inCellXfs=true;
      if(inCellXfs && tag.local==='xf') styles.push(Number(attr(tag,'numFmtId')||'0'));
      if(/^xl\/worksheets\//.test(name) && ['f','mergeCell','hyperlink'].includes(tag.local)) unsupported.set(name,'Formulas, merged cells and hyperlinks are unsupported. Export calculated values as CSV.');
      if (tag.local === 'Relationship') {
        if (attr(tag,'TargetMode').toLowerCase()==='external') fail('External relationships are unsupported. Remove links or export CSV.');
        if (name === 'xl/_rels/workbook.xml.rels') {
          const id=attr(tag,'Id'), target=attr(tag,'Target');
          if (!id || relationships.has(id) || target.includes('\\') || target.split('/').includes('..') || /[:\x00-\x1f]/.test(target)) fail('Unsafe workbook relationship.');
          relationships.set(id,{target:target.startsWith('/') ? target.slice(1) : 'xl/'+target,type:attr(tag,'Type')});
        }
      }
      if (name === '[Content_Types].xml' && tag.local === 'Override' && attr(tag,'PartName') === '/xl/workbook.xml') isWorkbook = attr(tag,'ContentType') === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
      if (name === 'xl/workbook.xml' && tag.local === 'workbookPr') date1904 = ['1','true'].includes(attr(tag,'date1904'));
      if (name === 'xl/workbook.xml' && tag.local === 'sheet') {
        const id=attr(tag,'r:id'), title=attr(tag,'name'), visibility=attr(tag,'state') || 'visible';
        if (!id || !title || candidates.some(c=>c.id===id || c.name===title) || !['visible','hidden','veryHidden'].includes(visibility)) fail('Invalid worksheet identity.');
        candidates.push({id,name:title,visibility:visibility as WorksheetCandidate['visibility'],selectable:visibility==='visible'});
      }
      if (/^xl\/worksheets\//.test(name) && tag.local === 'row') {
        const index=Number(attr(tag,'r')); if (++rowCount > WORKBOOK_LIMITS.rows || !Number.isInteger(index) || index < 1 || index > WORKBOOK_LIMITS.rows) fail('Worksheet exceeds the row limit.');
      }
      if (/^xl\/worksheets\//.test(name) && tag.local === 'c') {
        const ref=attr(tag,'r'), match=/^([A-Z]+)([1-9]\d*)$/.exec(ref); let col=0;
        if (match) for(const letter of match[1]) col=col*26+letter.charCodeAt(0)-64;
        if (!match || col>WORKBOOK_LIMITS.columns || Number(match[2])>WORKBOOK_LIMITS.rows || ++cellCount>WORKBOOK_LIMITS.cells || ++totalCells>WORKBOOK_LIMITS.cells || sheetValues.has(ref)) fail('Worksheet exceeds cell limits or contains invalid cell references.');
        maxRow=Math.max(maxRow,Number(match![2]));maxCol=Math.max(maxCol,col);
        if(maxRow*maxCol>WORKBOOK_LIMITS.cells) fail('Worksheet rectangular area exceeds the cell limit.');
        if(['e','str','d'].includes(attr(tag,'t'))) unsupported.set(name,'Error, formula-string and explicit ISO date cells are unsupported. Export CSV.');
        const style=Number(attr(tag,'s')||'0'); if(!Number.isInteger(style)||style<0) fail('Invalid cell style.');
        sheetStyles.set(ref,style); currentCell=ref; sheetValues.set(ref,'');
      }
      if (currentCell && tag.local==='v') capturingValue=true;
    });
    parser.on('text',(text:string)=>{ if(text.length>WORKBOOK_LIMITS.text) fail('Cell text exceeds the limit.'); if(capturingValue) sheetValues.set(currentCell,(sheetValues.get(currentCell)??'')+text); });
    parser.on('closetag',(tag:any)=>{depth--; if(tag.local==='cellXfs') inCellXfs=false; if(tag.local==='v') capturingValue=false; if(tag.local==='c') currentCell='';});
    try { parser.write(source).close(); } catch (e) { if(e instanceof WorkbookImportError) throw e; fail('Malformed XML inside workbook.'); }
    if (/^xl\/worksheets\//.test(name)) {raw.set(name,sheetValues);cellStyles.set(name,sheetStyles);}
  }
  if (!isWorkbook || !candidates.length) fail('Not a supported XLSX workbook.');
  for(const c of candidates) {
    const rel=relationships.get(c.id); if(!rel || !files.has(rel.target)) fail('Worksheet relationship is missing.');
    c.selectable=c.selectable && /\/worksheet$/.test(rel.type);
    if(unsupported.has(rel.target)) unsupported.set(c.id,unsupported.get(rel.target)!);
    const cs=cellStyles.get(rel.target);if(cs)cellStyles.set(c.id,cs);
    const values=raw.get(rel.target); if(values) raw.set(c.id,values);
  }
  return { candidates,date1904,raw,unsupported,styles,cellStyles };
}

export function inspectWorksheets(bytes: Uint8Array, filename: string): WorksheetCandidate[] {
  return preflight(bytes,filename).candidates;
}

/** Explicit selection only. Returned CSV must enter existing GT detection,
 * validation and review unchanged. Excel wall-clock dates have no timezone:
 * omit Z, letting GT apply its existing UTC+8 semantics downstream.
 * Formulas are never evaluated and cached results are deliberately not trusted.
 */
export async function selectedWorksheet(bytes: Uint8Array, filename: string, sheetId: string): Promise<{text:string; name:string}> {
  const checked=preflight(bytes,filename), selected=checked.candidates.find(c=>c.id===sheetId);
  if(!selected?.selectable) fail('Select a visible worksheet from this workbook before preview.');
  if(checked.unsupported.has(sheetId)) fail(checked.unsupported.get(sheetId)!);
  let rows: SheetData<number>;
  try { rows=await readSheet(Buffer.from(bytes),selected.name,{trim:false}); }
  catch { return fail('The XLSX workbook could not be read. Export the selected sheet as CSV.'); }
  if(rows.length>WORKBOOK_LIMITS.rows) fail('Worksheet exceeds row limit.');
  const quote=(s:string)=>/[",\r\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;
  const address=(row:number,col:number)=>{let letters='';for(let n=col+1;n;n=Math.floor((n-1)/26))letters=String.fromCharCode(65+(n-1)%26)+letters;return letters+(row+1);};
  let outputBytes=0;
  const text = rows.map((row,r)=>{
    if(row.length>WORKBOOK_LIMITS.columns) fail('Worksheet exceeds column limit.');
    return row.map((value,c)=>{
      let text=''; const ref=address(r,c), style=checked.cellStyles.get(sheetId)?.get(ref)??0;
      const fmt=checked.styles[style]??(style===0?0:-1);
      if(value==null) text='';
      else if(typeof value==='string') text=value;
      else if(typeof value==='boolean') text=value?'TRUE':'FALSE';
      else if(value instanceof Date) {
        const original=Number(checked.raw.get(sheetId)?.get(ref));
        // Only built-in unambiguous calendar dates are supported. Time-only or
        // custom/localized formats cannot be normalized faithfully without policy.
        if(![14,15,16,17,22].includes(fmt)||!Number.isFinite(original)||original<1||(!checked.date1904&&original<61)||Number.isNaN(value.getTime())) fail('Unsupported date format or early Excel date. Export a corrected CSV.');
        const iso=value.toISOString();text=iso.slice(0,10)+(iso.slice(11,23)==='00:00:00.000'?'':' '+iso.slice(11,23).replace(/\.000$/,''));
      } else if(typeof value==='number') {
        if(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER) fail('Numeric cell exceeds safe precision. Store identifiers as text.');
        if(![0,1,2,49].includes(fmt)) fail('Ambiguous formatted number. Export CSV to preserve currency, percentage or leading-zero formatting.');
        text=String(value);
      } else fail('Unsupported cell value. Export CSV.');
      if(text.length>WORKBOOK_LIMITS.text) fail('Cell text exceeds limit.');
      const escaped=quote(text); outputBytes+=Buffer.byteLength(escaped,'utf8')+1;
      if(outputBytes>WORKBOOK_LIMITS.outputBytes) fail('Converted worksheet exceeds the 16 MiB CSV limit.');
      return escaped;
    }).join(',');
  }).join('\n');
  return { text, name: selected.name };
}
export async function selectedWorksheetCsv(bytes: Uint8Array, filename: string, sheetId: string): Promise<string> {
  return (await selectedWorksheet(bytes, filename, sheetId)).text;
}
