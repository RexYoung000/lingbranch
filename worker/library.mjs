import { z } from 'zod';
import * as v from '../server/validation.mjs';
import { encodeCursor, decodeCursor } from '../server/encoding.mjs';

const epoch='1970-01-01T00:00:00.000Z';
const nextDate=previous=>new Date(Math.max(Date.now(),Date.parse(previous||epoch)+1)).toISOString();
const cardWidth=324,cardHeight=420;
function freePosition(preferred,occupied) {
  const dx=preferred.x>1_000_000-3*cardWidth?-1:1,dy=preferred.y>0?-1:1;
  for(let n=0;n<=occupied.length*9+4;n++) {
    const p={x:preferred.x+dx*(n%4)*cardWidth,y:preferred.y+dy*Math.floor(n/4)*cardHeight};
    if(Math.abs(p.x)<=1_000_000&&Math.abs(p.y)<=1_000_000&&!occupied.some(o=>Math.abs(p.x-o.x)<cardWidth&&Math.abs(p.y-o.y)<cardHeight))return p;
  }
  v.fail('conflict','附近没有空位，请选择另一个位置。',409);
}
const attachmentFrom=r=>({id:r.id,ideaId:r.idea_id,name:r.name,mimeType:r.mime_type,bytes:r.bytes,indexedText:r.indexed_text,sha256:r.sha256,createdAt:r.created_at});
const ideaFrom=(r,files=[])=>({id:r.id,title:r.title,body:r.body,sourceLabel:r.source_label,sourceUrl:r.source_url,sourceAt:r.source_at,tags:JSON.parse(r.tags_json),x:r.x,y:r.y,archived:!!r.archived,createdAt:r.created_at,updatedAt:r.updated_at,attachments:files.filter(f=>f.idea_id===r.id).map(attachmentFrom)});
const canvasFrom=r=>({panX:r.pan_x,panY:r.pan_y,zoom:r.zoom,updatedAt:r.updated_at});
const connectionFrom=r=>({id:r.id,fromId:r.from_id,toId:r.to_id});

