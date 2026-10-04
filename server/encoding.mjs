// Browser/Worker/Node compatible encoding. Each base64 chunk ends on a 3-byte boundary.
export function* base64Chunks(bytes) {
  for (let start=0; start<bytes.length; start+=49152) {
    yield btoa(String.fromCharCode(...bytes.subarray(start,start+49152)));
  }
}
export const encodeBase64 = bytes => [...base64Chunks(bytes)].join('');
export function decodeBase64(value) {
  let decoded;
  try { decoded=atob(value); } catch { throw new Error('invalid base64'); }
  // Avoid Uint8Array.from(string)'s large temporary iterator list in a 128 MiB Worker.
  const bytes=new Uint8Array(decoded.length);
  for(let i=0;i<decoded.length;i++)bytes[i]=decoded.charCodeAt(i);
  return bytes;
}
export const encodeCursor = value => encodeBase64(new TextEncoder().encode(JSON.stringify(value))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
export const decodeCursor = value => JSON.parse(new TextDecoder().decode(decodeBase64(value.replace(/-/g,'+').replace(/_/g,'/'))));
