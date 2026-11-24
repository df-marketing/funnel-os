import zipfile, io, pathlib, sys
out=pathlib.Path(sys.argv[1]);out.mkdir(parents=True, exist_ok=True)
ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
rels='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
def fixture(name,cell='<c r="A1" t="inlineStr"><is><t>phone</t></is></c><c r="B1" t="inlineStr"><is><t>amount</t></is></c>',data='<c r="A2" t="inlineStr"><is><t>001234</t></is></c><c r="B2"><v>0</v></c>',extra='',epoch=False,mut=None,method=zipfile.ZIP_DEFLATED):
 d={'[Content_Types].xml':f'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
 'xl/workbook.xml':f'<workbook xmlns="{ns}" xmlns:r="{rels}"><workbookPr date1904="{int(epoch)}"/><sheets><sheet name="Selected" sheetId="1" r:id="rId1"/><sheet name="Other" sheetId="2" r:id="rId2"/></sheets></workbook>',
 'xl/_rels/workbook.xml.rels':f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{rels}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="{rels}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
 'xl/worksheets/sheet1.xml':f'<worksheet xmlns="{ns}"><sheetData><row r="1">{cell}</row><row r="2">{data}</row></sheetData>{extra}</worksheet>',
 'xl/worksheets/sheet2.xml':f'<worksheet xmlns="{ns}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>OTHER ONLY</t></is></c></row></sheetData></worksheet>',
 'xl/styles.xml':f'<styleSheet xmlns="{ns}"><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="9"/></cellXfs></styleSheet>'}
 if mut: mut(d)
 b=io.BytesIO()
 with zipfile.ZipFile(b,'w',method) as z:
  for k,v in d.items():z.writestr(k,v)
 (out/(name+'.xlsx')).write_bytes(b.getvalue())
fixture('normal');fixture('date',data='<c r="A2" s="1"><v>45292.5</v></c>');fixture('date1904',data='<c r="A2" s="1"><v>1</v></c>',epoch=True)
fixture('formula',data='<c r="A2"><f>1+1</f><v>2</v></c>');fixture('merged',extra='<mergeCells><mergeCell ref="A1:B1"/></mergeCells>')
fixture('percent',data='<c r="A2" s="2"><v>0.5</v></c>');fixture('phantom',data='<c r="A2" s="1"><v>60</v></c>')
fixture('escaping',data='<c r="A2" t="inlineStr"><is><t> 零, &quot;quote&quot;\nline </t></is></c>')

fixture('stored',method=zipfile.ZIP_STORED)
fixture('attendance',cell='<c r="A1" t="inlineStr"><is><t>Round</t></is></c><c r="B1" t="inlineStr"><is><t>Attendee Email</t></is></c><c r="C1" t="inlineStr"><is><t>Join Time</t></is></c>',
        data='<c r="A2" t="inlineStr"><is><t>0127-01</t></is></c><c r="B2" t="inlineStr"><is><t>attendee@example.invalid</t></is></c><c r="C2" t="inlineStr"><is><t>2027-01-04 20:00:00</t></is></c>')
