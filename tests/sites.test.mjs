import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,readdir,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sha256 } from '../server/validation.mjs';
import { validateBundle,restoreBundle } from '../server/bundle.mjs';
import { Library } from '../server/library.mjs';
import { buildWorker } from '../scripts/worker-build.mjs';

const key=()=>crypto.randomUUID(),identity={'oai-authenticated-user-id':'local-owner-test'};
const work=await mkdtemp(join(tmpdir(),'lingbranch-worker-test-'));
await buildWorker(join(work,'server'));
const entry=join(work,'server/index.js');
const migrations=(await readdir(resolve('drizzle'))).filter(x=>x.endsWith('.sql')).sort();
async function fixture(t) {
  const state=await mkdtemp(join(work,'state-'));
  const options={modules:true,modulesRoot:join(work,'server'),scriptPath:entry,compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'local-library'},r2Buckets:{BUCKET:'local-files'},d1Persist:join(state,'d1'),r2Persist:join(state,'r2')};
  let mf=new Miniflare(options);
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB');
  for(const migration of migrations) {
    const sql=(await readFile(resolve('drizzle',migration),'utf8')).split('--> statement-breakpoint').map(x=>x.trim()).filter(Boolean);
    await db.batch(sql.map(statement=>db.prepare(statement)));
  }
  const raw=(path,{headers={},...init}={})=>mf.dispatchFetch(`https://lingbranch.test${path}`,{...init,headers:{...identity,...headers}});
  const api=async(path,{method='GET',body,headers={}}={})=>{const response=await raw(path,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json','X-LingBranch-Request':'1'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,value:await response.json(),response};};
  return {api,raw,get mf(){return mf;},async restart(){await mf.dispose();mf=new Miniflare(options);}};
}
const create=async(f,title='自行编写的验证灵感',extra={})=>{const r=await f.api('/api/atlas',{method:'POST',body:{title,idempotencyKey:key(),...extra}});assert.equal(r.status,201,JSON.stringify(r.value));return r.value;};
async function mcp(t,f) {
  const client=new Client({name:'lingbranch-http-verification',version:'1'});
  const transport=new StreamableHTTPClientTransport(new URL('https://lingbranch.test/mcp'),{fetch:(url,init)=>f.mf.dispatchFetch(url,{...init,headers:{...Object.fromEntries(new Headers(init?.headers)),...identity}})});
  await client.connect(transport);t.after(()=>client.close());
  return {client,async call(name,args={}){const r=await client.callTool({name,arguments:args});return {...JSON.parse(r.content[0].text),isError:!!r.isError};}};
}
test.after(async()=>rm(work,{recursive:true,force:true}));

test('Sites 编译 Worker：HTTP 与真实 Streamable MCP 共用 D1，R2 与重启持久化',async t=>{
  const f=await fixture(t);assert.equal((await f.api('/api/atlas')).value.ideas.length,0);
  const a=await create(f,'公园观察',{body:'公园中的阅读笔记',tags:['阅读']}),b=await create(f,'散步灵感');
  assert.ok(Math.abs(a.x-b.x)>=324||Math.abs(a.y-b.y)>=420);
  const ai=await mcp(t,f),tools=await ai.client.listTools();assert.equal(tools.tools.length,13);
  assert.equal((await ai.call('search_inspirations',{query:'公园'})).items[0].id,a.id);
  const changed=await ai.call('update_inspiration',{id:a.id,expectedUpdatedAt:a.updatedAt,patch:{body:'从远程协议更新的示例内容',tags:['阅读','观察']},idempotencyKey:key()});assert.equal(changed.outcome,'updated');
  assert.equal((await f.api(`/api/ideas/${a.id}`)).value.body,changed.item.body);
  const link=await ai.call('connect_inspirations',{fromId:a.id,toId:b.id});assert.equal(link.outcome,'created');
  const reverse=await f.api('/api/connections',{method:'POST',body:{fromId:b.id,toId:a.id}});assert.equal(reverse.value.id,link.connection.id);
  assert.equal((await ai.call('list_inspiration_connections',{id:a.id})).connections.length,1);
  assert.equal((await ai.call('list_inspiration_tags',{})).tags.length,2);
  const bytes=Buffer.from('自己编写的完整 UTF-8 附件。'),hash=sha256(bytes),upload={id:a.id,name:'verification.txt',mimeType:'text/plain',bytes:bytes.length,sha256:hash,idempotencyKey:key(),dataBase64:bytes.toString('base64')};
  const attached=await ai.call('attach_inspiration_file',upload);assert.equal(attached.outcome,'created');
  const replay=await ai.call('attach_inspiration_file',upload);assert.equal(replay.attachment.id,attached.attachment.id);
  const file=await ai.call('read_inspiration_attachment',{attachmentId:attached.attachment.id,limit:10});assert.equal(file.complete,false);
  assert.deepEqual(Buffer.from(file.dataBase64,'base64'),bytes.subarray(0,10));
  const before=(await f.api('/api/atlas')).value;
  assert.equal((await f.api('/api/canvas',{method:'PATCH',body:{panX:17,panY:-22,zoom:.8,expectedUpdatedAt:before.canvas.updatedAt,idempotencyKey:key()}})).status,200);
  await f.restart();const after=(await f.api('/api/atlas')).value;assert.equal(after.ideas.length,2);assert.equal(after.connections.length,1);assert.equal(after.canvas.panX,17);assert.equal(after.ideas.find(x=>x.id===a.id).attachments.length,1);
  const download=await f.raw(`/api/attachments/${attached.attachment.id}`);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
  const exported=await f.raw('/api/export');assert.equal(exported.status,200);const bundle=Buffer.from(await exported.arrayBuffer());const validated=validateBundle(bundle);assert.equal(validated.snapshot.ideas.length,2);
  const target=join(work,key());await restoreBundle(bundle,target);const restored=new Library(target);try {assert.equal(restored.readIdea(a.id).body,changed.item.body);assert.deepEqual((await restored.readAttachment(attached.attachment.id)).bytes,bytes);}finally{restored.close();}
  assert.equal((await ai.call('remove_inspiration_connection',{connectionId:link.connection.id})).outcome,'removed');assert.equal((await ai.call('remove_inspiration_connection',{connectionId:link.connection.id})).outcome,'unchanged');
});
test('Sites 原子重试、并发占位、过期版本、标签合并和归档',async t=>{
  const f=await fixture(t),input={title:'重复请求',idempotencyKey:key()};
  const calls=await Promise.all([f.api('/api/atlas',{method:'POST',body:input}),f.api('/api/atlas',{method:'POST',body:input})]);assert.equal(calls[0].value.id,calls[1].value.id);assert.ok(calls.some(r=>r.value.replayed));
  assert.equal((await f.api('/api/atlas',{method:'POST',body:{...input,title:'不同参数'}})).status,409);
  const old=calls[0].value;const a=await create(f,'标签案例',{tags:['Alpha','Beta','D Code']}),b=await create(f,'标签二',{tags:['Beta']});
  await Promise.all(Array.from({length:6},(_,i)=>create(f,`并发验证 ${i}`)));
  const all=(await f.api('/api/atlas')).value.ideas;
  for(let i=0;i<all.length;i++)for(let j=i+1;j<all.length;j++)assert.ok(Math.abs(all[i].x-all[j].x)>=324||Math.abs(all[i].y-all[j].y)>=420);
  const body={expectedUpdatedAt:old.updatedAt,idempotencyKey:key(),body:'更新后的示例'};
  const changed=await f.api(`/api/ideas/${old.id}`,{method:'PATCH',body});assert.equal(changed.value.outcome,'updated');
  assert.equal((await f.api(`/api/ideas/${old.id}`,{method:'PATCH',body})).value.replayed,true);
  assert.equal((await f.api(`/api/ideas/${old.id}`,{method:'PATCH',body:{...body,idempotencyKey:key()}})).status,409);
  assert.equal((await f.api('/api/tags',{method:'PATCH',body:{fromTag:'Alpha',toTag:'Beta',idempotencyKey:key()}})).value.affectedCount,1);
  const merged=(await f.api(`/api/ideas/${a.id}`)).value;assert.deepEqual(merged.tags,['Beta','D Code']);
  await f.api('/api/tags',{method:'DELETE',body:{tag:'Beta',idempotencyKey:key()}});assert.deepEqual((await f.api(`/api/ideas/${a.id}`)).value.tags,['D Code']);
  const read=(await f.api(`/api/ideas/${b.id}`)).value;assert.equal((await f.api(`/api/ideas/${b.id}`,{method:'PATCH',body:{archived:true,expectedUpdatedAt:read.updatedAt,idempotencyKey:key()}})).status,200);
  assert.equal((await f.api('/api/connections',{method:'POST',body:{fromId:a.id,toId:b.id}})).status,400);
  const page=(await f.api('/api/list?limit=3')).value;await create(f,'当前分页之外');let ids=[...page.items.map(x=>x.id)],p=page;while(p.hasMore){p=(await f.api(`/api/list?limit=3&cursor=${p.nextCursor}`)).value;ids.push(...p.items.map(x=>x.id));}assert.equal(ids.length,all.length);assert.equal(new Set(ids).size,all.length);
});
test('Sites 信任边界：未认证、服务凭据、跨站请求和错误附件被拒绝',async t=>{
  const f=await fixture(t),noIdentity={'oai-authenticated-user-id':''};
  for(const path of ['/api/atlas','/api/list','/api/export','/api/attachments/'+key()])assert.equal((await f.raw(path,{headers:noIdentity})).status,401);
  assert.equal((await f.raw('/api/atlas',{headers:{...noIdentity,'OAI-Sites-Authorization':'Bearer not-a-user'}})).status,401);
  assert.equal((await f.api('/api/atlas',{method:'POST',body:{title:'跨站',idempotencyKey:key()},headers:{Origin:'https://untrusted.test'}})).status,403);
  const discovery=await f.raw('/mcp',{method:'POST',headers:{...noIdentity,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});assert.equal(discovery.status,200);assert.equal((await discovery.json()).result.tools.length,13);
  const denied=await f.raw('/mcp',{method:'POST',headers:{...noIdentity,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'list_inspirations',arguments:{}}})});assert.equal(denied.status,401);
  const a=await create(f),bytes=Buffer.from('<script>untrusted</script>'),ai=await mcp(t,f);
  assert.equal((await ai.call('attach_inspiration_file',{id:a.id,name:'bad.png',mimeType:'image/png',bytes:bytes.length,sha256:sha256(bytes),idempotencyKey:key(),dataBase64:bytes.toString('base64')})).isError,true);
  const form=new FormData();form.set('file',new Blob([bytes],{type:'text/html'}),'example.html');form.set('sha256',sha256(bytes));form.set('idempotencyKey',key());
  const encoded=new Request('https://lingbranch.test/upload',{method:'POST',body:form});
  const r=await f.raw(`/api/ideas/${a.id}/attachments`,{method:'POST',headers:{'X-LingBranch-Request':'1','Content-Type':encoded.headers.get('Content-Type')},body:await encoded.arrayBuffer()});assert.equal(r.status,201);const result=await r.json();
  const download=await f.raw(`/api/attachments/${result.attachment.id}`);assert.equal(download.headers.get('content-type'),'application/octet-stream');assert.match(download.headers.get('content-disposition'),/^attachment/);assert.match(download.headers.get('content-security-policy'),/sandbox/);
  const bucket=await f.mf.getR2Bucket('BUCKET');await bucket.put(`attachments/${sha256(bytes)}`,'corrupted');assert.equal((await f.raw(`/api/attachments/${result.attachment.id}`)).status,503);assert.equal((await f.raw('/api/export')).status,503);
});
test('Sites Worker 实际接受 20 MiB 原件，分段读回并核对完整摘要',async t=>{
  const f=await fixture(t),a=await create(f),ai=await mcp(t,f),bytes=Buffer.alloc(20*1024*1024,97),hash=sha256(bytes);
  const r=await ai.call('attach_inspiration_file',{id:a.id,name:'large-verification.txt',mimeType:'text/plain',bytes:bytes.length,sha256:hash,idempotencyKey:key(),dataBase64:bytes.toString('base64')});
  assert.equal(r.isError,false,JSON.stringify(r));assert.equal(r.outcome,'created');
  const parts=[];let offset=0;
  while(offset!==null){const part=await ai.call('read_inspiration_attachment',{attachmentId:r.attachment.id,offset});assert.equal(part.isError,false);parts.push(Buffer.from(part.dataBase64,'base64'));offset=part.nextOffset;}
  const restored=Buffer.concat(parts);assert.equal(restored.length,bytes.length);assert.equal(sha256(restored),hash);
});
