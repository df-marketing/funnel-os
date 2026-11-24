import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { planImport, commitPlan, type Plan } from "../lib/import/pipeline";
import { inspectWorksheets, selectedWorksheetCsv } from "../lib/import/worksheets";

type Rows = Record<string, any[]>;
function ledger(seed: Rows = {}) {
  const tables: Rows = structuredClone(seed);
  const calls: string[] = [];
  const db = {
    from(name: string) {
      const rows = tables[name] ??= [];
      const filters: Array<(r: any) => boolean> = [];
      let pending: any, page: [number, number] | undefined;
      const matches = () => rows.filter(r => filters.every(f => f(r))).slice(page?.[0] ?? 0, page ? page[1]+1 : undefined);
      const q: any = {
        select: () => q, order: () => q,
        eq: (c: string,v: unknown) => {filters.push(r => r[c]===v);return q;},
        in: (c: string,v: unknown[]) => {filters.push(r => v.includes(r[c]));return q;},
        is: (c: string,v: unknown) => {filters.push(r => (r[c]??null)===v);return q;},
        not: (c: string) => {filters.push(r => r[c]!=null);return q;},
        range: (f: number,t: number) => {page=[f,t];return q;},
        update: (patch: unknown) => {pending=patch;return q;},
        insert: async (values: any) => {
          const newRows = Array.isArray(values)? values:[values];
          const pk = ({ ads_performance:"id",events:"event_id",contacts:"contact_id",unmatched_rows:"row_id" } as Record<string,string>)[name];
          if (pk && newRows.some(r => rows.some(old => old[pk]===r[pk]))) return {error:{code:"23505",message:"duplicate key"}};
          rows.push(...structuredClone(newRows)); return {error:null};
        },
        maybeSingle: async () => ({data:matches()[0]??null,error:null}),
        then: (resolve: (r:any)=>unknown) => {
          const found=matches(); if(pending) for(const row of found) Object.assign(row,structuredClone(pending));
          return Promise.resolve({data:structuredClone(found),error:null}).then(resolve);
        },
      };
      return q;
    },
    rpc: async (name:string) => {calls.push(name);return {data:null,error:null};},
  } as any;
  return {db,tables,calls};
}

const adHeader="Reporting starts,Reporting ends,Campaign name,Ad set name,Ad name,Ad ID,Amount spent (MYR),Impressions,Channel";
const a = "2026-05-01,2026-05-01,Campaign A,Set A,Creative A,123456789012345678,40,120,Meta";
const b = "2026-05-02,2026-05-02,Campaign A,Set A,Creative A,123456789012345678,50,135,Meta";
const c = "2026-05-03,2026-05-03,Campaign A,Set A,Creative A,123456789012345678,60,150,Meta";
const csv = (...rows:string[]) => [adHeader,...rows].join("\n");
const setup = () => ledger({
  rounds: [
    { round_id:"ident-r1", client_id:"synthetic-a", campaign:"Campaign A", campaigns:["Campaign A"], start_date:"2026-05-01", end_date:"2026-05-07" },
    { round_id:"ident-r2", client_id:"synthetic-b", campaigns:["Campaign A"], start_date:"2026-05-01", end_date:"2026-05-07" },
    { round_id:"ident-r3", client_id:"synthetic-a", start_date:"2026-05-08", end_date:"2026-05-14" },
  ],
  ads_performance:[], events:[], contacts:[], import_batches:[], unmatched_rows:[],
});
const plan = (l: ReturnType<typeof setup>, text:string, source:Plan["source"]="ads", clientId="synthetic-a", fileName="test.csv") =>
  planImport(l.db,{clientId,source,text,fileName});
const stage = (l: ReturnType<typeof setup>, p:Plan, id:string) => {
  l.tables.import_batches.push({batch_id:id,client_id:p.clientId,source:p.source,status:"staged",staged_payload:p});
  return commitPlan(l.db,id,p);
};
const sum = (rows:any[],key:string) => rows.reduce((n,r)=>n+Number(r[key]??0),0);

