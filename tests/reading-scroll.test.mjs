import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadingScroll, readingScrollTarget } from '../src/reading-scroll.js';

function fixture({ round = false, reduced = false } = {}) {
  let time = 0, id = 0, valid = true, position = { top: 0, left: 0 };
  const pending = new Map(), writes = [], finishes = [];
  const motion = createReadingScroll({
    read: () => ({ ...position }),
    write: (top, left) => { position = { top: round ? Math.round(top) : top, left: round ? Math.round(left) : left }; writes.push({ time, ...position }); },
    requestFrame: callback => { pending.set(++id, callback); return id; },
    cancelFrame: id => pending.delete(id), now: () => time,
    reducedMotion: () => reduced, isValid: () => valid,
    onFinish: completed => finishes.push(completed),
  });
  return { motion, writes, finishes, pending,
    get position() { return position; },
    step(dt = 16) { time += dt; const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(callback => callback(time)); },
    settle() { for(let i=0;i<100 && motion.active;i++) this.step(); assert.equal(motion.active,false); },
    manual(top, left = 0) { position = { top, left }; },
    invalidate() { valid = false; },
  };
}

test('reading returns to a central band with space in the direction of travel', () => {
  const viewport = { top: 10, bottom: 610, left: 0, right: 800, height: 600, width: 800 };
  const row = { top: 510, bottom: 530, left: 50, right: 750 };
  const ordinary = readingScrollTarget(row, viewport, { top: 200, left: 0 });
  const crossing = readingScrollTarget(row, viewport, { top: 200, left: 0 }, { center: true });
  assert.equal(ordinary.top, 452); assert.equal(crossing.top, 452);
  assert.deepEqual(readingScrollTarget({ ...row, top: 300, bottom: 320 }, viewport, { top: 200, left: 0 }), { top: 200, left: 0 });
  const up = readingScrollTarget({ ...row, top: 70, bottom: 90 }, viewport, { top: 200, left: 0 });
  assert.equal(up.top, -60);
});

test('successive rows travel naturally within the central band instead of scrolling each line', () => {
  const viewport={top:40,bottom:840,left:0,right:800,height:800,width:800};
  for(const direction of [1,-1]){
    let top=1000, stationary=0, moves=0;
    for(let i=0;i<60;i++){
      const documentMiddle=1000+400+direction*i*22;
      const row={top:viewport.top+documentMiddle-top-10,bottom:viewport.top+documentMiddle-top+10,left:50,right:750};
      const destination=readingScrollTarget(row,viewport,{top,left:0});
      const ratio=(documentMiddle-destination.top)/viewport.height;
      assert.ok(ratio>=.34-1e-9&&ratio<=.64+1e-9);
      if(Math.abs(destination.top-top)<.01) stationary++;
      else{
        moves++;
        assert.ok(direction*(destination.top-top)>0);
        assert.ok(Math.abs(ratio-(direction>0?.43:.55))<1e-9);
      }
      top=destination.top;
    }
    assert.ok(stationary>=45,'most row changes leave the page still');
    assert.ok(moves>=4&&moves<=9,'periodic returns supply a fresh stationary reading interval');
  }
});

test('tall formulas fit the viewport and stay stable on the next reveal at all practical viewport sizes', () => {
  for(const viewHeight of [80,180,360,600,1000])for(const fraction of [.05,.3,.6,.8,.96]){
    const height=Math.min(viewHeight-16,viewHeight*fraction);
    const viewport={top:25,bottom:25+viewHeight,left:0,right:800,height:viewHeight,width:800};
    for(const middleRatio of [-.1,.2,.5,.75,1.2]){
      const row={top:25+viewHeight*middleRatio-height/2,bottom:25+viewHeight*middleRatio+height/2,left:50,right:750};
      const position={top:1000,left:0},target=readingScrollTarget(row,viewport,position);
      const shifted={...row,top:row.top+position.top-target.top,bottom:row.bottom+position.top-target.top};
      assert.ok(shifted.top>=viewport.top+8-1e-8&&shifted.bottom<=viewport.bottom-8+1e-8);
      const repeat=readingScrollTarget(shifted,viewport,target);
      assert.ok(Math.abs(repeat.top-target.top)<1e-8,'settled row must not drift on repeated reveal');
    }
  }
});

test('changing zoom or viewport origin keeps the same proportional reading placement', () => {
  for(const scale of [.5,1,2,4]){
    const viewport={top:140,bottom:140+600*scale,left:0,right:800*scale,height:600*scale,width:800*scale};
    const row={top:140+470*scale,bottom:140+490*scale,left:50*scale,right:750*scale};
    const target=readingScrollTarget(row,viewport,{top:1200,left:0});
    assert.ok(Math.abs((480*scale+1200-target.top)/(600*scale)-.43)<1e-9);
  }
});

test('column jumps reserve space for reading order rather than the spatial scroll direction', () => {
  const viewport={top:40,bottom:840,left:0,right:800,height:800,width:800};
  for(const [middle,direction,expected] of [[-150,1,.43],[950,-1,.55]]){
    const row={top:viewport.top+middle-10,bottom:viewport.top+middle+10,left:50,right:750};
    const target=readingScrollTarget(row,viewport,{top:2000,left:0},{direction});
    assert.ok(Math.abs((middle+2000-target.top)/800-expected)<1e-9);
  }
  const row={top:430,bottom:450,left:50,right:750};
  for(const direction of [-1,1])assert.deepEqual(readingScrollTarget(row,viewport,{top:1000,left:0},{direction}),{top:1000,left:0});
});

