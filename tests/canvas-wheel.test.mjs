import test from 'node:test';
import assert from 'node:assert/strict';
import {wheelCanvasView} from '../web/lib/atlas-view.ts';
import {MIN_CANVAS_ZOOM} from '../shared/relationship-layout.mjs';
const viewport={left:230,top:160,height:720};
const current={panX:-180,panY:95,zoom:.7};
const event={clientX:823,clientY:591,deltaY:-100,deltaMode:0};
const world=(view,e=event)=>({x:(e.clientX-viewport.left-view.panX)/view.zoom,y:(e.clientY-viewport.top-view.panY)/view.zoom});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} differs from ${b}`);

test('ordinary wheel zooms both ways about the pointer; off-centre canvas and pan stay anchored',()=>{
 const before=world(current),larger=wheelCanvasView(current,event,viewport);
 assert.ok(larger.zoom>current.zoom);near(world(larger).x,before.x);near(world(larger).y,before.y);
 const smaller=wheelCanvasView(larger,{...event,deltaY:100},viewport);
 near(smaller.zoom,current.zoom);near(smaller.panX,current.panX);near(smaller.panY,current.panY);
 assert.deepEqual(current,{panX:-180,panY:95,zoom:.7});
});
test('pixel, line and page wheel units produce the same zoom',()=>{
 const pixels=wheelCanvasView(current,{...event,deltaY:-96},viewport);
 assert.deepEqual(wheelCanvasView(current,{...event,deltaY:-6,deltaMode:1},viewport),pixels);
 assert.deepEqual(wheelCanvasView(current,{...event,deltaY:-96/720,deltaMode:2},viewport),pixels);
});
test('upper and lower zoom boundaries remain finite and stop without pointer drift',()=>{
 for(const [zoom,deltaY] of [[2,1e8],[.1,-1e8]]){
  const base={...current,zoom},result=wheelCanvasView(base,{...event,deltaY},viewport),before=world(base);
  assert.equal(result.zoom,deltaY>0?MIN_CANVAS_ZOOM:2.5);
  assert.ok(Number.isFinite(result.panX)&&Number.isFinite(result.panY));
  // At tiny overview scales compare screen pixels, the actual pointer invariant.
  near(before.x*result.zoom+result.panX,event.clientX-viewport.left);near(before.y*result.zoom+result.panY,event.clientY-viewport.top);
  assert.strictEqual(wheelCanvasView(result,{...event,deltaY},viewport),result);
 }
});
test('horizontal-only, zero and non-finite vertical input leave the view untouched',()=>{
 for(const deltaY of [0,NaN,Infinity,-Infinity])assert.strictEqual(wheelCanvasView(current,{...event,deltaY,deltaX:100},viewport),current);
});
test('a rapid sequence at changing pointer positions keeps each current world anchor fixed',()=>{
 let view={...current};
 for(let i=0;i<100;i++){
  const e={...event,clientX:260+i*4,clientY:210+i*2,deltaY:i%2?-5:3},before=world(view,e);
  view=wheelCanvasView(view,e,viewport);near(world(view,e).x,before.x);near(world(view,e).y,before.y);
 }
});