test("FWD-style ads repeats and reorder are no-op; partial overlap writes only new facts",async()=>{
  const l=setup(); await stage(l,await plan(l,csv(a,b)),"original");
  const repeat=await plan(l,csv(b,a),"ads","synthetic-a","different-name.csv");
  assert.equal(repeat.counts.duplicates,2);
  assert.deepEqual(await stage(l,repeat,"repeat"),{changed:false});
  assert.equal(l.calls.length,1);
  assert.equal(l.tables.import_batches[1].status,"discarded");
  assert.equal(l.tables.ads_performance.length,2);
  const overlap=await plan(l,csv(c,b));
  assert.equal(overlap.counts.duplicates,1);assert.equal(overlap.ops.ads.length,1);
  await stage(l,overlap,"overlap");assert.equal(sum(l.tables.ads_performance,"spend"),150);
});
test("overlap guard lives after conversion: XLSX → CSV and CSV → XLSX",async()=>{
  const file = Buffer.from(readFileSync(new URL("./import-idempotency-fixtures/meta.xlsx.base64",import.meta.url),"utf8"),"base64");
  const selected = inspectWorksheets(file,"meta.xlsx").find(s=>s.name==="Ads")!;
  const workbook = await selectedWorksheetCsv(file,"meta.xlsx",selected.id);
  for (const [first, second] of [[workbook,csv(b,a)],[csv(b,a),workbook]]) {
    const l=setup(); await stage(l,await plan(l,first),"original");
    const p=await plan(l,second,"ads","synthetic-a","re-export.xlsx");
    assert.equal(p.counts.duplicates,2);
    await stage(l,p,"next");assert.equal(sum(l.tables.ads_performance,"spend"),90);
  }
});
test("same stored key correction refuses without mutating either original or new rows",async()=>{
  const l=setup(); await stage(l,await plan(l,csv(a)),"original");
  await assert.rejects(plan(l,csv(c,a.replace(",40,",",999,"))),/changes a measurement/);
  assert.equal(sum(l.tables.ads_performance,"spend"),40);
  await assert.rejects(plan(l,csv(a.replace("Creative A","Renamed"))),/different names/);
  await assert.rejects(plan(l,csv(a.replace("120","121"))),/changes a measurement/);
});
test("different clients and rounds remain distinct and names containing delimiters never collide",async()=>{
  const l=setup(); await stage(l,await plan(l,csv(a)),"a");
  await stage(l,await plan(l,csv(a),"ads","synthetic-b"),"b");
  await stage(l,await plan(l,csv(a.replaceAll("05-01","05-08"))),"c");
  const d=csv(a.replace("Campaign A,Set A,Creative A,123456789012345678","Campaign|A,Set,Ad,"),
              a.replace("Campaign A,Set A,Creative A,123456789012345678","Campaign,A|Set,Ad,"));
  await stage(l,await plan(l,d),"d");
  assert.equal(l.tables.ads_performance.length,5);
  assert.equal(new Set(l.tables.ads_performance.map(r=>r.id)).size,5);
});
test("stale independent ads plans refuse; deterministic ID is stable across separately staged plans",async()=>{
  const l=setup();const p=await plan(l,csv(a));const q=await plan(l,csv(a));
  assert.equal(p.ops.ads[0].id,q.ops.ads[0].id);
  await stage(l,p,"p"); await assert.rejects(stage(l,q,"q"),/changed since this preview/);
  assert.equal(l.tables.ads_performance.length,1);
  const l2=setup(), p2=await plan(l2,csv(a)),q2=await plan(l2,csv(a));
  const results=await Promise.allSettled([stage(l2,p2,"p"),stage(l2,q2,"q")]);
  assert.equal(results.filter(x=>x.status==="fulfilled").length,1);
  assert.equal(l2.tables.ads_performance.length,1);
});
test("observable overlapping reporting windows and same-day aggregate/detailed conflicts are refused",async()=>{
  const l=setup(); await stage(l,await plan(l,csv(b)),"original");
  await assert.rejects(plan(l,csv(a.replace("01,2026-05-01","01,2026-05-03"))),/overlaps/);
  await assert.rejects(plan(l,csv(b.replace("Set A,Creative A,123456789012345678",",,"))),/mixes totals/);
  await assert.rejects(plan(setup(),csv(a,a.replace("01,2026-05-01","01,2026-05-03"))),/different date windows/);
});
test("lead, form answer, attendance, sale repeats and sale conflict use persisted facts",async()=>{
  const l=setup();
  const lead="email,event_date,round_id,Example question\na@example.test,2026-05-02,ident-r1,yes";
  const attendance="email,round_id,event_date\na@example.test,ident-r1,2026-05-03";
  const sales="email,event_date,product,amount\na@example.test,2026-05-03,preview,297";
  for(const [type, text] of [["leads",lead],["attendance",attendance],["sales",sales]] as const){
    await stage(l,await plan(l,text,type),type);
    const repeat=await plan(l,text,type);
    assert.equal(repeat.counts.duplicates,1);
    assert.deepEqual(await stage(l,repeat,type+"-repeat"),{changed:false});
  }
  const form="email,event_date,Another question\na@example.test,2026-05-02,kept";
  await stage(l,await plan(l,form,"leads"),"form");
  assert.deepEqual(await stage(l,await plan(l,form,"leads"),"form-repeat"),{changed:false});
  assert.equal(l.tables.contacts.length,1); assert.equal(l.tables.events.length,3);
  assert.deepEqual(l.tables.events.find(r=>r.event_type==="lead").answers,{"Example question":"yes","Another question":"kept"});
  await assert.rejects(plan(l,sales.replace("297","298"),"sales"),/differs in amount/);
  assert.equal(sum(l.tables.events,"amount"),297);
});
test("partial same-window parked import neither retires unseen rows nor doubles unchanged evidence",async()=>{
  const l=setup();
  const head="email,event_date,product,amount,Notes";
  const original=[head,"a@example.test,2026-05-15,preview,10,first","b@example.test,2026-05-16,preview,20,unseen","c@example.test,2026-05-17,preview,30,last"].join("\n");
  await stage(l,await plan(l,original,"sales"),"old");
  const partial=[head,"a@example.test,2026-05-15,preview,10,revised note","d@example.test,2026-05-17,preview,40,new buyer"].join("\n");
  await stage(l,await plan(l,partial,"sales"),"partial");
  const waiting=()=>l.tables.unmatched_rows.filter(r=>!r.resolved_at);
  assert.equal(waiting().length,4); assert.equal(sum(waiting(),"revenue_held"),100);
  const round=l.tables.rounds[2]; round.end_date="2026-05-15";
  const nowMatched=await plan(l,[head,"a@example.test,2026-05-15,preview,10,first"].join("\n"),"sales");
  assert.equal(nowMatched.ops.supersededParked.length,1);
  await stage(l,nowMatched,"superseding");
  assert.equal(waiting().length,3); assert.equal(sum(waiting(),"revenue_held"),90);
  assert.equal(sum(l.tables.events,"amount"),10);
});

