import { t, setText, setUiAttribute } from './i18n.js';
export function createConflictReviewPanel({container,request,notify,newId=()=>crypto.randomUUID()}){
 if(!container)return{load:async()=>{}};
 container.className='conflict-review';
 const doc=container.ownerDocument,el=(tag,text)=>{const node=doc.createElement(tag);if(text!==undefined)setText(node, text);return node;};
 let pending=false,currentId=null;
 async function show(id){
  if(pending)return;
  const view=await request('/api/main/conflict-reviews/'+id);currentId=id;container.replaceChildren();
  container.append(el('h4', () => (t('{0}{1}', t("Conflict "), id))),el('p', () => (t("Selection replaces the entire file. Disputes, withdrawals, and confirmation restrictions from other sources remain effective. This action does not confirm model-generated facts."))));
  for(const operation of view.pendingOperations||[]){
   const card=el('article');card.append(el('p', () => (t('{0}{1}', t('{0}{1}', t('{0}{1}', t("Unfinished decision: "), operation.path), t("; reason: ")), operation.reason))));
   const retry=el('button', () => (t("Review this decision outcome and retry")));retry.type='button';retry.onclick=()=>submit(id,{id:operation.id,path:operation.path,choice:operation.choice,revision:operation.revision,reason:operation.reason,confirmed:true},retry);card.append(retry);container.append(card);
  }
  for(const entry of view.entries){
   const card=el('article');card.className='note-card';card.append(el('h4', () => (t('{0}{1}', t('{0}{1}', entry.path, ' · '), entry.status))),el('p', () => (t("Current file"))),el('pre', () => ((entry.current ?? t(" (missing or unsafe to display on this page)")))));
   const select=el('select');setUiAttribute(select, 'aria-label', () => (t("Choose the complete version to preserve")));select.append(el('option', () => (t("Select a complete version to preserve"))));select.children[0].value='';
   if(entry.canChooseCurrent){const option=el('option', () => (t("Preserve the observed current file")));option.value='current';select.append(option);}
   for(const variant of entry.variants){card.append(el('p', () => (variant.label)),el('pre', () => ((variant.hash===null ? t(" (deleted version)") : (variant.text ?? t(" (binary or oversized; state preserved)"))))));if(variant.selectable){const option=el('option', () => (variant.label));option.value=variant.hash??'delete';select.append(option);}}
   for(const receipt of entry.decisions)card.append(el('p', () => (t("Owner decision {0}: {1}; result {2}", receipt.id, receipt.reason, (receipt.resultHash?.slice(0,12) || t("Delete"))))));
   if(entry.status==='recovery-required')card.append(el('p', () => (t("If the original operation cannot be verified, review the current file and create a new decision. Its receipt explicitly supersedes the unfinished operation without restoring an old file."))));
   const reason=el('textarea');setUiAttribute(reason, 'aria-label', () => (t("Decision reason")));setUiAttribute(reason, 'placeholder', () => (t("Reason for this selection")));reason.maxLength=2000;
   const confirmation=el('input');confirmation.type='checkbox';const label=el('label', () => (t("I reviewed the current file and candidates and confirm this selection")));label.prepend(confirmation);
   const button=el('button', () => (t("Confirm decision")));button.type='button';button.className='primary';let operation;
   button.onclick=async()=>{
    if(pending)return;
    if(!operation){if(!select.value||!reason.value?.trim()||!confirmation.checked){notify(t("Select a version, enter a reason, and confirm first"));return;}operation={id:newId(),path:entry.path,choice:select.value,revision:entry.revision,reason:reason.value.trim(),confirmed:true};}
    select.disabled=reason.disabled=confirmation.disabled=true;await submit(id,operation,button);
   };
   card.append(select,reason,label,button);container.append(card);
  }
  const back=el('button', () => (t("Back to conflicts")));back.type='button';back.className='text-button';back.onclick=()=>{currentId=null;return load();};container.append(back);
 }
 async function submit(id,body,button){
  if(pending)return;pending=true;button.disabled=true;
  try{const result=await request('/api/main/conflict-reviews/'+id+'/decisions',body);if(result.status!=='applied')throw Error(result.summary||"Decision not applied");notify((result.currentMatches ? t("Decision saved; receipt available") : t("Decision receipt exists; current file has since changed")));pending=false;await show(id);}
  catch(error){notify(error.message);setText(button, () => (t("Review this decision outcome and retry")));}
  finally{pending=false;button.disabled=false;}
 }
 async function load(){
  if(pending||currentId)return;
  const data=await request('/api/main/conflict-reviews');container.replaceChildren();
  if(!data.conflicts.length){container.append(el('p', () => (t("No collected conflict audits."))));return;}
  for(const item of data.conflicts){const button=el('button', () => (t('{0}{1}', t('{0}{1}', item.id, ' · '), item.status)));button.type='button';button.className='text-button';button.onclick=()=>show(item.id).catch(error=>notify(error.message));container.append(button);}
 }
 return{load,show};
}
