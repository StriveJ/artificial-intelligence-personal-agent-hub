const STATUS_LABELS = { started: "In progress", success: "Success", partial: "Partial", blocked: "Needs attention", deferred: "Deferred", unknown: "Outcome needs review", failed: "Failed", error: "Failed", info: "Record" };
const KIND_LABELS = { task: "Scheduled tasks", device: "Devices", sync: "Sync", system: "System", maintenance: "Maintenance" };
export function formatStamp(value, timeZone = 'Asia/Shanghai') {
  const formatter=new Intl.DateTimeFormat('en', { timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
const dayKey = (value, zone) => formatStamp(value, zone).slice(0, 10);
const dayLabel = (value, timeZone) => new Intl.DateTimeFormat('en', { timeZone, year:'numeric', month:'long', day:'numeric', weekday:'long' }).format(new Date(value));
export function supportSummary(value){
  if(!value)return 'No framework compatibility check recorded';
  if(value.core?.program?.status==='restart-required')return 'Framework code has changed. Restart Hub before continuing.';
  if(value.combination?.status!=='declared')return 'Framework capabilities are not fully verified. Check version compatibility.';
  const labels={required_context_unavailable:'Required rule files are unavailable',required_context_private:'Privacy settings block required rules',required_context_exceeds_budget:'Required rules exceed the context budget',context_privacy_unavailable:'Privacy settings cannot be read',context_contract_unsupported:'Framework integrity checks are unsupported',response_language_unavailable:'Response-language configuration is invalid or unreadable'};
  const context=value.context?.status==='blocked'?(labels[value.context.code]||"Rule check failed"):value.context?.status==='checked'?'Latest rule check in this process passed':'Response rules have not been checked in this process';
  return `Core ${value.core?.version||"Unknown"} / Hub ${value.hub?.version||"Unknown"} · ${context}`;
}
export const duration = ms => {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'Less than 1 minute';
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} hours ${rest} minutes` : `${hours} hours`;
  return `${Math.floor(hours / 24)} days ${hours % 24} hours`;
};

export function createDeviceList({ container, formatDate }) {
  const doc = container.ownerDocument, cards = new Map();
  const el = (tag, className, value) => { const node = doc.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; };
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  function create(device) {
    const card = el('article', 'device-card'), head = el('div', 'device-head');
    const dot = el('span', 'status-dot'), name = el('h3'), badge = el('span', 'device-badge');
    head.append(dot, name, badge);
    const role = el('p', 'device-role');
    const facts = el('dl', 'device-facts'), values = {};
    for (const key of ["Status", "Version", "Framework status", "Platform", "Uptime", "Last heartbeat", "Last sync", "Next task"]) { const dd = el('dd'); values[key] = dd; facts.append(el('dt', '', key), dd); }
    card.append(head, role, facts);
    container.append(card);
    const entry = { card, dot, name, badge, role, values, signature: '' };
    cards.set(device.id, entry); return entry;
  }
  return snapshot => {
    const devices = [snapshot.main, ...snapshot.devices];
    const keep = new Set(devices.map(device => device.id));
    for (const [id, entry] of cards) if (!keep.has(id)) { entry.card.remove(); cards.delete(id); }
    const nextTask = (snapshot.tasks || []).filter(task => task.enabled && task.nextRunAt).sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))[0];
    for (const device of devices) {
      const entry = cards.get(device.id) || create(device), signature = JSON.stringify([device, nextTask]);
      if (entry.signature === signature) continue;
      entry.signature = signature;
      const maintenance = device.maintenance === 'maintenance';
      const degraded = device.protocolCompatible === false;
      const statusKey = device.status !== 'online' ? 'offline' : maintenance ? 'maintenance' : degraded ? 'degraded' : 'online';
      entry.dot.className = `status-dot status-${statusKey}`;
      text(entry.name, device.id);
      text(entry.badge, statusKey === 'online' ? "Online" : statusKey === 'offline' ? "Offline" : statusKey === 'maintenance' ? "Under maintenance" : "Protocol incompatible");
      entry.badge.className = `device-badge device-${statusKey}`;
      text(entry.role, device.role === 'main' ? `Main Hub · ${device.label} · Management port ${device.endpoints?.port ?? '—'}${device.endpoints?.publicPort ? ` / public ${device.endpoints.publicPort}` : ''}` : `Sub Hub · Instance task ${device.taskBusy ? "active (sync deferred)" : "Idle"}`);
      const values = {
        "Status": statusKey === 'online' ? "Online" + (device.idle === false ? " (busy)" : device.idle === true ? " (idle)" : '')
          : statusKey === 'offline' ? "Offline" : statusKey === 'maintenance' ? 'Under maintenance; not accepting new tasks' : 'Online, but protocol incompatible; no tasks dispatched',
        "Version": `${device.releaseId || "Unknown"}${device.testMode ? " · Test mode" : ''}${device.deploymentGeneration ? ` · Generation ${device.deploymentGeneration}` : ''}`,
        "Framework status":device.role==='main'?supportSummary(device.diagnostics):'Sub Hub has not reported Core diagnostics; protocol status is shown separately',
        "Platform": device.host ? `${device.host.name} · ${device.host.platform}/${device.host.arch} · Node ${device.host.node}` : `${device.platform || "Unknown"}/${device.arch || ''}`,
        "Uptime": device.uptimeMs !== undefined ? duration(device.uptimeMs) : '—',
        "Last heartbeat": device.lastSeen ? formatDate(device.lastSeen) : device.role === 'main' ? "Local process" : "No records yet",
        "Last sync": device.sync ? `${device.sync.code || device.sync.status || "Recorded"}${device.sync.commit ? ` · ${device.sync.commit}` : ''}${device.sync.pushed ? " · Pushed" : device.sync.pushSuppressed ? " · Push suppressed in test mode" : ''}` : device.role === 'main' ? "Performed by scheduled tasks" : "No synchronization result yet",
        "Next task": device.role === 'main' && nextTask ? `${nextTask.label} · ${formatDate(nextTask.nextRunAt)}` : device.role === 'main' ? 'No scheduled tasks' : "Dispatched by main Hub",
      };
      for (const [key, value] of Object.entries(values)) text(entry.values[key], value);
    }
  };
}

export function visibleActivity(all) {
  const finished = new Set(all.filter(item => item.status !== 'started' && item.detail?.runId).map(item => item.detail.runId));
  return all.filter(item => item.status !== 'started' || !item.detail?.runId || !finished.has(item.detail.runId));
}

export function createActivityTimeline({ container, empty, formatDate, timeZone=()=> 'Asia/Shanghai' }) {
  const doc = container.ownerDocument, nodes = new Map();
  const el = (tag, className, value) => { const node = doc.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; };
  function render(all) {
    const items = visibleActivity(all);
    empty.hidden = items.length > 0;
    const keep = new Set(items.map(item => item.id));
    for (const [id, node] of nodes) if (!keep.has(id)) { node.remove(); nodes.delete(id); }
    let previousDay = null;
    items.forEach((item, index) => {
      let node = nodes.get(item.id);
      if (!node) {
        node = el('li', 'activity-item');
        node.append(el('time', 'activity-time'), el('span', 'activity-dot'), el('span', 'activity-kind'), el('span', 'activity-text'), el('span', 'activity-detail'));
        nodes.set(item.id, node);
      }
      node.dataset.kind = item.kind; node.dataset.status = item.status;
      node.querySelector('.activity-time').textContent = `[${formatStamp(item.at,timeZone())}]`;
      node.querySelector('.activity-time').dateTime = item.at;
      node.querySelector('.activity-dot').className = `activity-dot activity-${item.status}`;
      node.querySelector('.activity-kind').textContent = KIND_LABELS[item.kind] || item.kind;
      node.querySelector('.activity-text').textContent = item.summary;
      const detail = [];
      if (item.detail?.changedFiles !== undefined) detail.push(`Changed ${item.detail.changedFiles} files`);
      if (item.detail?.commit) detail.push(`Commit ${item.detail.commit}`);
      if (item.detail?.pushed === true) detail.push("Pushed");
      if (item.detail?.durationMs !== undefined) detail.push(`Duration ${Math.max(1, Math.round(item.detail.durationMs / 1000))} seconds`);
      const detailNode = node.querySelector('.activity-detail');
      detailNode.textContent = detail.length ? `${STATUS_LABELS[item.status] || item.status} · ${detail.join(' · ')}` : STATUS_LABELS[item.status] || item.status;
      const current = container.children[index];
      if (current !== node) container.insertBefore(node, current || null);
      const day = dayKey(item.at,timeZone());
      if (day !== previousDay) { previousDay = day; node.dataset.dayStart = day; node.title = dayLabel(item.at,timeZone()); }
      else delete node.dataset.dayStart;
    });
  }
  return render;
}

export function recoveryItems(main){
 const reports=Object.entries(main.reports?.maintenanceFailures||{}).map(([key,value])=>{const [kind,date]=key.split('/');return{id:key,label:({daily:"Daily report",monthly:"Monthly report",yearly:"Yearly report",start:"Start workday",close:"Close workday"}[kind]||"Report")+' · '+date,detail:value.summary||"Report incomplete; original content preserved",retry:main.capabilities?.reportRetry===true,report:true};});
 const jobs=Object.entries(main.distillation?.jobs||{}).map(([key,job])=>({id:'distill/'+key,label:"Distillation job"+(/^\d{4}-\d{2}-\d{2}/.test(key)?' · '+key.slice(0,10):''),detail:['model-running','model-unknown'].includes(job.status)?'Model outcome unknown. State is preserved; the model will not be called again automatically.':job.status==='apply-unknown'?'Write receipt requires verification; phase information is preserved':job.status==='complete'?'Candidate processing completed; items awaiting owner confirmation still need explicit confirmation':job.status,retry:false,phases:(job.candidates||[]).map(c=>({id:c.operationId,phase:c.phase,queueId:c.queueId||null}))}));
 return [...reports,...jobs];
}
export function createRecoveryPanel({container,request,refresh,notify}){
 if(!container)return ()=>{};
 const pending=new Set(),doc=container.ownerDocument;
 const node=(tag,text)=>{const el=doc.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
 return main=>{
  container.replaceChildren();const items=recoveryItems(main);
  if(!items.length){container.append(node('p',main.capabilities?.distillationPhases===1?'No reports or distillation jobs need recovery.':'This service does not provide recovery details yet. Update it to view them.'));return;}
  for(const item of items){
   const row=node('article');row.className='note-card';row.append(node('h4',item.label),node('p',item.detail));
   for(const phase of item.phases||[])row.append(node('p',`${phase.id}: ${phase.phase}${phase.queueId?" · Candidate "+phase.queueId:''}`));
   if(item.retry){
    const button=node('button','Retry only this report');button.type='button';button.className='text-button';button.disabled=pending.has(item.id);
    button.onclick=async()=>{
      if(pending.has(item.id))return;pending.add(item.id);button.disabled=true;
      try{const result=await request(item.id);notify(result.summary);}catch(error){notify(error.message);}
      finally{pending.delete(item.id);button.disabled=false;try{await refresh();}catch(error){notify(error.message);}}
    };
    row.append(button);
   }else if(item.report)row.append(node('p','This service version does not support retrying from the page. Update it to enable this action.'));
   container.append(row);
  }
 };
}
