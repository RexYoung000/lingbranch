import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,readdir,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Miniflare } from 'miniflare';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sha256, fingerprint, parse, create as createSchema } from '../server/validation.mjs';
import { validateBundle,restoreBundle } from '../server/bundle.mjs';
import { Library } from '../server/library.mjs';
import { buildWorker } from '../scripts/worker-build.mjs';
import { nodesOverlap } from '../shared/relationship-layout.mjs';

const key=()=>crypto.randomUUID(),identity={'oai-authenticated-user-id':'local-owner-test'};
const work=await mkdtemp(join(tmpdir(),'lingbranch-worker-test-'));
await buildWorker(join(work,'server'));
const entry=join(work,'server/index.js');
const migrations=(await readdir(resolve('drizzle'))).filter(x=>x.endsWith('.sql')).sort();
async function fixture(t,{beforeUpgrade}={}) {
  const state=await mkdtemp(join(work,'state-'));
  const options={modules:true,modulesRoot:join(work,'server'),scriptPath:entry,compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'local-library'},r2Buckets:{BUCKET:'local-files'},d1Persist:join(state,'d1'),r2Persist:join(state,'r2')};
  let mf=new Miniflare(options);
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB');
  for(const migration of migrations) {
    const sql=(await readFile(resolve('drizzle',migration),'utf8')).split('--> statement-breakpoint').map(x=>x.trim()).filter(Boolean);
    await db.batch(sql.map(statement=>db.prepare(statement)));
    if(beforeUpgrade&&migration===migrations[0])await beforeUpgrade(db,mf);
  }
  const raw=(path,{headers={},...init}={})=>mf.dispatchFetch(`https://lingbranch.test${path}`,{...init,headers:{...identity,...headers}});
  const api=async(path,{method='GET',body,headers={}}={})=>{const response=await raw(path,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json','X-LingBranch-Request':'1'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,value:await response.json(),response};};
  return {api,raw,db,get mf(){return mf;},async restart(){await mf.dispose();mf=new Miniflare(options);}};
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
  assert.equal(nodesOverlap(a,b),false);
  const ai=await mcp(t,f),tools=await ai.client.listTools();assert.equal(tools.tools.length,15);
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
  for(let i=0;i<all.length;i++)for(let j=i+1;j<all.length;j++)assert.equal(nodesOverlap(all[i],all[j]),false);
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
  const discovery=await f.raw('/mcp',{method:'POST',headers:{...noIdentity,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});assert.equal(discovery.status,200);assert.equal((await discovery.json()).result.tools.length,15);
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

test('Sites 追加迁移保留旧正文、坐标、连接、原件和原请求回执',async t=>{
  const ids=[key(),key()].sort(),version='2026-10-01T00:00:00.000Z',connectionId=key(),attachmentId=key();
  const input={title:'旧版合成记录',body:'# 保持纯文本\n![字面图片](attachment:00000000-0000-4000-8000-000000000000)',x:200,y:300,idempotencyKey:key()};
  const normalized=parse(createSchema,input),bytes=Buffer.from('旧版合成附件'),hash=sha256(bytes);
  const old={id:ids[0],...Object.fromEntries(['title','body','sourceLabel','sourceUrl','sourceAt','tags','x','y'].map(name=>[name,normalized[name]])),archived:false,createdAt:version,updatedAt:version,attachments:[]};
  const f=await fixture(t,{beforeUpgrade:async(db,mf)=>{
    await db.batch([
      db.prepare('INSERT INTO ideas(id,title,body,source_label,source_url,source_at,tags_json,x,y,archived,created_at,updated_at) VALUES(?,?,?,\'\',\'\',\'\',\'[]\',?,?,0,?,?)').bind(ids[0],old.title,old.body,old.x,old.y,version,version),
      db.prepare('INSERT INTO ideas(id,title,body,source_label,source_url,source_at,tags_json,x,y,archived,created_at,updated_at) VALUES(?,?,\'\',\'\',\'\',\'\',\'[]\',800,300,0,?,?)').bind(ids[1],'另一旧记录',version,version),
      db.prepare('INSERT INTO connections(id,from_id,to_id) VALUES(?,?,?)').bind(connectionId,...ids),
      db.prepare('INSERT INTO attachments(id,idea_id,name,mime_type,bytes,indexed_text,sha256,created_at) VALUES(?,?,?,\'text/plain\',?,\'\',?,?)').bind(attachmentId,ids[0],'legacy.txt',bytes.length,hash,version),
      db.prepare('INSERT INTO receipts(key,hash,result) VALUES(?,?,?)').bind(input.idempotencyKey,fingerprint({kind:'create',input:normalized}),JSON.stringify({outcome:'created',item:old,replayed:false})),
    ]);
    await (await mf.getR2Bucket('BUCKET')).put(`attachments/${hash}`,bytes);
  }});
  const atlas=(await f.api('/api/atlas')).value,a=atlas.ideas.find(idea=>idea.id===ids[0]);
  assert.equal(a.body,old.body);assert.equal(a.bodyFormat,'plain');assert.equal(a.x,200);assert.equal(a.y,300);assert.equal(a.updatedAt,version);
  assert.deepEqual(atlas.connections,[{id:connectionId,fromId:ids[0],toId:ids[1],relationType:'related',reason:'',updatedAt:'1970-01-01T00:00:00.000Z'}]);
  const retry=await f.api('/api/atlas',{method:'POST',body:input});assert.equal(retry.status,200);assert.equal(retry.value.id,ids[0]);assert.equal((await f.api('/api/atlas')).value.ideas.length,2);
  assert.deepEqual(Buffer.from(await (await f.raw(`/api/attachments/${attachmentId}`)).arrayBuffer()),bytes);
  const exported=Buffer.from(await (await f.raw('/api/export')).arrayBuffer());validateBundle(exported);assert.equal(JSON.parse(gunzipSync(exported)).version,3);
  const target=join(work,key());await restoreBundle(exported,target);const restored=new Library(target);
  try {assert.equal(restored.readIdea(ids[0]).body,old.body);assert.equal(restored.connections()[0].id,connectionId);assert.deepEqual((await restored.readAttachment(attachmentId)).bytes,bytes);}finally{restored.close();}
});

test('Sites 图文正文与关联说明通过网页和 HTTP MCP 一致读写、冲突与重试',async t=>{
  const f=await fixture(t),a=await create(f,'图文合成节点'),b=await create(f,'关联合成节点'),ai=await mcp(t,f);
  assert.equal(ai.client.getServerVersion().version,'0.0.4');
  const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('synthetic image bytes')]);
  const attached=await ai.call('attach_inspiration_file',{id:a.id,name:'synthetic.png',mimeType:'image/png',bytes:bytes.length,sha256:sha256(bytes),idempotencyKey:key(),dataBase64:bytes.toString('base64')});assert.equal(attached.isError,false);
  const body=`# 合成标题\n\n![示例图](attachment:${attached.attachment.id})\n\n正文检索内容。`;
  const saved=await f.api(`/api/ideas/${a.id}`,{method:'PATCH',body:{body,bodyFormat:'markdown',expectedUpdatedAt:a.updatedAt,idempotencyKey:key()}});assert.equal(saved.status,200);
  const read=await ai.call('read_inspiration',{id:a.id});assert.equal(read.body,body);assert.equal(read.bodyFormat,'markdown');assert.equal(read.bodyImages[0].attachmentId,attached.attachment.id);assert.match(read.summary,/正文检索内容/);
  assert.equal((await f.api('/api/list?query=attachment%3A')).value.total,0);
  const denied=await f.api(`/api/ideas/${b.id}`,{method:'PATCH',body:{body,bodyFormat:'markdown',expectedUpdatedAt:b.updatedAt,idempotencyKey:key()}});assert.equal(denied.status,400);
  assert.equal((await f.api(`/api/ideas/${a.id}`,{method:'PATCH',body:{body:'![外部](https://example.test/image.png)',expectedUpdatedAt:saved.value.updatedAt,idempotencyKey:key()}})).status,400);
  const createInput={fromId:a.id,toId:b.id,relationType:'example',reason:'合成关系说明',idempotencyKey:key()};
  const connected=await ai.call('connect_inspirations',createInput);assert.equal(connected.isError,false);const c=connected.connection;
  const edit={connectionId:c.id,expectedUpdatedAt:c.updatedAt,idempotencyKey:key(),patch:{relationType:'application',reason:'网页修改后的说明'}};
  const updated=await f.api('/api/connections',{method:'PATCH',body:edit});assert.equal(updated.status,200);
  assert.equal((await ai.call('list_inspiration_connections',{id:a.id})).connections[0].reason,edit.patch.reason);
  assert.equal((await f.api('/api/connections',{method:'PATCH',body:{...edit,idempotencyKey:key()}})).status,409);
  const newer=await ai.call('update_inspiration_connection',{connectionId:c.id,expectedUpdatedAt:updated.value.connection.updatedAt,idempotencyKey:key(),patch:{reason:'后续说明'}});assert.equal(newer.isError,false);
  const replay=await f.api('/api/connections',{method:'PATCH',body:edit});assert.equal(replay.value.replayed,true);assert.equal((await ai.call('list_inspiration_connections',{id:a.id})).connections[0].reason,'后续说明');
  assert.equal((await f.api('/api/connections',{method:'DELETE',body:{id:c.id,expectedUpdatedAt:c.updatedAt}})).status,409);
  assert.equal((await f.api('/api/connections',{method:'DELETE',body:{id:c.id,expectedUpdatedAt:newer.connection.updatedAt}})).status,200);
  assert.equal((await ai.call('connect_inspirations',createInput)).replayed,true);assert.equal((await ai.call('list_inspiration_connections',{id:a.id})).connections.length,0);
  await f.restart();assert.equal((await f.api(`/api/ideas/${a.id}`)).value.body,body);
  const exported=Buffer.from(await (await f.raw('/api/export')).arrayBuffer()),target=join(work,key());await restoreBundle(exported,target);const restored=new Library(target);try{assert.equal(restored.readIdea(a.id).bodyFormat,'markdown');assert.equal(restored.readIdea(a.id).bodyImages[0].attachmentId,attached.attachment.id);}finally{restored.close();}
});

test('Sites 整批布局验证全部版本、原子拒绝、保留备份与重试，支持 1000 节点',async t=>{
  const f=await fixture(t),version='2026-10-01T00:00:00.000Z';
  const rows=Array.from({length:1000},(_,index)=>({id:key(),title:`合成节点 ${index}`,x:index*600,y:100}));
  await f.db.prepare("INSERT INTO ideas(id,title,body,body_format,source_label,source_url,source_at,tags_json,x,y,archived,created_at,updated_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.title'),'','plain','','','','[]',json_extract(value,'$.x'),json_extract(value,'$.y'),0,?,? FROM json_each(?)").bind(version,version,JSON.stringify(rows)).run();
  const ai=await mcp(t,f),input={positions:rows.map(row=>({id:row.id,x:row.x,y:200,expectedUpdatedAt:version})),idempotencyKey:key()};
  const bad=structuredClone(input);bad.positions[999].expectedUpdatedAt='2026-09-01T00:00:00.000Z';
  assert.equal((await ai.call('arrange_inspirations',bad)).isError,true);assert.equal((await f.api(`/api/ideas/${rows[0].id}`)).value.y,100);
  const saved=await ai.call('arrange_inspirations',input);assert.equal(saved.isError,false,JSON.stringify(saved));assert.equal(saved.positions.length,1000);assert.equal(saved.previous.length,1000);assert.equal(saved.outcome,'updated');
  const fresh=(await f.api(`/api/ideas/${rows[0].id}`)).value;assert.equal(fresh.y,200);
  await f.api(`/api/ideas/${fresh.id}`,{method:'PATCH',body:{x:fresh.x,y:300,expectedUpdatedAt:fresh.updatedAt,idempotencyKey:key()}});
  assert.equal((await ai.call('arrange_inspirations',input)).replayed,true);assert.equal((await f.api(`/api/ideas/${fresh.id}`)).value.y,300);
  assert.equal((await ai.call('arrange_inspirations',{positions:saved.previous,idempotencyKey:key()})).isError,true);assert.equal((await f.api(`/api/ideas/${rows[1].id}`)).value.y,200);
});

test('Sites MP4 继承上游容器校验、缺省 MIME 识别与范围下载',async t=>{
  const f=await fixture(t),a=await create(f),bytes=Buffer.alloc(48,1);bytes.writeUInt32BE(24,0);bytes.write('ftyp',4);bytes.write('isom',8);
  const form=new FormData();form.set('file',new Blob([bytes]),'synthetic.mp4');form.set('sha256',sha256(bytes));form.set('idempotencyKey',key());
  const encoded=new Request('https://lingbranch.test/upload',{method:'POST',body:form});
  const upload=await f.raw(`/api/ideas/${a.id}/attachments`,{method:'POST',headers:{'X-LingBranch-Request':'1','Content-Type':encoded.headers.get('Content-Type')},body:await encoded.arrayBuffer()});assert.equal(upload.status,201);
  const attachment=(await upload.json()).attachment;assert.equal(attachment.mimeType,'video/mp4');
  const url=`/api/attachments/${attachment.id}`,full=await f.raw(url);assert.equal(full.headers.get('content-type'),'video/mp4');assert.equal(full.headers.get('accept-ranges'),'bytes');assert.deepEqual(Buffer.from(await full.arrayBuffer()),bytes);
  const part=await f.raw(url,{headers:{Range:'bytes=4-11'}});assert.equal(part.status,206);assert.equal(part.headers.get('content-range'),'bytes 4-11/48');assert.deepEqual(Buffer.from(await part.arrayBuffer()),bytes.subarray(4,12));
  const suffix=await f.raw(url,{headers:{Range:'bytes=-8'}});assert.equal(suffix.status,206);assert.deepEqual(Buffer.from(await suffix.arrayBuffer()),bytes.subarray(40));
  const unsatisfiable=await f.raw(url,{headers:{Range:'bytes=100-'}});assert.equal(unsatisfiable.status,416);assert.equal(unsatisfiable.headers.get('content-range'),'bytes */48');
  assert.match((await f.raw(url+'?download')).headers.get('content-disposition'),/^attachment/);
  const ai=await mcp(t,f),invalid=Buffer.from('synthetic invalid mp4 bytes');assert.equal((await ai.call('attach_inspiration_file',{id:a.id,name:'invalid.mp4',mimeType:'video/mp4',bytes:invalid.length,sha256:sha256(invalid),idempotencyKey:key(),dataBase64:invalid.toString('base64')})).isError,true);
  assert.match((await f.api('/api/session')).response.headers.get('content-security-policy'),/media-src 'self' blob:/);
});
