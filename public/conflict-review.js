export function createConflictReviewPanel({container,request,notify,newId=()=>crypto.randomUUID()}){
 if(!container)return{load:async()=>{}};
 container.className='conflict-review';
 const doc=container.ownerDocument,el=(tag,text)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
 let pending=false,currentId=null;
 async function show(id){
  if(pending)return;
  const view=await request('/api/main/conflict-reviews/'+id);currentId=id;container.replaceChildren();
  container.append(el('h4',"Conflict "+id),el('p',"Selection replaces the entire file. Disputes, withdrawals, and confirmation restrictions from other sources remain effective. This action does not confirm model-generated facts."));
  for(const operation of view.pendingOperations||[]){
   const card=el('article');card.append(el('p',"Unfinished decision: "+operation.path+"; reason: "+operation.reason));
   const retry=el('button',"Review this decision outcome and retry");retry.type='button';retry.onclick=()=>submit(id,{id:operation.id,path:operation.path,choice:operation.choice,revision:operation.revision,reason:operation.reason,confirmed:true},retry);card.append(retry);container.append(card);
  }
  for(const entry of view.entries){
   const card=el('article');card.className='note-card';card.append(el('h4',entry.path+' · '+entry.status),el('p',"Current file"),el('pre',entry.current??" (missing or unsafe to display on this page)"));
   const select=el('select');select.ariaLabel="Choose the complete version to preserve";select.append(el('option',"Select a complete version to preserve"));select.children[0].value='';
   if(entry.canChooseCurrent){const option=el('option',"Preserve the observed current file");option.value='current';select.append(option);}
   for(const variant of entry.variants){card.append(el('p',variant.label),el('pre',variant.hash===null?" (deleted version)":variant.text??" (binary or oversized; state preserved)"));if(variant.selectable){const option=el('option',variant.label);option.value=variant.hash??'delete';select.append(option);}}
   for(const receipt of entry.decisions)card.append(el('p',`Owner decision ${receipt.id}: ${receipt.reason}; result ${receipt.resultHash?.slice(0,12)||"Delete"}`));
   if(entry.status==='recovery-required')card.append(el('p',"If the original operation cannot be verified, review the current file and create a new decision. Its receipt explicitly supersedes the unfinished operation without restoring an old file."));
   const reason=el('textarea');reason.ariaLabel="Decision reason";reason.placeholder="Reason for this selection";reason.maxLength=2000;
   const confirmation=el('input');confirmation.type='checkbox';const label=el('label',"I reviewed the current file and candidates and confirm this selection");label.prepend(confirmation);
   const button=el('button',"Confirm decision");button.type='button';button.className='primary';let operation;
   button.onclick=async()=>{
    if(pending)return;
    if(!operation){if(!select.value||!reason.value?.trim()||!confirmation.checked){notify("Select a version, enter a reason, and confirm first");return;}operation={id:newId(),path:entry.path,choice:select.value,revision:entry.revision,reason:reason.value.trim(),confirmed:true};}
    select.disabled=reason.disabled=confirmation.disabled=true;await submit(id,operation,button);
   };
   card.append(select,reason,label,button);container.append(card);
  }
  const back=el('button',"Back to conflicts");back.type='button';back.className='text-button';back.onclick=()=>{currentId=null;return load();};container.append(back);
 }
 async function submit(id,body,button){
  if(pending)return;pending=true;button.disabled=true;
  try{const result=await request('/api/main/conflict-reviews/'+id+'/decisions',body);if(result.status!=='applied')throw Error(result.summary||"Decision not applied");notify(result.currentMatches?"Decision saved; receipt available":"Decision receipt exists; current file has since changed");pending=false;await show(id);}
  catch(error){notify(error.message);button.textContent="Review this decision outcome and retry";}
  finally{pending=false;button.disabled=false;}
 }
 async function load(){
  if(pending||currentId)return;
  const data=await request('/api/main/conflict-reviews');container.replaceChildren();
  if(!data.conflicts.length){container.append(el('p',"No collected conflict audits."));return;}
  for(const item of data.conflicts){const button=el('button',item.id+' · '+item.status);button.type='button';button.className='text-button';button.onclick=()=>show(item.id).catch(error=>notify(error.message));container.append(button);}
 }
 return{load,show};
}
