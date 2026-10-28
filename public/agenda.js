const el=(tag,className='',text)=>{const n=document.createElement(tag);n.className=className;if(text!==undefined)n.textContent=text;return n;};
const labels={open:"Upcoming",completed:"Completed",cancelled:"Cancelled",conflicted:"Needs review",ongoing:"In progress",upcoming:"Upcoming",overdue:"Overdue",elapsed:"Time passed"};
export function agendaWhen(item){
  if(item.all_day){if(item.kind==='deadline'){const due=item.end_date_exclusive?new Date(Date.parse(item.end_date_exclusive+'T00:00:00Z')-86400000).toISOString().slice(0,10):item.start_date;return `${due} Due that day`;}return `${item.start_date} All day${item.end_date_exclusive&&new Date(item.end_date_exclusive)-new Date(item.start_date)>86400000?" (multiple days)":''}`;}
  if(!item.event_at)return '';
  return new Intl.DateTimeFormat('en',{timeZone:item.time_zone||'Asia/Shanghai',month:'2-digit',day:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(item.event_at))+' '+(item.time_zone||'Asia/Shanghai')+(item.kind==='deadline'?" before":'');
}
export function createAgendaUI({api,notify,getProfile,onChanged=()=>{}}){
  const previews=new Set();let dialog,list,more,meta,result,input,consent,submit,nextOffset=null,loading=false;
  const saved=(key,value)=>{try{if(value===undefined)return localStorage.getItem(key);if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);}catch{return null;}};
  const clearPending=id=>{if(saved('aipa-agenda-pending')===id)saved('aipa-agenda-pending',null);};
  function operationCard(operation,onApplied=()=>{}){
    const box=el('div','agenda-operation');
    function paint(op){
      box.replaceChildren();box.append(el('p','',op.message));
      if(op.warning)box.append(el('p','notice',op.warning));
      const item=op.plan?.fields||op.plan?.current;
      if(item)box.append(el('p','muted',`${item.title} · ${agendaWhen(item)}${item.priority==='high'?" · ★ Important":''}`));
      if(op.status==='pending'){
        const confirm=el('button','primary',"Confirm action");confirm.type='button';
        confirm.onclick=async()=>{confirm.disabled=true;try{const done=await api('/api/agenda/confirm',{id:op.operationId,confirmed:true});clearPending(op.operationId);paint(done);await onApplied(done);await onChanged();await refresh();}catch(e){notify(e.message);confirm.disabled=false;}};
        const dismiss=el('button','text-button',"Not now");dismiss.type='button';dismiss.onclick=()=>{clearPending(op.operationId);box.remove();};box.append(confirm,dismiss);
      }
    }
    paint(operation);return box;
  }
  function drawPreview(target,data,live){
    target.replaceChildren();const head=el('div','list-heading');head.append(el('h3','',"Agenda"));
    const all=el('button','text-button',"View all");all.type='button';all.onclick=()=>void openAll().catch(e=>notify(e.message));head.append(all);target.append(head);
    if(!data){target.append(el('p','muted',"Agenda temporarily unavailable. Check again later."));return;}
    if(!data.items.length)target.append(el('p','muted',data.invalid||data.conflicts?"Some agenda items need review. Open the full list.":"No upcoming agenda items."));
    const rows=el('ol','agenda-preview');
    for(const item of data.items.slice(0,3)){
      const row=el('li');row.append(el('time','agenda-time',agendaWhen(item)+(item.temporal==='ongoing'?" · In progress":'')),el('span','agenda-title',item.title));
      if(item.priority==='high'){const mark=el('span','agenda-important','★');mark.setAttribute('aria-label',"Important agenda item");row.append(mark);}rows.append(row);
    }
    target.append(rows);
    if(data.invalid||data.conflicts)target.append(el('p','notice',`There are ${data.invalid+data.conflicts} records need review in the full agenda list.`));
    target.append(el('small','muted',`${live?"Main Hub agenda":"Current agenda snapshot"} · ${new Date(data.asOf).toLocaleString('en',{timeZone:data.timeZone||'Asia/Shanghai'})} ${data.timeZone||'Asia/Shanghai'} Updated`));
  }
  function mountPreview(target,data,{live=false}={}){const box=el('section','agenda-card');target.append(box);drawPreview(box,data,live);if(live)previews.add(box);return box;}
  async function refresh(){
    for(const p of previews)if(!p.isConnected)previews.delete(p);
    if(!previews.size)return;
    const data=await api('/api/agenda?mode=preview');for(const p of previews)drawPreview(p,data,true);
  }
  async function requestAction(text,targetId,action){
    if(!consent.checked){notify("First allow this description and necessary agenda candidates to be interpreted by the current model");return;}
    submit.disabled=true;
    const clearDraft=()=>{if(!targetId&&input.value.trim()===text){input.value='';saved('aipa-agenda-draft',null);}};
    try{
      const op=await api('/api/agenda/actions',{id:crypto.randomUUID(),text,targetId,action,consent:true,modelProfileVersion:getProfile().version});
      if(op.status==='pending')saved('aipa-agenda-pending',op.operationId);
      result.replaceChildren(operationCard(op,async()=>{clearDraft();await loadAll(true);}));
      if(op.status==='applied'){clearDraft();await loadAll(true);await onChanged();await refresh();}
    }catch(e){notify(e.message);}finally{submit.disabled=false;}
  }
  async function loadAll(reset=false){
    if(loading)return;loading=true;more.disabled=true;
    try{
      const data=await api(`/api/agenda?offset=${reset?0:nextOffset||0}&limit=50`);
      if(reset)list.replaceChildren();meta.textContent=`Total ${data.total} items${data.invalid?` · ${data.invalid} unreadable records`:''}${data.conflicts?` · ${data.conflicts} records need review`:''}`;
      if(!data.total&&reset)list.append(el('p','empty-state',data.invalid?"Agenda records cannot be read right now. Original files are preserved; inspect them and retry.":"No agenda items yet. Describe something to schedule above."));
      for(const item of data.items){
        const row=el('li','agenda-full-row');row.append(el('time','agenda-time',agendaWhen(item)),el('strong','',item.title+(item.priority==='high'?' ★':'')),el('span','muted',labels[item.status==='open'?item.temporal:item.status]||item.status));
        const actions=el('div','agenda-row-actions');
        for(const [action,label] of item.status==='open'?[['cancel',"cancel"],['complete',"complete"]]:item.status==='cancelled'?[['restore',"restore"]]:[]){
          const button=el('button','text-button',label);button.type='button';button.onclick=()=>void requestAction(`${label} agenda item: ${item.title}，${agendaWhen(item)}`,item.id,action);actions.append(button);
        }
        row.append(actions);list.append(row);
      }
      nextOffset=data.nextOffset;more.hidden=nextOffset===null;
    }finally{loading=false;more.disabled=false;}
  }
  async function openAll(){
    if(!dialog){
      dialog=el('dialog','agenda-dialog');dialog.setAttribute('aria-label',"All agenda items");const close=el('button','dialog-close','×');close.type='button';close.setAttribute('aria-label',"Close agenda list");close.onclick=()=>dialog.close();
      const form=el('form','agenda-form');const label=el('label','',"Describe an agenda action");input=el('textarea');input.rows=3;input.maxLength=4000;input.placeholder="For example: device integration tomorrow at 3 PM; or cancel a meeting next week";input.value=saved('aipa-agenda-draft')||'';input.oninput=()=>saved('aipa-agenda-draft',input.value);label.append(input);
      const consentLabel=el('label','consent');consent=el('input');consent.type='checkbox';consentLabel.append(consent,document.createTextNode("Allow the current model to interpret this description and necessary candidate agenda items."));
      submit=el('button','primary',"Interpret and prepare action");submit.type='submit';form.append(label,consentLabel,submit);form.onsubmit=e=>{e.preventDefault();if(input.value.trim())void requestAction(input.value.trim());};
      result=el('div');result.setAttribute('aria-live','polite');meta=el('p','muted');list=el('ol','agenda-full-list');more=el('button','text-button',"Load more agenda items");more.type='button';more.onclick=()=>void loadAll().catch(e=>notify(e.message));
      dialog.append(close,el('h2','',"All agenda items"),form,result,meta,list,more);document.body.append(dialog);
    }
    if(!dialog.open)dialog.showModal();await loadAll(true);
    const pending=saved('aipa-agenda-pending');
    if(pending)try{const op=await api('/api/agenda/actions/'+encodeURIComponent(pending));result.replaceChildren(operationCard(op,async()=>{if(input.value.trim()===op.requestText){input.value='';saved('aipa-agenda-draft',null);}await loadAll(true);}));if(op.status!=='pending')clearPending(pending);}catch{clearPending(pending);}
  }
  const timer=setInterval(()=>{if(!document.hidden&&previews.size)void refresh().catch(()=>{});},60000);
  window.addEventListener('pagehide',event=>{if(!event.persisted)clearInterval(timer);});
  return {mountPreview,openAll,operationCard,refresh};
}
