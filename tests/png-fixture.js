import zlib from 'node:zlib';
// Same layout as the site: PNG signature, IHDR/IDAT decoys, then a "roUd" chunk of [flag, payload].
export function wrap(payload,deflate=false) {
  const chunk=(type,data)=>{const head=Buffer.alloc(8);head.writeUInt32BE(data.length);head.write(type,4,'latin1');return Buffer.concat([head,data,Buffer.alloc(4)]);};
  const body=Buffer.concat([Buffer.from([deflate?1:0]),deflate?zlib.deflateSync(payload):Buffer.from(payload)]);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',Buffer.alloc(13)),chunk('IDAT',Buffer.alloc(40,7)),chunk('roUd',body),chunk('IEND',Buffer.alloc(0))]);
}
