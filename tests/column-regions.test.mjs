import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadingRegions } from '../src/column-regions.js';
import { buildColumnFixture } from './column-fixture.mjs';

const bounds={x:40,y:0,width:520,height:792};
const row=(text,x,y,width=190,em=10,flow=true)=>({text,box:{x,y,width,height:em},baseline:y+em*.8,em,flow});
function model(records,extra=[]) {
  const tree=createReadingRegions(records,{bounds,em:10});
  const lines=[...records,...extra].map(record=>({...record}));
  tree.assignOrder(lines,line=>line.box);
  return {tree,lines,ordered:[...lines].sort((a,b)=>a.readingOrder-b.readingOrder)};
}
test('a left aligned running footer is read after both columns, not as the left column continuation',()=>{
  const left=[100,120,670,690].map((y,i)=>row(`L${i}`,50,y));
  const right=[100,120,670,690].map((y,i)=>row(`R${i}`,330,y));
  const footer=[row('publisher line',50,733,210),row('12',295,733,10,10,false),row('reference line',50,745,140)];
  for(const records of [[...left,...right,...footer],[...footer,...right.toReversed(),...left.toReversed()]]){
    const result=model(records);
    assert.deepEqual(result.ordered.map(line=>line.text),[...left,...right,...footer].map(line=>line.text));
    assert.notEqual(result.ordered[0].flowId,result.ordered.at(-1).flowId);
  }
});
test('root sequence captions and footers have distinct flows while each real column remains continuous',()=>{
  const caption=row('full width caption',40,230,520);
  const left=[300,320,500,520].map((y,i)=>row(`L${i}`,50,y));
  const right=[300,320,500,520].map((y,i)=>row(`R${i}`,330,y));
  const final=row('full width closing paragraph',40,610,520);
  const result=model([caption,...left,...right,final]);
  assert.deepEqual(result.ordered.map(line=>line.text),[caption,...left,...right,final].map(line=>line.text));
  const byText=new Map(result.lines.map(line=>[line.text,line]));
  assert.notEqual(byText.get(caption.text).flowId,byText.get(final.text).flowId);
  assert.equal(new Set(left.map(line=>byText.get(line.text).flowId)).size,1);
  assert.equal(new Set(right.map(line=>byText.get(line.text).flowId)).size,1);
  assert.notEqual(byText.get('L0').flowId,byText.get('R0').flowId);
  assert.ok(result.tree.regions.every(node=>node.height>0&&node.path.at(-1)===node.id));
  assert.equal(result.tree.permitsLocalConnection(byText.get(caption.text).regionId,byText.get('L0').regionId),true,'a sequence boundary does not veto independently established local mathematical ownership');
  assert.equal(result.tree.permitsLocalConnection(byText.get('L0').regionId,byText.get('R0').regionId),false,'different children of a real column node remain a hard membership barrier');
});
test('a completed spanning compound separates only its parent subtree and preserves column-major descendants',()=>{
  const left=[100,120,200,220].map((y,i)=>row(`L${i}`,50,y));
  const right=[100,120,200,220].map((y,i)=>row(`R${i}`,330,y));
  const compound=row('complete displayed formula',50,160,470,20,false);
  const result=model([...left,...right],[compound]);
  assert.deepEqual(result.ordered.map(line=>line.text),['L0','L1','R0','R1',compound.text,'L2','L3','R2','R3']);
});
test('ordinary paragraph gaps remain inside their columns even when both columns contain gaps',()=>{
  const left=[100,120,200,220,500,520].map((y,i)=>row(`L${i}`,50,y));
  const right=[100,120,200,220,500,520].map((y,i)=>row(`R${i}`,330,y));
  assert.deepEqual(model([...left,...right]).ordered.map(line=>line.text),[...left,...right].map(line=>line.text));
});
test('a short final left-column paragraph near the page margin remains body text',()=>{
  const left=[100,120,670,690,735,750].map((y,i)=>row(`left paragraph ${i} continues its sentence`,50,y));
  const right=[100,120,630,650].map((y,i)=>row(`right paragraph ${i} remains separate`,330,y));
  assert.deepEqual(model([...left,...right]).ordered.map(line=>line.text),[...left,...right].map(line=>line.text));
});
test('a shared paragraph gap near the top cannot turn the first rows of two columns into running headers',()=>{
  const left=[40,60,110,130].map((y,i)=>row(`left body ${i}`,50,y));
  const right=[40,60,110,130].map((y,i)=>row(`right body ${i}`,330,y));
  assert.deepEqual(model([...left,...right]).ordered.map(line=>line.text),[...left,...right].map(line=>line.text));
});
test('a whole region of smaller body text cannot be mistaken for isolated equation labels',async()=>{
  const {cases}=await buildColumnFixture();
  const authored=cases.find(value=>value.name==='five-columns-staggered-paragraphs').order;
  const records=authored.map((line,id)=>({id,text:line.text,box:{x:line.x,y:792-line.y-line.size*.8,width:line.width,height:line.size},
    baseline:792-line.y,em:line.size,flow:true}));
  for(const input of [records,records.toReversed()]){
    const tree=createReadingRegions(input,{bounds:{x:0,y:0,width:612,height:792},em:9});
    const lines=input.map(value=>({...value}));tree.assignOrder(lines,line=>line.box);
    assert.deepEqual(lines.sort((a,b)=>a.readingOrder-b.readingOrder).map(line=>line.id),records.map(line=>line.id));
  }
});
test('a narrow gutter is measured against the supporting column text rather than the page-wide font estimate',()=>{
  const left=[100,112,124].map((y,i)=>row(`left body line ${i}`,50,y,100,7.4));
  const right=[100,112,124].map((y,i)=>row(`right body line ${i}`,156,y,100,7.4));
  for(const estimate of [7.4,9,12]){
    const records=[...left,...right].map(value=>({...value}));
    const tree=createReadingRegions(records,{bounds,em:estimate});tree.assignOrder(records,value=>value.box);
    assert.deepEqual(records.sort((a,b)=>a.readingOrder-b.readingOrder).map(value=>value.text),[...left,...right].map(value=>value.text));
  }
});
