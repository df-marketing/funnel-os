import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {inspectWorksheets,selectedWorksheetCsv,WorkbookImportError} from '../lib/import/worksheets.ts';
import {parseTable,parseCsv} from '../lib/import/csv.ts';
const fixtureDir = process.env.GT_WORKSHEET_FIXTURES;
if (!fixtureDir) throw new Error('Set GT_WORKSHEET_FIXTURES to generated test workbooks.');
const file=(n='normal')=>readFileSync(join(fixtureDir, `${n}.xlsx`));
test('enumeration and explicit selection, only selected sheet converted',async()=>{assert.deepEqual(inspectWorksheets(file(),'x.xlsx').map(x=>x.name),['Selected','Other']);await assert.rejects(selectedWorksheetCsv(file(),'x.xlsx',''),WorkbookImportError);assert.equal(await selectedWorksheetCsv(file(),'x.xlsx','rId2'),'OTHER ONLY');});
test('zero and textual phone leading zeros survive CSV pipeline',async()=>{assert.deepEqual(parseCsv(await selectedWorksheetCsv(file(),'x.xlsx','rId1')).rows,[{phone:'001234',amount:'0'}]);});
test('date wall clock has no UTC suffix, both epochs',async()=>{assert.match(await selectedWorksheetCsv(file('date'),'x.xlsx','rId1'),/2024-01-01 12:00:00/);assert.match(await selectedWorksheetCsv(file('date1904'),'x.xlsx','rId1'),/1904-01-02/);});
test('Unicode quotes comma newline preserved',async()=>{assert.equal(parseTable(await selectedWorksheetCsv(file('escaping'),'x.xlsx','rId1'))[1][0],' 零, "quote"\nline ');});
for(const n of ['formula','merged','percent','phantom'])test(`selected unsupported ${n}`,async()=>{await assert.rejects(selectedWorksheetCsv(file(n),'x.xlsx','rId1'),WorkbookImportError);assert.equal(await selectedWorksheetCsv(file(n),'x.xlsx','rId2'),'OTHER ONLY');});
test('extensions and renamed nonzip rejected',()=>{for(const ext of ['csv','xls','xlsm','xlsb'])assert.throws(()=>inspectWorksheets(file(),`x.${ext}`),WorkbookImportError);assert.throws(()=>inspectWorksheets(Buffer.from('a,b\n1,2'),'x.xlsx'),WorkbookImportError);});
test('existing CSV regression BOM, CRLF, escaped quotes, commas, newline',()=>assert.deepEqual(parseTable('\ufeffa,b\r\n"x,y","z""q\nnext"\r\n'),[['a','b'],['x,y','z"q\nnext']]));

// The fixtures are plain synthetic ZIPs. Mark their compression hints in both
// headers without changing the compressed payload, its sizes, or its CRC.
function fixtureWithFlags(name: string, centralFlags: number, localFlags = centralFlags): Buffer {
  const bytes = file(name);
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  for (let at = bytes.readUInt32LE(end + 16); at < end; ) {
    assert.equal(bytes.readUInt32LE(at), 0x02014b50);
    const local = bytes.readUInt32LE(at + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    bytes.writeUInt16LE(bytes.readUInt16LE(at + 8) | centralFlags, at + 8);
    bytes.writeUInt16LE(bytes.readUInt16LE(local + 6) | localFlags, local + 6);
    at += 46 + bytes.readUInt16LE(at + 28) + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return bytes;
}

for (const flags of [0x2, 0x4, 0x6, 0x806]) {
  test(`DEFLATE hints 0x${flags.toString(16)} keep sheet selection and attendance columns intact`, async () => {
    const workbook = fixtureWithFlags('attendance', flags);
    assert.deepEqual(inspectWorksheets(workbook, 'attendance.xlsx').map(s => s.name), ['Selected', 'Other']);
    await assert.rejects(selectedWorksheetCsv(workbook, 'attendance.xlsx', ''), /Select a visible worksheet/);
    assert.deepEqual(parseTable(await selectedWorksheetCsv(workbook, 'attendance.xlsx', 'rId1')), [
      ['Round', 'Attendee Email', 'Join Time'], ['0127-01', 'attendee@example.invalid', '2027-01-04 20:00:00'],
    ]);
    assert.equal(await selectedWorksheetCsv(workbook, 'attendance.xlsx', 'rId2'), 'OTHER ONLY');
  });
}
test('stored entries remain supported but must not set DEFLATE-only hints', async () => {
  assert.equal(await selectedWorksheetCsv(file('stored'), 'stored.xlsx', 'rId2'), 'OTHER ONLY');
  for (const flags of [0x2, 0x4, 0x6]) {
    assert.throws(() => inspectWorksheets(fixtureWithFlags('stored', flags), 'stored.xlsx'), /Encrypted or unsupported ZIP entry/);
  }
});
test('compression hints do not allow encryption or another unsupported option', () => {
  for (const flags of [0x7, 0x16, 0x46]) {
    assert.throws(() => inspectWorksheets(fixtureWithFlags('normal', flags), 'x.xlsx'), /Encrypted or unsupported ZIP entry/);
  }
});
test('ZIP local and central compression hints must agree', () => {
  assert.throws(() => inspectWorksheets(fixtureWithFlags('normal', 0x6, 0x2), 'x.xlsx'), /Mismatched ZIP headers/);
});
