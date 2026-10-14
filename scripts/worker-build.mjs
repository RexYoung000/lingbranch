import { build } from 'vite';
import { resolve } from 'node:path';
export async function buildWorker(directory) {
  // Workers have no DOM; use dependencies' workerd exports for Markdown parsing.
  return build({configFile:false,publicDir:false,ssr:{target:'webworker',noExternal:true,resolve:{conditions:['workerd','module','production']}},build:{ssr:resolve('worker/index.mjs'),target:'es2022',outDir:directory,emptyOutDir:true,minify:false,rolldownOptions:{output:{entryFileNames:'index.js'}}}});
}
