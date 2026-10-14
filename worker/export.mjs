import { sha256 } from '@noble/hashes/sha2.js';
import { base64Chunks } from '../server/encoding.mjs';
import * as v from '../server/validation.mjs';

// Preserve the current local restore format without materializing all R2 files in memory.
export async function exportBundle(library) {
  const snapshot=await library.snapshot(),encoder=new TextEncoder();
  const snapshotJson=JSON.stringify(v.canonical(snapshot));
  const files=[...new Map(snapshot.attachments.map(f=>[f.sha256,f])).values()].sort((a,b)=>a.sha256.localeCompare(b.sha256));
  const estimated=encoder.encode(snapshotJson).length+files.reduce((n,f)=>n+Math.ceil(f.bytes/3)*4+70,0)+300;
  if(estimated>128*1024*1024)v.fail('too_large','资料包超过首版 128 MiB 限制，导出未完成。',413);
  async function* payload() {
    yield '{"blobs":{';
    for(let i=0;i<files.length;i++) {
      const file=files[i];yield `${i?',':''}${JSON.stringify(file.sha256)}:"`;
      const {bytes}=await library.readAttachment(file.id);
      yield* base64Chunks(bytes);yield '"';
    }
    yield `},"snapshot":${snapshotJson}}`;
  }
  // Validate originals and checksum the canonical payload before responding.
  const hasher=sha256.create();
  for await(const chunk of payload())hasher.update(encoder.encode(chunk));
  const digest=Array.from(hasher.digest(),b=>b.toString(16).padStart(2,'0')).join('');
  async function* document() {
    yield `{"format":"lingbranch","version":3,"sha256":"${digest}","payload":`;
    yield* payload();yield '}';
  }
  const iterator=document();
  const body=new ReadableStream({
    async pull(controller) {try {const next=await iterator.next();if(next.done)controller.close();else controller.enqueue(encoder.encode(next.value));}catch(error){controller.error(error);}},
    async cancel() {await iterator.return();},
  });
  return body.pipeThrough(new CompressionStream('gzip'));
}
