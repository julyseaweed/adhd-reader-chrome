import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, StandardFonts, degrees } from 'pdf-lib';
import { loadPDF, pdfjsLib } from '../src/pdf-engine.js';
import { glyphAdvancesFromOperators, mapTextItemAdvances, textAdvancesForPage } from '../src/text-advances.js';

const OPS = Object.fromEntries(['save','restore','transform','beginGroup','endGroup','paintFormXObjectBegin','paintFormXObjectEnd',
  'beginText','setTextMatrix','setFont','setGState','setCharSpacing','setWordSpacing','setHScale','setTextRise','setLeading',
  'moveText','setLeadingMoveText','nextLine','showText'].map((name, index) => [name, index + 1]));
const glyph = (unicode, width, extra = {}) => ({ unicode, fontChar: unicode, width, isSpace: unicode === ' ', ...extra });
const operators = entries => ({ fnArray: entries.map(entry => OPS[entry[0]]), argsArray: entries.map(entry => entry.slice(1)) });
const font = { fontMatrix: [.001,0,0,.001,0,0], vertical: false, isType3Font: false };
const item = (str, width, extra = {}) => ({ str, width, height: 10, transform: [10,0,0,10,40,500], fontName: 'F', dir: 'ltr', ...extra });
const content = items => ({ items, styles: { F: { vertical: false }, G: { vertical: false } } });
const prefix = [['beginText'], ['setFont','F',10], ['setTextMatrix',new Float32Array([1,0,0,1,40,500])]];
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
const mapped = (entries, items, fonts = new Map([['F',font]])) =>
  mapTextItemAdvances(glyphAdvancesFromOperators(operators(entries), fonts, OPS), content(items));

test('PDF advances preserve unequal letter widths instead of distributing an item uniformly', () => {
  const original = item('tim', 13), snapshot = structuredClone(original);
  const map = mapped([...prefix, ['showText',[glyph('t',300),glyph('i',200),glyph('m',800)]]], [original]);
  assert.deepEqual(map.get(0), { clusters: [
    { start: 0, end: 1, offset: 0, advance: 3 },
    { start: 1, end: 2, offset: 3, advance: 2 },
    { start: 2, end: 3, offset: 5, advance: 8 },
  ], advance: 13 });
  assert.deepEqual(original, snapshot, 'the semantic text item and source offsets remain unchanged');
});

test('character spacing, word spacing and horizontal scaling retain exact internal boundaries', () => {
  const map = mapped([...prefix, ['setCharSpacing',.4], ['setWordSpacing',2], ['setHScale',80],
    ['showText',[glyph('W',600),glyph('i',200),glyph(' ',250),glyph('m',800)]]],
    [item('Wi m',17.36,{transform:[8,0,0,10,40,500]})]);
  const clusters = map.get(0).clusters;
  [0,5.12,7.04,10.96].forEach((value,index)=>close(clusters[index].offset,value));
  [5.12,1.92,3.92,6.4].forEach((value,index)=>close(clusters[index].advance,value));
});

test('TJ advances produce real kerning and synthesized Unicode-space cells', () => {
  const kerned = mapped([...prefix,['showText',[glyph('A',700),80,glyph('V',700)]]],[item('AV',13.2)]).get(0);
  close(kerned.clusters[1].offset,6.2);
  const spaced = mapped([...prefix,['showText',[glyph('T',300),-500,glyph('N',500)]]],[item('T N',13)]).get(0);
  assert.deepEqual(spaced.clusters, [
    {start:0,end:1,offset:0,advance:3},{start:1,end:2,offset:3,advance:5},{start:2,end:3,offset:8,advance:5},
  ]);
});

test('saved graphics state, form CTM, font matrix and text rise are reflected in PDF coordinates', () => {
  const entries = [
    ['save'], ['transform',2,0,0,3,10,20], ['paintFormXObjectBegin',[1,0,0,1,5,7],null],
    ['beginText'], ['setGState',[['Font',['F',10]]]], ['setTextRise',2],
    ['setTextMatrix',new Float32Array([1,0,0,1,40,50])], ['showText',[glyph('a',300),glyph('b',500)]],
    ['paintFormXObjectEnd'], ['restore'], ...prefix, ['showText',[glyph('c',400)]],
  ];
  const map = mapped(entries, [
    item('ab',32,{transform:[20,0,0,30,100,197],height:30}), item('c',8),
  ], new Map([['F',{...font,fontMatrix:[.002,0,0,.002,0,0]}]]));
  close(map.get(0).clusters[1].offset,12); close(map.get(0).clusters[1].advance,20);
  close(map.get(1).advance,8);
});

test('rotated item axes and repeated same-font words remain associated with their own locations', () => {
  const entries = [...prefix,['showText',[glyph('a',300),glyph('b',500)]],
    ['setTextMatrix',new Float32Array([0,1,-1,0,100,200])],['showText',[glyph('a',300),glyph('b',500)]],
    ['setTextMatrix',new Float32Array([-1,0,0,-1,150,200])],['showText',[glyph('a',300),glyph('b',500)]],
    ['setTextMatrix',new Float32Array([0,-1,1,0,200,200])],['showText',[glyph('a',300),glyph('b',500)]],
  ];
  const map = mapped(entries, [item('ab',8), item('ab',8,{transform:[0,10,-10,0,100,200]}),
    item('ab',8,{transform:[-10,0,0,-10,150,200]}),item('ab',8,{transform:[0,-10,10,0,200,200]})]);
  assert.equal(map.size,4);
  for (const value of map.values()) assert.deepEqual(value.clusters.map(cluster=>cluster.advance),[3,5]);
});