export class D1Library {
  constructor(env) {if(!env.DB||!env.BUCKET)v.fail('unavailable','资料存储尚未就绪，请稍后重试。',503);this.db=env.DB;this.bucket=env.BUCKET;}
  statement(sql,...args) {const s=this.db.prepare(sql);return args.length?s.bind(...args):s;}
  async rows(sql,...args) {return (await this.statement(sql,...args).all()).results;}
  async first(sql,...args) {return this.statement(sql,...args).first();}
  async ensure() {await this.statement('INSERT OR IGNORE INTO canvas(id,pan_x,pan_y,zoom,updated_at,revision) VALUES(1,0,0,1,?,0)',epoch).run();}
  async receipt(kind,input) {
    const hash=v.fingerprint({kind,input}),row=await this.first('SELECT hash,result FROM receipts WHERE key=?',input.idempotencyKey);
    if(!row)return {hash};
    if(row.hash!==hash)v.fail('conflict','该重试标识已用于不同操作或内容，请读取已保存结果。',409);
    const result=JSON.parse(row.result);
    return {hash,result:{...result,replayed:true,outcome:result.outcome==='created'?(kind==='attachment'?'already_attached':'already_saved'):result.outcome}};
  }
  async mutate(kind,input,plan) {
    await this.ensure();
    for(let attempt=0;attempt<12;attempt++) {
      const receipt=input.idempotencyKey?await this.receipt(kind,input):null;
      if(receipt?.result)return receipt.result;
      const {revision}=await this.first('SELECT revision FROM canvas WHERE id=1');
      const {statements=[],result}=await plan();
      const output=receipt?{...result,replayed:false}:result,guard=crypto.randomUUID();
      const batch=[
        this.statement('UPDATE canvas SET revision=revision+1 WHERE id=1 AND revision=?',revision),
        this.statement('INSERT INTO mutation_guard(id,valid) SELECT ?,CASE WHEN changes()=1 THEN 1 ELSE NULL END',guard),
        ...statements,
        ...(receipt?[this.statement('INSERT INTO receipts(key,hash,result) VALUES(?,?,?)',input.idempotencyKey,receipt.hash,JSON.stringify(output))]:[]),
        this.statement('DELETE FROM mutation_guard WHERE id=?',guard),
      ];
      try {await this.db.batch(batch);return output;}
      catch(error) {
        if(receipt){const saved=await this.receipt(kind,input);if(saved.result)return saved.result;}
        const latest=await this.first('SELECT revision FROM canvas WHERE id=1');
        if(latest.revision!==revision)continue;
        throw error;
      }
    }
    v.fail('conflict','资料库正在保存其他操作，请保留原请求标识稍后重试。',409);
  }
  async snapshot() {
    await this.ensure();
    const values=await this.db.batch([
      this.statement('SELECT * FROM ideas ORDER BY seq'),this.statement('SELECT * FROM attachments ORDER BY id'),
      this.statement('SELECT * FROM connections ORDER BY id'),this.statement('SELECT id,pan_x,pan_y,zoom,updated_at FROM canvas WHERE id=1'),
      this.statement('SELECT * FROM receipts ORDER BY key'),
    ]);
    return {ideas:values[0].results,attachments:values[1].results,connections:values[2].results,canvas:values[3].results[0],receipts:values[4].results};
  }
  async readIdea(value) {
    const id=v.parse(v.id,value);
    const [ideas,files]=await this.db.batch([this.statement('SELECT * FROM ideas WHERE id=?',id),this.statement('SELECT * FROM attachments WHERE idea_id=? ORDER BY created_at,id',id)]);
    if(!ideas.results[0])v.fail('not_found','没有找到这条灵感。',404);
    return ideaFrom(ideas.results[0],files.results);
  }
  async atlas() {const s=await this.snapshot();return {ideas:s.ideas.map(r=>ideaFrom(r,s.attachments)),connections:s.connections.map(connectionFrom),canvas:canvasFrom(s.canvas)};}
  async createIdea(value) {
    const input=v.parse(v.create,value);
    return this.mutate('create',input,async()=>{
      const position=freePosition(input,await this.rows('SELECT x,y FROM ideas')),now=nextDate(),id=crypto.randomUUID();
      const item={id,...Object.fromEntries(Object.keys(v.noteFields).map(k=>[k,input[k]])),...position,archived:false,createdAt:now,updatedAt:now,attachments:[]};
      return {statements:[this.statement('INSERT INTO ideas(id,title,body,source_label,source_url,source_at,tags_json,x,y,archived,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,0,?,?)',id,input.title,input.body,input.sourceLabel,input.sourceUrl,input.sourceAt,JSON.stringify(input.tags),position.x,position.y,now,now)],result:{outcome:'created',item}};
    });
  }
  async updateIdea(value) {
    const input=v.parse(v.update,value);
    return this.mutate('update',input,async()=>{
      const current=await this.readIdea(input.id);
      if(input.expectedUpdatedAt!==current.updatedAt)v.fail('conflict','灵感已被修改。草稿已保留，请重新读取并核对后保存。',409);
      if(!Object.entries(input.patch).some(([k,x])=>v.fingerprint(x)!==v.fingerprint(current[k])))return {result:{outcome:'unchanged',item:current}};
      const item={...current,...input.patch,updatedAt:nextDate(current.updatedAt)};
      return {statements:[this.statement('UPDATE ideas SET title=?,body=?,source_label=?,source_url=?,source_at=?,tags_json=?,x=?,y=?,archived=?,updated_at=? WHERE id=?',item.title,item.body,item.sourceLabel,item.sourceUrl,item.sourceAt,JSON.stringify(item.tags),item.x,item.y,Number(item.archived),item.updatedAt,input.id)],result:{outcome:'updated',item}};
    });
  }
  async listIdeas(value={}) {
    const input=v.parse(v.list,value),s=await this.snapshot();
    const scope=v.fingerprint({includeArchived:input.includeArchived,query:input.query,tag:input.tag});
    let after=0,high=s.ideas.at(-1)?.seq||0;
    if(input.cursor) {
      let decoded;try {decoded=decodeCursor(input.cursor);}catch {v.fail('invalid_input','分页游标无效。');}
      const c=v.parse(z.object({after:z.number().int().min(0),high:z.number().int().min(0),scope:v.digest}).strict(),decoded);
      if(c.scope!==scope||c.after>c.high)v.fail('invalid_input','分页范围已变化，请从第一页重新读取。');
      ({after,high}=c);
    }
    const terms=input.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matching=s.ideas.filter(r=>{
      if(r.seq>high||(!input.includeArchived&&r.archived))return false;
      const tags=JSON.parse(r.tags_json);if(input.tag&&!tags.includes(input.tag))return false;
      const files=s.attachments.filter(f=>f.idea_id===r.id),text=[r.title,r.body,r.source_label,r.source_url,...tags,...files.flatMap(f=>[f.name,f.indexed_text])].join(' ').toLocaleLowerCase();
      return terms.every(term=>text.includes(term));
    });
    const remaining=matching.filter(r=>r.seq>after),selected=remaining.slice(0,input.limit),hasMore=remaining.length>input.limit;
    return {items:selected.map(r=>ideaFrom(r,s.attachments)),total:matching.length,count:selected.length,includeArchived:input.includeArchived,hasMore,nextCursor:hasMore?encodeCursor({after:selected.at(-1).seq,high,scope}):null};
  }
  async listTags(includeArchived=true) {
    v.parse(z.boolean(),includeArchived);const counts=new Map();
    for(const r of await this.rows('SELECT tags_json,archived FROM ideas')) {
      if(!includeArchived&&r.archived)continue;
      for(const name of JSON.parse(r.tags_json)){const item=counts.get(name)||{name,count:0,activeCount:0,archivedCount:0};item.count++;item[r.archived?'archivedCount':'activeCount']++;counts.set(name,item);}
    }
    return [...counts.values()].sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'zh-CN'));
  }
  async changeTag(value,remove=false) {
    const input=v.parse(remove?v.removeTag:v.rename,value);
    return this.mutate(remove?'remove_tag':'rename_tag',input,async()=>{
      const from=remove?input.tag:input.fromTag,rows=await this.rows('SELECT * FROM ideas ORDER BY seq');
      const affected=rows.filter(r=>JSON.parse(r.tags_json).includes(from)&&(remove||from!==input.toTag));
      const updatedAt=nextDate(affected.reduce((latest,r)=>r.updated_at>latest?r.updated_at:latest,epoch));
      const affectedItems=affected.map(r=>({id:r.id,tags:[...new Set(remove?JSON.parse(r.tags_json).filter(t=>t!==from):JSON.parse(r.tags_json).map(t=>t===from?input.toTag:t))],updatedAt}));
      const statements=!affected.length?[]:remove?[
        this.statement('UPDATE ideas SET tags_json=(SELECT json_group_array(value) FROM json_each(ideas.tags_json) WHERE value<>?),updated_at=? WHERE EXISTS(SELECT 1 FROM json_each(ideas.tags_json) WHERE value=?)',from,updatedAt,from),
      ]:[this.statement('UPDATE ideas SET tags_json=(SELECT json_group_array(value) FROM (SELECT DISTINCT CASE WHEN value=? THEN ? ELSE value END AS value FROM json_each(ideas.tags_json))),updated_at=? WHERE EXISTS(SELECT 1 FROM json_each(ideas.tags_json) WHERE value=?)',from,input.toTag,updatedAt,from)];
      return {statements,result:{outcome:affected.length?(remove?'removed':'renamed'):'unchanged',affectedCount:affected.length,affectedItems}};
    });
  }
  async connect(value) {
    const input=v.parse(z.object({fromId:v.id,toId:v.id}).strict(),value);
    if(input.fromId===input.toId)v.fail('invalid_input','请选择两条不同的灵感。');
    return this.mutate('connect',input,async()=>{
      if((await this.readIdea(input.fromId)).archived||(await this.readIdea(input.toId)).archived)v.fail('invalid_input','只能连接未归档灵感。');
      const [fromId,toId]=[input.fromId,input.toId].sort(),existing=await this.first('SELECT * FROM connections WHERE from_id=? AND to_id=?',fromId,toId);
      if(existing)return {result:{outcome:'already_connected',connection:connectionFrom(existing)}};
      const connection={id:crypto.randomUUID(),fromId,toId};
      return {statements:[this.statement('INSERT INTO connections(id,from_id,to_id) VALUES(?,?,?)',connection.id,fromId,toId)],result:{outcome:'created',connection}};
    });
  }
  async listConnections(id) {await this.readIdea(id);return (await this.rows('SELECT * FROM connections WHERE from_id=? OR to_id=? ORDER BY id',id,id)).map(connectionFrom);}
  async removeConnection(value) {
    const id=v.parse(v.id,value);
    return this.mutate('remove_connection',{id},async()=>({statements:[this.statement('DELETE FROM connections WHERE id=?',id)],result:{outcome:(await this.first('SELECT id FROM connections WHERE id=?',id))?'removed':'unchanged',connectionId:id}}));
  }
  async saveCanvas(value) {
    const input=v.parse(v.canvas,value);
    return this.mutate('canvas',input,async()=>{
      const current=canvasFrom(await this.first('SELECT * FROM canvas WHERE id=1'));
      if(current.updatedAt!==input.expectedUpdatedAt)v.fail('conflict','画布视野已变化，请刷新后重试。',409);
      if(current.panX===input.panX&&current.panY===input.panY&&current.zoom===input.zoom)return {result:{outcome:'unchanged',canvas:current}};
      const canvas={panX:input.panX,panY:input.panY,zoom:input.zoom,updatedAt:nextDate(current.updatedAt)};
      return {statements:[this.statement('UPDATE canvas SET pan_x=?,pan_y=?,zoom=?,updated_at=? WHERE id=1',canvas.panX,canvas.panY,canvas.zoom,canvas.updatedAt)],result:{outcome:'updated',canvas}};
    });
  }
  async addAttachment(value,bytes) {
    const input=v.parse(v.attachmentInput,value);validateFile(input,bytes);await this.readIdea(input.id);
    const prior=await this.receipt('attachment',input);
    if(prior.result){await this.readAttachment(prior.result.attachment.id);return prior.result;}
    const key=`attachments/${input.sha256}`,existing=await this.bucket.get(key);
    if(existing){const saved=new Uint8Array(await existing.arrayBuffer());if(v.sha256(saved)!==input.sha256||saved.length!==input.bytes)v.fail('integrity_error','已保存的附件原件校验失败。',503);}
    else {await this.bucket.put(key,bytes,{httpMetadata:{contentType:'application/octet-stream'}});const saved=await this.bucket.get(key);if(!saved||v.sha256(new Uint8Array(await saved.arrayBuffer()))!==input.sha256)v.fail('integrity_error','附件原件未完整保存，请保留原请求重试。',503);}
    return this.mutate('attachment',input,async()=>{
      await this.readIdea(input.id);const attachment={id:crypto.randomUUID(),ideaId:input.id,name:input.name,mimeType:input.mimeType,bytes:input.bytes,indexedText:input.indexedText,sha256:input.sha256,createdAt:nextDate()};
      return {statements:[this.statement('INSERT INTO attachments(id,idea_id,name,mime_type,bytes,indexed_text,sha256,created_at) VALUES(?,?,?,?,?,?,?,?)',attachment.id,attachment.ideaId,attachment.name,attachment.mimeType,attachment.bytes,attachment.indexedText,attachment.sha256,attachment.createdAt)],result:{outcome:'created',attachment}};
    });
  }
  async readAttachment(value) {
    const id=v.parse(v.id,value),row=await this.first('SELECT * FROM attachments WHERE id=?',id);
    if(!row)v.fail('not_found','没有找到附件。',404);
    const metadata=attachmentFrom(row),object=await this.bucket.get(`attachments/${metadata.sha256}`);
    if(!object)v.fail('integrity_error','附件原件缺失或无法读取，请检查存储。',503);
    const bytes=new Uint8Array(await object.arrayBuffer());
    if(bytes.length!==metadata.bytes||v.sha256(bytes)!==metadata.sha256)v.fail('integrity_error','附件原件校验失败，未返回损坏内容。',503);
    return {metadata,bytes};
  }
}

export function validateFile(metadata,bytes) {
  if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length!==metadata.bytes||v.sha256(bytes)!==metadata.sha256)v.fail('integrity_error','附件字节数或 SHA-256 校验不一致。');
  const signature=bytes.subarray(0,16),ascii=new TextDecoder('ascii').decode(signature),type=metadata.mimeType;
  const tests={'image/png':()=>[137,80,78,71,13,10,26,10].every((x,i)=>signature[i]===x),'image/jpeg':()=>signature[0]===255&&signature[1]===216&&signature[2]===255,'image/gif':()=>/^GIF8[79]a/.test(ascii),'image/webp':()=>ascii.startsWith('RIFF')&&ascii.slice(8,12)==='WEBP','application/pdf':()=>ascii.startsWith('%PDF-')};
  if(tests[type]&&!tests[type]())v.fail('invalid_input','文件内容与声明的类型不一致。');
  if(type.startsWith('text/')||type==='application/json')try {new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch {v.fail('invalid_input','文本附件需要使用 UTF-8 编码。');}
}
