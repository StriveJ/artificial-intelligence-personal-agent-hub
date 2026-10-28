import sharp from 'sharp';
sharp.cache(false); sharp.concurrency(1);
try {
  const chunks=[]; let size=0;
  for await (const chunk of process.stdin) { size+=chunk.length; if(size>10*1024*1024) throw Error(); chunks.push(chunk); }
  const bytes=Buffer.concat(chunks), image=sharp(bytes,{limitInputPixels:20_000_000,failOn:'warning'});
  const meta=await image.metadata();
  if(!['jpeg','png','webp'].includes(meta.format) || (meta.pages||1)!==1 || !meta.width || !meta.height) throw Error();
  const {data,info}=await image.autoOrient().resize({width:2560,height:2560,fit:'inside',withoutEnlargement:true}).webp({quality:85}).toBuffer({resolveWithObject:true});
  if(data.length>5*1024*1024) throw Error();
  process.stdout.write(JSON.stringify({format:meta.format,width:info.width,height:info.height,data:data.toString('base64')}));
} catch { process.stderr.write("Image cannot be decoded or exceeds processing limits"); process.exitCode=1; }
