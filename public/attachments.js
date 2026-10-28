const valid=id=>/^[a-f0-9]{64}$/.test(id);
export function renderAttachments(ids=[]) {
  const group=document.createElement('div');group.className='attachment-gallery';
  for(const id of ids.filter(valid)){
    const link=document.createElement('a');link.href=`/api/attachments/${id}/content`;link.target='_blank';link.rel='noopener';
    const image=document.createElement('img');image.src=link.href;image.alt="Saved image";image.loading='lazy';image.onerror=()=>{image.replaceWith(document.createTextNode("Image temporarily unavailable. Check synchronization status."));};link.append(image);group.append(link);
  }
  return group;
}
export function createImagePicker({form,input,storageKey,notify,onChange=()=>{},chat=false}) {
  let saved;try{saved=JSON.parse(sessionStorage.getItem(storageKey));}catch{}
  let scope=saved?.scope||crypto.randomUUID();
  let rows=Array.isArray(saved?.rows)?saved.rows.filter(r=>valid(r.id)).slice(0,3):[];
  const controls=document.createElement('div');controls.className='attachment-controls';
  const gallery=document.createElement('div');gallery.className='attachment-gallery';gallery.setAttribute('aria-live','polite');
  const hint=document.createElement('p');hint.className='composer-hint';hint.textContent=(chat?"Save only by default. Choose image analysis or image plus web below.":"Images are saved without calling a model.")+"Up to 3 images, 10 MiB each and 20 MiB total. Metadata is removed, images resized and saved as WebP, then synchronized with your personal repository. Uploaded originals are not retained long term.";
  function picker(label,camera){const button=document.createElement('button');button.type='button';button.textContent=label;const file=document.createElement('input');file.type='file';file.accept='image/jpeg,image/png,image/webp';file.hidden=true;file.multiple=!camera;if(camera)file.setAttribute('capture','environment');button.onclick=()=>file.click();file.onchange=()=>{void add(file.files);file.value='';};controls.append(button,file);}
  picker("Add images",false);picker("Take photo",true);form.append(controls,gallery,hint);
  const persist=()=>sessionStorage.setItem(storageKey,JSON.stringify({scope,rows:rows.filter(r=>r.id).map(({id,width,height,bytes,inputBytes})=>({id,width,height,bytes,inputBytes}))}));
  function draw(){gallery.replaceChildren();for(const row of rows){const item=document.createElement('div');item.className='attachment-preview';
    const label=document.createElement('small');label.textContent=row.error||row.progress||"Received; archived after submission";
    if(row.id){const img=document.createElement('img');img.src=`/api/attachments/${row.id}/content`;img.alt="Unsaved image preview";item.append(img);}
    item.append(label);
    if(row.error){const retry=document.createElement('button');retry.type='button';retry.textContent="Retry upload";retry.onclick=()=>void upload(row);item.append(retry);}
    const remove=document.createElement('button');remove.type='button';remove.textContent="Remove";remove.disabled=row.uploading;remove.onclick=async()=>{try{if(row.id)await fetch(`/api/attachments/${row.id}/delete`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({draftId:scope})}).then(async r=>{if(!r.ok)throw Error((await r.json()).error);});rows=rows.filter(r=>r!==row);persist();draw();}catch(e){notify(e.message);}};item.append(remove);gallery.append(item);
  }onChange();}
  async function upload(row){row.uploading=true;row.error='';row.progress="Waiting to upload...";draw();try{
    const result=await new Promise((resolve,reject)=>{const req=new XMLHttpRequest();req.open('POST','/api/attachments');req.timeout=30000;req.setRequestHeader('Content-Type',row.file.type);req.setRequestHeader('X-Aipa-Draft',scope);req.setRequestHeader('Idempotency-Key',row.key);req.upload.onprogress=e=>{row.progress=e.lengthComputable?`Upload ${Math.round(e.loaded/e.total*100)}%`:"Uploading...";draw();};req.onload=()=>{try{const data=JSON.parse(req.responseText);if(req.status>=200&&req.status<300)resolve(data);else reject(Error(data.error||"Upload failed"));}catch{reject(Error("Invalid upload response"));}};req.onerror=req.ontimeout=()=>reject(Error("Upload interrupted. Images and text are preserved; retry is available."));req.send(row.file);});
    if(rows.some(r=>r!==row&&r.id===result.id)){rows=rows.filter(r=>r!==row);notify("This image is already in the draft");}else Object.assign(row,result,{progress:''});persist();
  }catch(e){row.error=e.message;notify(e.message);}finally{row.uploading=false;draw();}}
  async function add(files){for(const file of Array.from(files||[])){if(!['image/jpeg','image/png','image/webp'].includes(file.type)){notify("JPEG, PNG, and WebP only; convert HEIC or GIF first");continue;}if(rows.length>=3||file.size>10*1024*1024||rows.reduce((n,r)=>n+(r.inputBytes||0),0)+file.size>20*1024*1024){notify("Image count or size limit exceeded");continue;}const row={key:crypto.randomUUID(),file,inputBytes:file.size};rows.push(row);await upload(row);}}
  input.addEventListener('paste',e=>{const files=Array.from(e.clipboardData?.files||[]);if(files.length){e.preventDefault();void add(files);}});
  form.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();});form.addEventListener('drop',e=>{if(e.dataTransfer.files.length){e.preventDefault();void add(e.dataTransfer.files);}});
  draw();return {scope:()=>scope,ids:()=>{if(rows.some(r=>!r.id||r.uploading))throw Error("Wait for uploads to finish, or retry/remove failed images");return rows.map(r=>r.id);},hasImages:()=>rows.length>0,clear:()=>{rows=[];scope=crypto.randomUUID();sessionStorage.removeItem(storageKey);draw();}};
}