test("prepatch random-ID ads plans must be re-previewed",async()=>{
  const l=setup(), p=await plan(l,csv(a));
  p.ops.ads[0].id="00000000-0000-4000-8000-000000000001";
  await assert.rejects(stage(l,p,"old"),/predates duplicate protection/);
  assert.equal(l.tables.ads_performance.length,0);
});
test("a legacy missing optional metric cannot be silently overwritten",async()=>{
  const l=setup();
  await stage(l,await plan(l,csv(a.replace(",120,",",,"))),"legacy");
  await assert.rejects(plan(l,csv(a)),/changes a measurement/);
  assert.equal(l.tables.ads_performance[0].impressions,null);
});
test("reach-only historical Meta row complements detailed ad delivery",async()=>{
  const l=setup();
  l.tables.ads_performance.push({id:"reach",round_id:"ident-r1",date:"2026-05-01",campaign:"Campaign A",
    ad_set:null,ad:null,spend:null,impressions:null,reach:400,clicks:null,channel:"meta"});
  await stage(l,await plan(l,csv(a)),"delivery");
  assert.equal(l.tables.ads_performance.length,2);
  assert.equal(sum(l.tables.ads_performance,"spend"),40);
  assert.equal(sum(l.tables.ads_performance,"reach"),400);
});

