import test from 'node:test';
import assert from 'node:assert/strict';
import {PreviewCache} from '../extension/previews.js';
test('preview cache caps size, expires and invalidates changed URL',()=>{
  let now=0;const cache=new PreviewCache({now:()=>now,limit:2,ttl:100});
  cache.put(1,'a','image1');cache.put(2,'b','image2');cache.put(3,'c','image3');
  assert.equal(cache.get(1,'a'),null);assert.equal(cache.get(2,'b').data,'image2');
  assert.equal(cache.get(2,'new-url'),null);
  now=100;assert.equal(cache.get(3,'c'),null);assert.equal(cache.items.size,0);
});
test('preview deletion does not touch other tabs',()=>{
  const cache=new PreviewCache();cache.put(1,'a','1');cache.put(2,'b','2');cache.delete(1);
  assert.equal(cache.get(1,'a'),null);assert.equal(cache.get(2,'b').data,'2');
});
