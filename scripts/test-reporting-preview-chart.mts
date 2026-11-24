import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Cut } from "../lib/funnel/data";
import { SpineChart } from "../components/SpineChart";
import {
  chartModel, floorY, lineRuns, previewCell, ticksFor, valueY,
  type PreviewVsOption, type VsKey,
} from "../lib/funnel/chart";

const cut = (name:string, m:Record<string,string|number|null>): Cut =>
  ({cut_key:name,cut_label:name,cut_sub:null,m});
const render = (cuts:Cut[], vs:VsKey, option?:PreviewVsOption, reportingPreview=true) =>
  renderToStaticMarkup(createElement(SpineChart,{
    title:"Synthetic chart",sub:"Synthetic unit test", cuts, vs, reportingPreview,
    model: option ? chartModel(cuts,vs,{reportingPreview:true,option}) : undefined,
  }));

const readNum = (html:string, attr:string) => Number(html.match(new RegExp(`${attr}="([^"]+)"`))?.[1]);
const point=(html:string, tag:"circle"|"rect", field:string, column:string, value:number) => {
  const el = [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`,"g"))]
    .find(m=>m[0].includes(`data-column="${column}"`) && m[0].includes(`data-value="${value}"`))?.[0];
  assert.ok(el,`missing ${tag} for ${column} / ${value}`);
  return readNum(el,field);
};

test("mixed signed ROAS and its revenue companion share exact zero and preserve measured zero",()=>{
  const cuts=[cut("refund",{spend:100,rev:-200,roas:-2}),
    cut("zero",{spend:20,rev:0,roas:0}),cut("missing",{}),cut("sale",{spend:100,rev:150,roas:1.5})];
  const m=chartModel(cuts,"roas",{reportingPreview:true});
  assert.ok(m.left.min!<0&&m.right.min!<0);
  assert.equal(m.amount?.min,m.left.min);
  assert.equal(m.amount?.max,m.left.max);
  assert.equal(valueY(0,m.left.max,m.left.min),valueY(0,m.right.max,m.right.min));
  assert.deepEqual(m.blanks,["missing"]);
  assert.deepEqual(lineRuns(m.right.points,m.right.max,m.right.min).map(r=>r.length),[2,1]);
  assert.deepEqual(ticksFor(m.right.max,m.right.min),[-2,-1,0,1,2]);
  const html=render(cuts,"roas");
  const zero=readNum(html,"data-zero-y");
  assert.ok(point(html,"circle","cy","refund",-2)>zero);
  assert.equal(point(html,"circle","cy","zero",0),zero);
  assert.ok(point(html,"circle","cy","sale",1.5)<zero);
  assert.equal(point(html,"rect","y","refund",-200),zero);
  assert.ok(point(html,"rect","height","refund",-200)>0);
  assert.equal(point(html,"rect","height","zero",0),2);
  assert.doesNotMatch(html,/data-column="missing"/);
});
test("all negative axis still spans signed values; positive-only path stays at floor zero",()=>{
  const negative=chartModel([cut("neg",{rev:-7}),cut("lower",{rev:-10})],"rev",{reportingPreview:true});
  const y=(v:number)=>valueY(v,negative.right.max,negative.right.min);
  assert.ok(y(-10)>y(-7)&&y(-7)>y(0));
  const positive=chartModel([cut("positive",{leads:8}),cut("zero",{leads:0})],"leads",{reportingPreview:true});
  assert.equal(positive.right.min,0);
  assert.equal(valueY(0,positive.right.max,positive.right.min),floorY());
});
test("companion-only, including true zero, is not called unmeasured",()=>{
  const cuts=[cut("Companion measured",{att:0}),cut("All absent",{att:null,cpAtt:null,spend:null})];
  const m=chartModel(cuts,"cpAtt",{reportingPreview:true});
  assert.deepEqual(m.blanks,["All absent"]);
  const html=render(cuts,"cpAtt");
  assert.match(html,/Nothing recorded at all for <b>All absent<\/b>/);
  assert.doesNotMatch(html,/Nothing recorded at all for <b>Companion measured/);
  assert.equal(point(html,"rect","height","Companion measured",0),2);
  assert.equal([...html.matchAll(/class="chart-gap"/g)].length,1);
});
test("configured metric reuses table projection, preserves fractions, and refuses blank/corrupt input",()=>{
  const selected:PreviewVsOption={key:"stage:qualified_sessions",metric:"qualified",short:"Qualified",label:"Qualified sessions",
    fmt:"i",kind:"amount",betterWhen:"higher"};
  const cuts=[cut("partial",{qualified:"0.5",leads:20}),cut("small",{qualified:"0.0001"}),
    cut("absent",{qualified:"  ",leads:20}),cut("invalid",{qualified:"invalid"}),cut("zero",{qualified:"0"})];
  const preview=chartModel(cuts,"leads",{reportingPreview:true,option:selected});
  assert.deepEqual(preview.right.points.map(p=>p.value),[0.5,0.0001,null,null,0]);
  const html=render(cuts,"leads",selected);
  assert.match(html,/Qualified sessions/);
  assert.match(html,/>0\.5<\/text>/);
  assert.match(html,/>0\.0001<\/text>/);
  assert.equal(previewCell(-0.004,"d1"),"-0.004");
  assert.doesNotMatch(html,/data-column="absent"|data-column="invalid"/);
  assert.equal(render(cuts,"leads",selected,false),render(cuts,"leads",undefined,false));
  assert.doesNotMatch(render(cuts,"leads",undefined,false),/data-reporting-preview|Qualified sessions/);
});