test("fresh later rows against unknown earlier historical windows carry an actionable scoped warning",async()=>{
  const l=setup();
  await stage(l,await plan(l,csv(a.replace("01,2026-05-01","01,2026-05-07"))),"period");
  const p=await plan(l,csv(b,c));
  const warning=p.warnings.filter(x=>x.includes("no stored reporting end"));
  assert.equal(warning.length,1);
  assert.match(warning[0],/Before committing, verify the prior export/);
  assert.equal(p.ops.ads.length,2);
  const other=await plan(l,csv(b),"ads","synthetic-b");
  assert.equal(other.warnings.some(x=>x.includes("no stored reporting end")),false);
  const otherSeries=await plan(l,csv(b.replace("Campaign A","Campaign B").replace("123456789012345678","123")),"ads");
  assert.equal(otherSeries.warnings.some(x=>x.includes("no stored reporting end")),false);
});
test("blank vs explicit zero is conflicting refund intent in either row order",async()=>{
  const l=setup();
  const header="email,event_date,product,amount,refund_amount,refund_date";
  const sale="a@example.test,2026-05-03,preview,297";
  const data=(...rows:string[])=>[header,...rows].join("\n");
  await stage(l,await plan(l,data(sale+",17,2026-05-04"),"sales"),"original");
  for (const rows of [[sale+",,",sale+",0,"],[sale+",0,",sale+",,"]]) {
    await assert.rejects(plan(l,data(...rows),"sales"),/conflicting sales/);
    assert.equal(l.tables.events[0].refund_amount,17);
    assert.equal(l.tables.events[0].refund_date,"2026-05-04");
  }
  assert.deepEqual(await stage(l,await plan(l,data(sale+",,"),"sales"),"omitted"),{changed:false});
  assert.equal(l.tables.events[0].refund_amount,17);
  await assert.rejects(plan(l,data(sale+",17,2026-05-05"),"sales"),/different refund date/);
  assert.equal(l.tables.events[0].refund_date,"2026-05-04");
});

const leads = (...rows:string[]) => ["Email,Opt-in Date,Round,Ad set", ...rows].join("\n");
const verifiedSource = () => ledger({
  rounds: [
    { round_id:"july", code:"0726-99", client_id:"synthetic-a", start_date:"2026-07-01", end_date:"2026-07-31" },
    { round_id:"nov-a", code:"1126-99", client_id:"synthetic-a", market:"SG", start_date:"2026-11-01", end_date:"2026-11-12" },
    { round_id:"foreign", code:"1126-88", client_id:"synthetic-b", start_date:"2026-11-12", end_date:"2026-11-30" },
  ],
  ads_performance: [{round_id:"july",date:"2026-07-20",ad_set:"Past ad"}],
  events:[], contacts:[], import_batches:[], unmatched_rows:[],
});