test('move/leading/next-line operations cannot join glyphs from neighboring rows', () => {
  const entries = [...prefix,['setLeading',15],['showText',[glyph('a',300)]],['nextLine'],
    ['showText',[glyph('b',500)]],['setLeadingMoveText',20,-17],['showText',[glyph('c',400)]],
    ['nextLine'],['showText',[glyph('d',600)]]];
  const map = mapped(entries,[item('a',3),item('b',5,{transform:[10,0,0,10,40,485]}),
    item('c',4,{transform:[10,0,0,10,60,468]}),item('d',6,{transform:[10,0,0,10,60,451]})]);
  assert.equal(map.size,4);
});

test('Unicode, PUA font mappings, ligatures, combining accents and surrogate pairs keep complete clusters', () => {
  const cases = [
    ['tm',[glyph('t',300,{fontChar:'\uE001'}),glyph('m',800,{fontChar:'\uE002'})],11,[[0,1],[1,2]]],
    ['fi',[glyph('ﬁ',600,{fontChar:'\uE003'})],6,[[0,2]]],
    ['e\u0301',[glyph('e',500),glyph('\u0301',0)],5,[[0,2]]],
    ['🦊',[glyph('🦊',1000,{fontChar:'\uE004'})],10,[[0,2]]],
    ['注意',[glyph('注',1000),glyph('意',1000)],20,[[0,1],[1,2]]],
  ];
  for (const [text,glyphs,width,boundaries] of cases) {
    const result = mapped([...prefix,['showText',glyphs]],[item(text,width)]).get(0);
    assert.ok(result,text); assert.deepEqual(result.clusters.map(cluster=>[cluster.start,cluster.end]),boundaries);
    assert.equal(result.clusters.map(cluster=>text.slice(cluster.start,cluster.end)).join(''),text);
  }
});

test('partial, ambiguous, mismatched-font and unsupported complex layouts retain the original fallback', () => {
  const base = [...prefix,['showText',[glyph('a',300),glyph('b',500)]]];
  assert.equal(mapped(base,[item('ac',8)]).size,0);
  assert.equal(mapped(base,[item('ab',9)]).size,0);
  assert.equal(mapped(base,[item('ab',8,{fontName:'G'})]).size,0);
  assert.equal(mapped(base,[item('ab',8,{transform:[10,0,0,10,40.5,500]})]).size,0);
  assert.equal(mapped(base,[item('ab',8,{dir:'rtl'})]).size,0);
  assert.equal(mapped(base,[item('ab',8)],new Map([['F',{...font,isType3Font:true}]] )).size,0);
  assert.equal(mapped(base,[item('ab',8)],new Map([['F',{...font,vertical:true}]] )).size,0);
  assert.equal(mapped(base,[item('ab',8)],new Map([['F',{...font,isInvalidPDFjsFont:true}]] )).size,0);
  assert.equal(mapped([...base,['setTextMatrix',[1,0,0,1,40,500]],['showText',[glyph('a',300),glyph('b',500)]]],[item('ab',8)]).size,0);
  assert.equal(mapped([...prefix,['showText',[glyph('a',300),glyph('x',0),glyph('b',500)]]],[item('ab',8)]).size,0);
  assert.equal(mapped([...prefix,['showText',[glyph('a',300),{unicode:'?',width:undefined},glyph('b',500)]]],[item('ab',8)]).size,0);
});

test('source item indices survive marked content and the operator replay is cached per page', async () => {
  let calls = 0;
  const page = { commonObjs:new Map([['F',font]]),getOperatorList:async options=>{
    assert.equal(options.annotationMode,0);calls++;return operators([...prefix,['showText',[glyph('a',300),glyph('b',500)]]]);
  } };
  const source = content([{type:'beginMarkedContent'},item('',0),item('ab',8),{type:'endMarkedContent'}]);
  const first = await textAdvancesForPage(page,source,OPS), second = await textAdvancesForPage(page,structuredClone(source),OPS);
  assert.deepEqual([...first.keys()],[2]);assert.strictEqual(second,first);assert.equal(calls,1);
  const changed = structuredClone(source);changed.items[2].str='unmatched';
  assert.equal((await textAdvancesForPage(page,changed,OPS)).size,0,'different text cannot reuse stale mappings');
});

test('generated selectable PDFs match independently authored character advances at every page rotation', async () => {
  const original = await PDFDocument.create();
  const names = [StandardFonts.TimesRoman,StandardFonts.TimesRomanItalic,StandardFonts.Helvetica,StandardFonts.Courier];
  const text = 'A triumphant flourish resists temptation.', author = [];
  for (const [index,name] of names.entries()) {
    const face = await original.embedFont(name),page = original.addPage([612,792]);
    page.setRotation(degrees(index*90));page.setCropBox(20,30,570,740);page.node.set(PDFName.of('UserUnit'),original.context.obj(2));
    page.drawText(text,{x:50,y:700,size:15,font:face});
    let offset=0;author.push([...text].map(character=>{const start=offset;offset+=face.widthOfTextAtSize(character,15);return{start,width:offset-start};}));
  }
  const document = await loadPDF(await original.save());
  try {
    for (let index=0;index<4;index++) {
      const page=await document.getPage(index+1),source=await page.getTextContent(),before=JSON.stringify(source);
      const map=await textAdvancesForPage(page,source,pdfjsLib.OPS),itemIndex=source.items.findIndex(item=>item.str===text),result=map.get(itemIndex);
      assert.ok(result,`${names[index]} must map`);assert.equal(result.clusters.length,text.length);
      for (const [i,cluster] of result.clusters.entries()) { close(cluster.offset,author[index][i].start);close(cluster.advance,author[index][i].width); }
      assert.equal(JSON.stringify(source),before);
    }
  } finally { await document.destroy(); }
});
