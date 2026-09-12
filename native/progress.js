export function progressReader(notify) {
  let buffer='',block={};
  return chunk=>{
    buffer+=chunk.toString();const lines=buffer.split('\n');buffer=lines.pop();
    for(const raw of lines) {
      const line=raw.trim(), at=line.indexOf('=');if(at<0)continue;
      block[line.slice(0,at)]=line.slice(at+1);
      if(!line.startsWith('progress='))continue;
      let seconds=Number(block.out_time_us ?? block.out_time_ms)/1e6;
      if(!Number.isFinite(seconds)) {
        const parts=(block.out_time || '').split(':').map(Number);
        seconds=parts.length===3 ? parts[0]*3600+parts[1]*60+parts[2] : 0;
      }
      const bytes=Number(block.total_size),speed=Number.parseFloat(block.speed);
      notify({type:'progress',seconds:Math.max(0,seconds || 0),bytes:Number.isFinite(bytes)?bytes:0,speed:Number.isFinite(speed)?speed:null});
      block={};
    }
  };
}