test("Guards refuse the whole file outside all windows, even with an old matching ad set", async()=>{
  const l = verifiedSource();
  await assert.rejects(plan(l,leads(
    "valid@example.invalid,2026-07-20,,",
    "private@example.invalid,2026-11-13,,Past ad",
  ),"leads"), (err: any) => {
    assert.match(err.message,/1 row needs/);
    assert.deepEqual(err.detail, ["Data row 2: no unique round covers this opt-in date; check the date or add the correct Round ID or code."]);
    assert.doesNotMatch(JSON.stringify(err), /private@example/);
    return true;
  });
  assert.equal(l.tables.contacts.length,0);
  assert.equal(l.tables.events.length,0);
  assert.equal(l.tables.import_batches.length,0);
});
test("Unknown, foreign, substring and ambiguous explicit Round IDs never fall back",async()=>{
  const l=verifiedSource();
  for (const ref of ["typo","foreign","1126-88","list 1126-99","2026-11-12"]) {
    await assert.rejects(plan(l,leads(`fixture@example.invalid,2026-11-12,${ref},`),"leads"), /Leads import blocked/);
  }
  l.tables.rounds.push({round_id:"nov-b",code:"1126-99",client_id:"synthetic-a",market:"MY",start_date:"2026-11-01",end_date:"2026-11-12"});
  await assert.rejects(plan(l,leads("fixture@example.invalid,2026-11-12,1126-99,"),"leads"), /Leads import blocked/);
  const exact = await plan(l,leads("fixture@example.invalid,2026-11-12,nov-a,"),"leads");
  assert.equal(exact.ops.events[0].round_id,"nov-a");
});
test("Unambiguous in-window ad-set match can resolve overlap but stale or shared tags cannot",async()=>{
  const l=verifiedSource();
  l.tables.rounds.push({round_id:"nov-b",code:"1126-98",client_id:"synthetic-a",start_date:"2026-11-05",end_date:"2026-11-12"});
  const text=(adSet:string)=>leads(`fixture@example.invalid,2026-11-12,,${adSet}`);
  for (const tag of ["", "Past ad"]) await assert.rejects(plan(l,text(tag),"leads"), /Leads import blocked/);
  l.tables.ads_performance.push({round_id:"nov-a",date:"2026-07-23",ad_set:"Previous run"});
  await assert.rejects(plan(l,text("Previous run"),"leads"), /Leads import blocked/);
  l.tables.ads_performance.push({round_id:"nov-a",date:"2026-11-10",ad_set:"Real run"});
  const fresh=await plan(l,text("Real run"),"leads");
  assert.equal(fresh.ops.events[0].round_id,"nov-a");
  assert.equal(fresh.ops.events[0].attribution_method,"utm");
  l.tables.ads_performance.push({round_id:"nov-b",date:"2026-11-10",ad_set:"Real run"});
  await assert.rejects(plan(l,text("Real run"),"leads"), /Leads import blocked/);
});
test("Explicit confirmed Round and true date work without ads; destinations show real dates outside its window",async()=>{
  const l=verifiedSource(); l.tables.ads_performance.length=0;
  const p=await plan(l,leads(
    "nov@example.invalid,2026-11-12,1126-99,",
    "dec@example.invalid,2026-12-01,1126-99,",
    "nov@example.invalid,2026-11-12,1126-99,",
    "july@example.invalid,2026-07-02,,"
  ),"leads");
  assert.deepEqual(p.leadRoundGuard?.destinations, [
    {roundId:"july",label:"0726-99",count:1,declaredOutsideWindow:0},
    {roundId:"nov-a",label:"1126-99 · SG",count:2,declaredOutsideWindow:1},
  ]);
  assert.match(p.prerequisite ?? "",/valid explicit Round still works/);
  assert.equal(p.counts.duplicates,1);
  assert.deepEqual(await stage(l,p,"verified"),{changed:true});
  assert.equal(l.tables.events.length,3);
  assert.equal(l.tables.events.every(row=>row.import_batch_id==="verified"),true);
});
test("Real lead dates are required without normalizing impossible calendar dates",async()=>{
  const l=verifiedSource();
  for (const date of ["", "2026-11-31", "2026-02-30T15:00:00+08:00", "2026-14-12", "November 2026", "2026-11-12 10:60:00"]) {
    await assert.rejects(plan(l,leads(`fixture@example.invalid,${date},1126-99,`),"leads"), (err: any) => {
      assert.match(err.detail?.[0],/missing or invalid opt-in date/);
      return true;
    });
  }
  const local=await plan(l,leads("fixture@example.invalid,2026-11-11T18:00:00Z,,"),"leads");
  assert.equal(local.ops.events[0].round_id,"nov-a");
  assert.equal(local.ops.events[0].event_date,"2026-11-11T18:00:00.000Z");
});
test("Old and invalidated Leads plans cannot write any contacts, events or refreshes",async()=>{
  const l=verifiedSource();
  const text=leads("fixture@example.invalid,2026-11-12,,");
  const old=await plan(l,text,"leads");
  delete old.leadRoundGuard;
  await assert.rejects(stage(l,old,"old"), /predates round validation/);
  const fresh=await plan(l,text,"leads");
  l.tables.rounds[1].end_date="2026-11-11";
  await assert.rejects(stage(l,fresh,"stale"), /no longer valid/);
  assert.deepEqual(l.tables.contacts,[]);
  assert.deepEqual(l.tables.events,[]);
  assert.deepEqual(l.calls,[]);
});
test("Commit also refuses outdated outside-window counts for explicit destinations",async()=>{
  const l=verifiedSource();
  const p=await plan(l,leads("fixture@example.invalid,2026-11-12,1126-99,"),"leads");
  l.tables.rounds[1].end_date="2026-11-11";
  await assert.rejects(stage(l,p,"changed"), /destinations changed since preview/);
  assert.equal(l.tables.events.length,0);
});
