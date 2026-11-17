import test from 'node:test';
import assert from 'node:assert/strict';
import {createUnderlineModel,underlineSelection,repairUnderlineRects} from '../src/underline-geometry.js';
import {underlineMetrics,underlineStroke} from '../src/annotation-style.js';
const item=(index,x,baseline,width=80,em=12,extra={})=>({index,textDivIndex:index,x,y:baseline-em*.8,width,height:em,baselineX:x,baselineY:baseline,angle:0,fontHeight:em,...extra});
const fragment=(index,x,y,width,height=12)=>({textDivIndex:index,x,y,width,height});
const center=region=>region.rect.y+region.rect.height-underlineMetrics(region.rect.height).inset;

test('DOM font-box shifts never change authored PDF baselines or selected endpoints',()=>{
 const model=createUnderlineModel([item(0,10,100),item(1,10,118),item(2,10,136)]);
 const {resolved}=underlineSelection([fragment(0,12,87,35,15),fragment(1,12,109,35,9),fragment(2,12,117,35,25)],model);
 assert.equal(resolved.length,3);
 resolved.forEach((region,i)=>{assert.ok(Math.abs(center(region)-[100,118,136][i]-3.36)<1e-8);assert.equal(region.rect.x,12);assert.equal(region.rect.width,35)});
});
test('small and modest-sized scripts inherit their full physical row',()=>{
 for(const em of [6.75,9,10]){
  const model=createUnderlineModel([item(0,10,100),item(1,90,95,5,em)]);
  const {resolved}=underlineSelection([fragment(1,90,86,5,em)],model);
  assert.equal(resolved.length,1);assert.equal(resolved[0].rect.height,12);assert.ok(Math.abs(center(resolved[0])-103.36)<1e-8);
 }
});
test('duplicate fragments form one stroke; adjacent columns and rows remain separate',()=>{
 const model=createUnderlineModel([item(0,10,100),item(1,200,100),item(2,10,118)]);
 const {resolved}=underlineSelection([fragment(0,10,80,70,24),fragment(0,10,88,70),fragment(1,200,88,70),fragment(2,10,106,70)],model);
 assert.equal(resolved.length,3);assert.deepEqual(resolved.map(r=>r.rect.width),[70,70,70]);
});
test('unmapped selected text stays available for fallback, without inventing whitespace strokes',()=>{
 const model=createUnderlineModel([item(0,10,100)]);
 const {resolved,unmatched}=underlineSelection([fragment(0,10,88,70),{...fragment(4,100,88,20),selectedText:'tilted'},{...fragment(5,120,88,10),selectedText:' '}],model);
 assert.equal(resolved.length,1);assert.equal(unmatched.length,1);assert.equal(unmatched[0].selectedText,'tilted');
});
test('legacy boxes repair only to a reliable physical row and keep unknown regions intact',()=>{
 const model=createUnderlineModel([item(0,10,100),item(1,10,118)]);
 const result=repairUnderlineRects([{x:12,y:87,width:35,height:14},{x:12,y:112,width:35,height:12},{x:400,y:400,width:20,height:10}],model);
 assert.equal(result.resolved.length,2);assert.equal(result.unmatched.length,1);
 assert.ok(Math.abs(center(result.resolved[0])-103.36)<1e-8);assert.ok(Math.abs(center(result.resolved[1])-121.36)<1e-8);
});
test('PDF strokes use thin point widths in every quarter turn',()=>{
 assert.ok(Math.abs(underlineMetrics(12).thickness-.42)<1e-8);
 for(const rotation of [0,90,180,270]){
  const stroke=underlineStroke(rotation%180?[0,0,12,100]:[0,0,100,12],rotation);
  assert.ok(Math.abs(stroke.thickness-.42)<1e-8);assert.equal(Math.hypot(stroke.end[0]-stroke.start[0],stroke.end[1]-stroke.start[1]),100);
 }
});