test('fractional tall formula bounds and rounded host offsets never reverse a settled scroll', () => {
  for(const viewHeight of [360,600,800,1600])for(const fraction of [.733,.891,.962])for(const direction of [0,-1,1]){
    const height=viewHeight*fraction,viewport={top:37,bottom:37+viewHeight,left:0,right:800,height:viewHeight,width:800};
    for(const middleRatio of [-.13,.21,.79,1.27]){
      const row={top:37+viewHeight*middleRatio-height/2,bottom:37+viewHeight*middleRatio+height/2,left:50,right:750};
      const original={top:1953.17,left:0},target=readingScrollTarget(row,viewport,original,{direction});
      for(const top of [target.top,Math.round(target.top)]){
        const shifted={...row,top:row.top+original.top-top,bottom:row.bottom+original.top-top};
        const repeated=readingScrollTarget(shifted,viewport,{top,left:0},{direction});
        assert.equal(repeated.top,top,'rounding at the safe edge must not request another motion');
      }
    }
  }
});

test('an oversized reading unit aligns its top while an oversized page keeps horizontal position', () => {
  const target = readingScrollTarget({ top: 510, bottom: 1300, left: -500, right: 1500 },
    { top: 10, bottom: 610, left: 0, right: 800 }, { top: 200, left: 500 });
  assert.deepEqual(target, { top: 692, left: 500 });
});

test('follow scroll crosses intermediate positions and settles without overshoot or a first-frame jump', () => {
  const f = fixture(); f.motion.retarget(600, 80);
  assert.equal(f.writes.length, 0); f.step();
  assert.ok(f.position.top > 0 && f.position.top < 20);
  f.settle(); assert.deepEqual(f.position, { top: 600, left: 80 });
  assert.ok(f.writes.length > 10);
  assert.ok(f.writes.every((p,i) => p.top <= 600 && p.left <= 80 && (!i || p.top >= f.writes[i-1].top)));
  assert.deepEqual(f.finishes, [true]);
});

test('rapid forward retargets continue the current motion and complete at the latest line', () => {
  const f = fixture(); f.motion.retarget(400,0); f.step(80);
  const before = f.position.top, writes = f.writes.length;
  f.motion.retarget(430,0); f.motion.retarget(460,0); f.motion.retarget(490,0);
  assert.equal(f.position.top,before); assert.equal(f.writes.length,writes);
  f.step(); assert.ok(f.position.top>before); f.settle(); assert.equal(f.position.top,490);
  assert.ok(f.writes.every((p,i)=>!i||p.top>=f.writes[i-1].top));
  assert.deepEqual(f.finishes,[true]);
});

test('reversing direction has no old-direction tail and returning to the safe band stops old motion', () => {
  const f = fixture(); f.motion.retarget(600,0); f.step(120);
  const before = f.position.top; f.motion.retarget(0,0); f.step();
  assert.ok(f.position.top < before); assert.ok(f.position.top>=0);
  const stop = f.position.top; f.motion.retarget(stop,0); f.step(500);
  assert.equal(f.position.top,stop); assert.equal(f.motion.active,false);
  assert.deepEqual(f.finishes,[true]);
});

test('repeated identical targets do not restart the animation', () => {
  const f = fixture(); f.motion.retarget(600,0);
  for(let i=0;i<32;i++){f.step();f.motion.retarget(600,0);}
  assert.equal(f.position.top,600); assert.equal(f.motion.active,false);
});

test('manual input cancels both scheduled and already-dispatched stale frames', () => {
  const f = fixture(); f.motion.retarget(600,0); f.step();
  const stale = [...f.pending.values()][0]; f.motion.cancel(); f.manual(230);
  const count=f.writes.length; stale(); f.step(500);
  assert.equal(f.position.top,230); assert.equal(f.writes.length,count); assert.deepEqual(f.finishes,[false]);
});

test('unannounced external scrolling is not pulled back by the next animation frame', () => {
  const f = fixture(); f.motion.retarget(600,0); f.step(); f.manual(240); f.step();
  assert.equal(f.position.top,240); assert.equal(f.motion.active,false); assert.deepEqual(f.finishes,[false]);
});

test('view invalidation stops all old writes, while integer native scroll positions remain valid', () => {
  const stale=fixture(); stale.motion.retarget(600,0); stale.step(); stale.invalidate();
  const count=stale.writes.length; stale.step(); assert.equal(stale.writes.length,count); assert.equal(stale.motion.active,false);
  const rounded=fixture({round:true}); rounded.motion.retarget(600,50); rounded.settle();
  assert.deepEqual(rounded.position,{top:600,left:50}); assert.deepEqual(rounded.finishes,[true]);
});

test('reduced-motion preference performs one exact primitive write with no delayed movement', () => {
  const f=fixture({reduced:true}); f.motion.retarget(600,80);
  assert.deepEqual(f.position,{top:600,left:80}); assert.equal(f.writes.length,1);
  assert.equal(f.pending.size,0); assert.equal(f.motion.active,false); assert.deepEqual(f.finishes,[true]);
});

test('a late frame after PDF rasterization resumes gradually instead of snapping to the destination', () => {
  const f=fixture();f.motion.retarget(600,0);f.step(500);
  assert.ok(f.position.top>0&&f.position.top<60);assert.equal(f.motion.active,true);
  const before=f.position.top;f.step(500);assert.ok(f.position.top>before&&f.position.top<300);
  f.settle();assert.equal(f.position.top,600);
});
