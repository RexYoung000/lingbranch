import { z } from 'zod';
import * as v from '../server/validation.mjs';
import { executeTool } from '../server/tools.mjs';
import { D1Library } from './library.mjs';
import { handleMcp } from './mcp.mjs';
import { exportBundle } from './export.mjs';

const json=(value,status=200)=>Response.json(value,{status,headers:value?.outcome?{'X-LingBranch-Outcome':value.outcome}:undefined});
const authenticated=request=>!!request.headers.get('oai-authenticated-user-id')?.trim();
function protect(request,url) {
  const origin=request.headers.get('Origin');
  if((origin&&origin!==url.origin)||request.headers.get('Sec-Fetch-Site')==='cross-site')v.fail('forbidden','拒绝跨站请求。',403);
  if(url.pathname.startsWith('/api/')&&!['GET','HEAD'].includes(request.method)&&request.headers.get('X-LingBranch-Request')!=='1')v.fail('forbidden','写入请求缺少保护标识。',403);
}
async function bodyBytes(request,limit) {
  if(Number(request.headers.get('content-length')||0)>limit)v.fail('too_large','请求内容过大。',413);
  const reader=request.body?.getReader(),chunks=[];let size=0;
  if(!reader)return new Uint8Array();
  while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>limit){await reader.cancel();v.fail('too_large','请求内容过大。',413);}chunks.push(next.value);}
  const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
}
async function jsonBody(request,limit=150000) {
  if(!request.headers.get('content-type')?.startsWith('application/json'))v.fail('invalid_input','请发送 JSON 内容。',415);
  try {return JSON.parse(new TextDecoder().decode(await bodyBytes(request,limit)));}catch(error){if(error instanceof v.LibraryError)throw error;v.fail('invalid_input','JSON 格式无效。');}
}
function parseByteRange(header,size) {
  const match=/^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if(!match||(!match[1]&&!match[2]))return {kind:'ignore'};
  let start,end;
  if(!match[1]){const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)return {kind:'unsatisfiable'};start=Math.max(0,size-suffix);end=size-1;}
  else{start=Number(match[1]);end=match[2]?Number(match[2]):size-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||start>=size)return {kind:'unsatisfiable'};end=Math.min(end,size-1);}
  return {kind:'range',start,end};
}
export default {
  async fetch(request,env) {
    let response;
    try {
      const url=new URL(request.url),path=url.pathname,method=request.method;
      protect(request,url);
      if(path==='/api/session') {
        if(method!=='GET')v.fail('method_not_allowed','请通过 ChatGPT 登录此站点。',405);
        response=json({mode:'sites',authenticated:authenticated(request),signInPath:'/signin-with-chatgpt?return_to=%2F'});
      } else if(path==='/mcp') {
        if(method!=='POST')response=new Response('Use stateless POST /mcp',{status:405,headers:{Allow:'POST'}});
        else {
          const message=await jsonBody(request,29*1024*1024);
          // Discovery contains no records; all tool calls require the dispatch-authenticated user.
          response=await handleMcp(request,authenticated(request)?new D1Library(env):null,authenticated(request),message);
        }
      } else if(path.startsWith('/api/')) {
        if(!authenticated(request))v.fail('unauthorized','请先通过 ChatGPT 登录此私有资料库。',401);
        response=await api(request,url,new D1Library(env));
      } else if(!authenticated(request)&&path==='/') {
        response=new Response(null,{status:302,headers:{Location:'/signin-with-chatgpt?return_to=%2F'}});
      } else {
        if(!['GET','HEAD'].includes(method))v.fail('method_not_allowed','不支持此操作。',405);
        if(!env.ASSETS)v.fail('unavailable','网页资源尚未就绪。',503);
        response=await env.ASSETS.fetch(request);
      }
    }catch(error){const known=error instanceof v.LibraryError;if(!known)console.error('LingBranch request storage/runtime failure');response=json({code:known?error.code:'unavailable',error:known?error.message:'存储暂不可用，请保留草稿并用原请求重试。'},known?error.status:503);}
    const headers=new Headers(response.headers);
    headers.set('Cache-Control','private, no-store');headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','no-referrer');
    if(!headers.has('Content-Security-Policy'))headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'");
    return new Response(response.body,{status:response.status,headers});
  },
};
async function api(request,url,library) {
  const path=url.pathname,method=request.method;
  if(path==='/api/atlas'&&method==='GET')return json(await library.atlas());
  if(path==='/api/atlas'&&method==='POST'){const r=await library.createIdea(await jsonBody(request));return json({...r.item,outcome:r.outcome,replayed:r.replayed},r.replayed?200:201);}
  if(path==='/api/list'&&method==='GET') {
    const include=url.searchParams.get('includeArchived');if(include!==null&&!['true','false'].includes(include))v.fail('invalid_input','归档筛选无效。');
    return json(await library.listIdeas({includeArchived:include!=='false',limit:Number(url.searchParams.get('limit')||50),...(url.searchParams.has('cursor')?{cursor:url.searchParams.get('cursor')}:{}),query:url.searchParams.get('query')||'',...(url.searchParams.has('tag')?{tag:url.searchParams.get('tag')}:{})}));
  }
  if(path==='/api/search'&&method==='GET')return json({ideas:(await library.listIdeas({query:url.searchParams.get('q')||'',includeArchived:true})).items});
  const idea=path.match(/^\/api\/ideas\/([^/]+)$/);
  if(idea&&method==='GET')return json(await library.readIdea(idea[1]));
  if(idea&&method==='PATCH'){const {expectedUpdatedAt,idempotencyKey,...patch}=v.parse(z.record(z.unknown()),await jsonBody(request));const r=await library.updateIdea({id:idea[1],expectedUpdatedAt,idempotencyKey,patch});return json({...r.item,outcome:r.outcome,replayed:r.replayed});}
  if(path==='/api/canvas'&&method==='PATCH')return json((await library.saveCanvas(await jsonBody(request))).canvas);
  if(path==='/api/tags') {
    if(method==='GET')return json({tags:await library.listTags()});
    if(['PATCH','DELETE'].includes(method)){const r=await library.changeTag(await jsonBody(request),method==='DELETE');return json({...r,tags:await library.listTags()});}
  }
  if(path==='/api/connections') {
    if(method==='POST')return json((await library.connect(await jsonBody(request))).connection);
    if(method==='PATCH')return json(await library.updateConnection(await jsonBody(request)));
    if(method==='DELETE'){const {id,expectedUpdatedAt}=v.parse(z.object({id:v.id,expectedUpdatedAt:v.date.optional()}).strict(),await jsonBody(request));return json(await library.removeConnection(id,expectedUpdatedAt));}
  }
  const upload=path.match(/^\/api\/ideas\/([^/]+)\/attachments$/);
  if(upload&&method==='POST') {
    if(!request.headers.get('content-type')?.startsWith('multipart/form-data;'))v.fail('invalid_input','请上传文件表单。',415);
    const bytes=await bodyBytes(request,v.MAX_ATTACHMENT_BYTES+160000);
    const form=await new Request(request.url,{method:'POST',headers:{'Content-Type':request.headers.get('Content-Type')},body:bytes}).formData();
    const file=form.get('file');if(!file||typeof file==='string')v.fail('invalid_input','请选择文件。');
    const mimeType=file.name.toLowerCase().endsWith('.mp4')&&(!file.type||file.type==='application/octet-stream')?'video/mp4':file.type||'application/octet-stream';
    const result=await library.addAttachment({id:upload[1],name:file.name,mimeType,bytes:file.size,sha256:form.get('sha256'),indexedText:form.get('indexedText')||'',idempotencyKey:form.get('idempotencyKey')},new Uint8Array(await file.arrayBuffer()));
    return json(result,result.replayed?200:201);
  }
  const file=path.match(/^\/api\/attachments\/([^/]+)$/);
  if(file&&method==='GET') {
    const {metadata,bytes}=await library.readAttachment(file[1]),image=/^image\/(png|jpeg|gif|webp)$/.test(metadata.mimeType),video=metadata.mimeType==='video/mp4',previewable=image||video;
    const headers={'Content-Type':previewable?metadata.mimeType:'application/octet-stream','Content-Disposition':`${previewable&&!url.searchParams.has('download')?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(metadata.name).replace(/'/g,'%27')}`,'Content-Security-Policy':"sandbox; default-src 'none'",'Content-Length':String(bytes.length)};
    if(video){headers['Accept-Ranges']='bytes';const rangeHeader=request.headers.get('Range');if(rangeHeader){const range=parseByteRange(rangeHeader,bytes.length);if(range.kind==='unsatisfiable'){headers['Content-Range']=`bytes */${bytes.length}`;headers['Content-Length']='0';return new Response(null,{status:416,headers});}if(range.kind==='range'){const part=bytes.subarray(range.start,range.end+1);headers['Content-Range']=`bytes ${range.start}-${range.end}/${bytes.length}`;headers['Content-Length']=String(part.length);return new Response(part,{status:206,headers});}}}
    return new Response(bytes,{headers});
  }
  if(path==='/api/export'&&method==='GET')return new Response(await exportBundle(library),{headers:{'Content-Type':'application/gzip','Content-Disposition':'attachment; filename="lingbranch.lingbranch.json.gz"'}});
  if(path==='/api/tools'&&method==='POST'){const input=v.parse(z.object({name:z.string().max(100),arguments:z.record(z.unknown())}).strict(),await jsonBody(request,29*1024*1024));return json(await executeTool(library,input.name,input.arguments));}
  v.fail('not_found','接口不存在。',404);
}
