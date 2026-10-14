import test from 'node:test';
import assert from 'node:assert/strict';
import {cardBrowseIdeas,filterIdeas} from '../web/lib/atlas-view.ts';

const idea=(id,createdAt,extra={})=>({id,createdAt,updatedAt:createdAt,title:id,body:'可读正文',bodyFormat:'plain',tags:[],attachments:[],x:0,y:0,archived:false,...extra});

test('卡片按新建时间稳定倒序，移动或正文更新不把旧记录推到首位，源资料与坐标不变',()=>{
  const old=idea('old','2026-01-01T00:00:00.000Z',{updatedAt:'2026-12-31T00:00:00.000Z',x:999,y:-100});
  const a=idea('a','2026-02-01T00:00:00.000Z'),b=idea('b',a.createdAt),source=[old,b,a],before=structuredClone(source);
  assert.deepEqual(cardBrowseIdeas(source).map(item=>item.id),['a','b','old']);
  assert.deepEqual(source,before);
  assert.strictEqual(cardBrowseIdeas(source)[2],old);
});

test('卡片共用搜索、原名标签及归档范围，未打标签的记录仍能浏览',()=>{
  const source=[idea('active','2026-01-01T00:00:00.000Z',{tags:['参考'],body:'公园步道'}),
    idea('no-tag','2026-01-02T00:00:00.000Z',{body:'公园地图'}),
    idea('archived','2026-01-03T00:00:00.000Z',{tags:['参考'],body:'公园旧稿',archived:true})];
  assert.deepEqual(cardBrowseIdeas(filterIdeas(source,false,'公园','')).map(item=>item.id),['no-tag','active']);
  assert.deepEqual(cardBrowseIdeas(filterIdeas(source,false,'公园','参考')).map(item=>item.id),['active']);
  assert.deepEqual(cardBrowseIdeas(filterIdeas(source,true,'公园','参考')).map(item=>item.id),['archived']);
  assert.deepEqual(cardBrowseIdeas(filterIdeas(source,false,'不存在','')),[]);
});
