import assert from 'node:assert/strict';
import test from 'node:test';
import {chooseVisibleReadingLine} from '../src/visible-reading-line.js';

const viewport={left:0,top:45,right:600,bottom:225};
const line=(x,y,flowId,regionId=flowId)=>({x,y,width:180,height:12,flowId,regionId});
const columns=[line(40,20,'left'),line(40,60,'left'),line(40,90,'left'),line(340,20,'right'),line(340,50,'right'),line(340,80,'right')];

test('manual following retains the active confirmed column despite a higher row in its neighbor',()=>{
  assert.equal(chooseVisibleReadingLine(columns,{previousIndex:0,viewport}),1);
  assert.equal(chooseVisibleReadingLine(columns,{previousIndex:3,viewport}),4);
});
test('local headings and sections stay in their parent column flow',()=>{
  const rows=[line(40,20,'left','left-upper'),line(40,60,'left','left-lower'),line(340,50,'right','right-body')];
  assert.equal(chooseVisibleReadingLine(rows,{previousIndex:0,viewport}),1);
});
test('horizontal scroll excludes an old column before considering flow affinity',()=>{
  assert.equal(chooseVisibleReadingLine(columns,{previousIndex:0,viewport:{...viewport,left:300,right:600}}),4);
});
test('when the previous flow has left the viewport, the next visible flow follows authored reading order',()=>{
  const rows=[line(40,20,'old'),line(40,90,'next'),line(340,50,'later')];
  assert.equal(chooseVisibleReadingLine(rows,{previousIndex:0,viewport}),1);
  assert.equal(chooseVisibleReadingLine(rows,{previousIndex:2,viewport:{...viewport,top:0,bottom:45},direction:-1}),0);
});
test('page entry starts with the first visible flow and reverse entry with the last',()=>{
  assert.equal(chooseVisibleReadingLine(columns,{viewport}),1);
  assert.equal(chooseVisibleReadingLine(columns,{viewport,direction:-1}),5);
});
test('leaving a spanning caption enters the first body column rather than another root-level footer',()=>{
  const rows=[line(40,20,'caption'),line(40,80,'left'),line(340,60,'right'),line(40,180,'footer')];
  assert.equal(chooseVisibleReadingLine(rows,{previousIndex:0,viewport}),1);
});
test('unclassified rows preserve nearest visible geometry instead of inventing a column',()=>{
  const rows=columns.map(({flowId,regionId,...bounds})=>bounds);
  assert.equal(chooseVisibleReadingLine(rows,{previousIndex:0,viewport}),4);
  assert.equal(chooseVisibleReadingLine(rows,{viewport,y:95}),2);
  assert.equal(chooseVisibleReadingLine([line(40,70),line(340,70)],{viewport,direction:-1}),1);
  assert.equal(chooseVisibleReadingLine(rows,{viewport:{left:230,right:300,top:45,bottom:225}}),-1);
});
