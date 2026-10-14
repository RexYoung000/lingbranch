import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { executeTool,toolDefinitions } from '../server/tools.mjs';
import { LibraryError } from '../server/validation.mjs';
import packageMetadata from '../package.json' with {type:'json'};

export async function handleMcp(request,library,authenticated,message) {
  if(request.method!=='POST')return new Response('Use stateless POST /mcp',{status:405,headers:{Allow:'POST'}});
  if(!authenticated&&message?.method!=='initialize'&&message?.method!=='tools/list'&&message?.method!=='notifications/initialized') {
    return Response.json({jsonrpc:'2.0',id:message?.id??null,error:{code:-32001,message:'Authentication required'}},{status:401});
  }
  const server=new Server({name:'lingbranch',version:packageMetadata.version},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:Object.entries(toolDefinitions).map(([name,tool])=>({name,description:tool.description,inputSchema:zodToJsonSchema(tool.schema,{$refStrategy:'none'}),annotations:{readOnlyHint:!!tool.readOnly,destructiveHint:name.startsWith('remove_'),idempotentHint:true,openWorldHint:false}}))}));
  server.setRequestHandler(CallToolRequestSchema,async call=>{
    try {
      if(!authenticated)throw new LibraryError('unauthorized','请连接此私有站点的插件后访问资料。',401);
      const result=await executeTool(library,call.params.name,call.params.arguments||{});
      return {content:[{type:'text',text:JSON.stringify(result)}]};
    }catch(error){if(!(error instanceof LibraryError))console.error('LingBranch MCP storage failure');return {isError:true,content:[{type:'text',text:JSON.stringify({ok:false,code:error instanceof LibraryError?error.code:'unavailable',message:error instanceof LibraryError?error.message:'存储暂不可用；写入重试须沿用相同参数和标识。'})}]};}
  });
  const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  await server.connect(transport);
  try {return await transport.handleRequest(request,{parsedBody:message});}
  finally {await server.close();}
}
