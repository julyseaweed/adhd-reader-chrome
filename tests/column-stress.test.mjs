import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReadingUnits } from '../src/math-reading.js';
import { mergeItems, orderReadingLines, readingFrameRect } from '../src/reading-lines.js';

// Independently authored column-major source order. Input rows deliberately
// contain all columns, as PDF extraction does when their baselines coincide.
// A short end-of-paragraph is still part of its column, including when every
// column on that baseline is short. Input order is not a reading-order hint.
function fixture(count, variant, angle=0, scale=1) {
  const items=[], expected=[], baselines=new Map();
  let x=40;
  const cos=Math.cos(angle),sin=Math.sin(angle);
  for(let column=0;column<count;column++) {
    const extent=134+(column%3)*13;
    for(let row=0;row<11;row++) {
      const baseline=70+row*15+(row>4?20:0);
      const isShort=(row+column+variant)%4===2||row===10;
      const indent=row===5?8:0;
      const str=isShort?'ends.':`Column ${column} line ${row} remains in this flow.`;
      const width=isShort?22:extent-indent;
      const index=items.length, xx=x+indent, yy=baseline-8;
      const corners=[[xx,yy],[xx+width,yy],[xx,yy+10],[xx+width,yy+10]]
        .map(([a,b])=>[scale*(cos*a-sin*b+900),scale*(sin*a+cos*b+900)]);
      const xs=corners.map(a=>a[0]),ys=corners.map(a=>a[1]);
      const baseX=scale*(cos*xx-sin*baseline+900),baseY=scale*(sin*xx+cos*baseline+900);
      const item={index,str,x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys),
        fontHeight:10*scale,fontName:'body',angle,baseline:baseY,baselineX:baseX,baselineY:baseY,
        baselineOffset:-sin*baseX+cos*baseY,along:cos*baseX+sin*baseY};
      items.push(item);expected.push(index);
      if(!baselines.has(row))baselines.set(row,[]);
      baselines.get(row).push(item);
    }
    x+=extent+12+(column%2)*10;
  }
  const rows=[...baselines.values()].map(group=>mergeItems(group));
  const shuffled=variant%2?[...items].reverse():[...items.slice(7),...items.slice(0,7)];
  const layout=buildReadingUnits({items:shuffled,baselineLines:variant%2?rows.reverse():rows,
    viewport:{width:2600*scale,height:2600*scale,transform:[scale*cos,scale*sin,-scale*sin,scale*cos,0,0]},structures:{rules:[]}});
  const ordered=orderReadingLines(layout.units.map(line=>({line,...readingFrameRect(line,angle,scale),
    regionBounds:line.regionBounds,regionId:line.regionId,regionPath:line.regionPath,flowId:line.flowId,readingOrder:line.readingOrder})));
  return {expected,actual:ordered.map(({line})=>line.items.map(i=>i.index)),layout};
}

for(const count of [2,3,4,5,6,8])test(`${count} columns keep short endings, paragraph gaps and indents in source-independent reading order`,()=>{
  for(const variant of [0,1,2])for(const angle of [0,Math.PI/2,Math.PI,Math.PI*1.5])for(const scale of [.6,1.35]) {
    const {expected,actual}=fixture(count,variant,angle,scale);
    assert.deepEqual(actual,expected.map(index=>[index]),`${count} columns, variant ${variant}, angle ${angle}, scale ${scale}`);
  }
});
