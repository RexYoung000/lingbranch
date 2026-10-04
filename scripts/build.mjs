import { build } from 'vite';
import { access,cp,mkdir,readFile,rm,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildWorker } from './worker-build.mjs';

const hosting=resolve('.openai/hosting.json');
const hasHosting=await access(hosting).then(()=>true,()=>false);
const site=process.argv.includes('--site')||hasHosting;
if(!site){await build({configFile:resolve('vite.config.mjs')});}
else {
  if(!hasHosting)throw new Error('Create this Site with Sites, then persist .openai/hosting.json before building.');
  await rm('dist',{recursive:true,force:true});
  await build({configFile:resolve('vite.config.mjs'),build:{outDir:resolve('dist/client')}});
  await buildWorker(resolve('dist/server'));
  await mkdir('dist/.openai',{recursive:true});await cp(hosting,'dist/.openai/hosting.json');
  await cp('drizzle','dist/.openai/drizzle',{recursive:true});
  await writeFile('dist/server/wrangler.json',JSON.stringify({name:'lingbranch-local',main:'index.js',compatibility_date:'2026-05-15',compatibility_flags:['nodejs_compat'],assets:{directory:'../client',binding:'ASSETS',run_worker_first:true},d1_databases:[{binding:'DB',database_name:'lingbranch-local',database_id:'00000000-0000-4000-8000-000000000000',migrations_dir:'../../drizzle'}],r2_buckets:[{binding:'BUCKET',bucket_name:'lingbranch-local-files'}]},null,2)+'\n');
  const manifest=JSON.parse(await readFile(hosting));if(!manifest.d1||!manifest.r2||!manifest.capabilities?.includes('mcp'))throw new Error('Sites build requires the declared D1, R2 and MCP capabilities.');
}
