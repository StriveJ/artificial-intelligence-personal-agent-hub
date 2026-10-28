import {createImagePicker,renderAttachments} from './attachments.js';
import {createAgendaUI} from './agenda.js';
import { renderMarkdown } from './markdown.js';
import { createNavigation } from './navigation.js';
import { createTaskList } from './task-list.js';
import { createUpdatePanel } from './updates.js';
import { createDeviceList, createActivityTimeline,createRecoveryPanel } from './status.js';
import {createConflictReviewPanel} from './conflict-review.js';
import {jsonRequest,xhrRequest} from './json-api.js';

const $ = id => document.getElementById(id);
const state = { status: null, chat: null, chats: [], historyMode: 'visible', view: 'chat', polling: null, taskPolling: null, pushPolling: null, statusPolling: null, statusPage: 0, statusFilter: 'all', briefingCustom: { categories: [], sources: [] }, pushId: null, pushVersion: null, pushLoading: false, settingsLoaded: false, pairing: null };
let toastTimer;
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const activeTimeZone=()=>state.timeZone||state.status?.timeZone||'Asia/Shanghai';
const date = value => new Intl.DateTimeFormat('en', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: activeTimeZone() }).format(new Date(value));
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5000); }
const selectedImageMode=()=>document.querySelector('input[name="image-mode"]:checked')?.value||'save';
const resetImageMode=()=>{$('image-mode-save').checked=true;};
const chatImages=createImagePicker({form:$('chat-form'),input:$('message-input'),storageKey:'aipa-chat-images',notify:toast,chat:true,onChange:()=>{if(state.status){resetImageMode();$('send-message').disabled=Boolean(busy());updateVisionConsent();}}});
const noteImages=createImagePicker({form:$('note-form'),input:$('note-input'),storageKey:'aipa-note-images',notify:toast});
function updateVisionConsent(){
  const profile=state.status?.attachments?.visionProfile;
  const visible=chatImages.hasImages();
  $('context-consent-row').hidden=visible;$('web-consent-row').hidden=visible;
  $('web-query-label').hidden=visible||!$('allow-web').checked;
  $('vision-consent-row').hidden=!visible;
  for(const option of document.querySelectorAll('input[name="image-mode"]')){
    option.disabled=option.value!=='save'&&(!profile?.available||option.value==='web'&&(!state.status?.attachments?.imageWeb||!state.webSearch?.ready));
    option.closest('label').title=option.disabled?(!profile?.available?profile?.reason||'Image analysis is not connected':'Search is not ready. You can save or analyze images first.'):'';
  }
  if(!visible||!profile?.available||document.querySelector('input[name="image-mode"]:checked')?.disabled)resetImageMode();
  const provider=(state.webSearch?.providers?.find(p=>p.id===state.webSearch.settings.provider)?.label||'Current search provider').split(/[（(]/)[0].trim();
  const mode=selectedImageMode();
  $('vision-consent-label').textContent=mode==='save'?'Images and descriptions are archived without sending them to a model or search service.':mode==='vision'?`Allow this turn’s text and images to be sent to ${profile.provider} for image analysis.`:`Allow this turn’s text and images to be sent to ${profile.provider} for image analysis, and the necessary public query to ${provider}.`;
  $('vision-consent-detail').textContent=mode==='save'?'Images are normalized and synchronized with your personal repository. This mode does not call a model, access the web, or create long-term memories automatically.':`This turn’s text and selected images are processed by ${profile.provider} / ${profile.requestedModel}.${mode==='web'?`Generate a public search query from the image result and original question, send it to ${provider}, and cite sources in the combined answer.`:''}No personal profile, memories, or other conversations are included. Results do not automatically become long-term memories.`;
}
for(const option of document.querySelectorAll('input[name="image-mode"]'))option.addEventListener('change',updateVisionConsent);
const updatePanel = createUpdatePanel(toast);
const agendaUI=createAgendaUI({api,notify:toast,getProfile:()=>state.status?.model||{},onChanged:async()=>{await refreshCurrent();await loadPushes();}});
$('agenda-open-all').onclick=()=>void agendaUI.openAll().catch(e=>toast(e.message));
$('agenda-settings-form').onsubmit=async event=>{event.preventDefault();try{await api('/api/agenda-settings',{enabled:$('agenda-enabled').checked,dailyAt:$('agenda-time').value});toast('Agenda notification settings saved');}catch(e){toast(e.message);}};
const navigation = createNavigation({ onNavigate: showView, onConnect: () => void showConnection(), notify: toast });
const renderTasks = createTaskList({ list: $('tasks-list'), formatDate: date, onRun: async () => {
  try { await api('/api/tasks/repo-sync/run', {}); await loadTasks(); }
  catch (error) { toast(error.message); throw error; }
} });
function xhrJson(path, body) {
  return xhrRequest(path,body,{onUnauthorized:showLogin});
}
async function api(path, body) {
  return jsonRequest(path,body,{xhr:xhrJson,onUnauthorized:showLogin});
}function showLogin() { navigation.close(); $('history-dialog').close(); $('app').hidden = true; $('login').hidden = false; clearTimeout(state.polling); clearTimeout(state.taskPolling); clearTimeout(state.pushPolling); }
function busy(chat = state.chat) { return chat?.turns.some(turn => ['queued', 'running'].includes(turn.status)); }
function showView(view) {
  state.view = view;
  clearTimeout(state.taskPolling);
  clearTimeout(state.statusPolling);
  for (const name of ['chat', 'notes', 'memory', 'tasks', 'status', 'pushes']) $(`${name}-view`).hidden = name !== view;
  navigation.setActive(view);
  $('view-label').textContent = { chat: "Chat", notes: "Notes", memory: "Memory", tasks: "Scheduled tasks", status: "Runtime status", pushes: "Notifications" }[view];
  if (view === 'notes') void loadNotes().catch(error => toast(error.message));
  if (view === 'tasks') void loadTasks().catch(error => toast(error.message));
  if (view === 'status') void loadStatus().catch(error => toast(error.message));
  if (view === 'pushes') void loadPushes().catch(error => toast(error.message));
  window.scrollTo({ top: 0 });
}
async function refreshChats() {
  const data = await api('/api/chats'); state.chats = data.chats;
  $('history-hidden').textContent = `Hidden${data.hiddenCount ? ` · ${data.hiddenCount}` : ''}`;
  renderChatList($('chat-list'), state.chats);
  if (state.historyMode === 'hidden') renderChatList($('mobile-chat-list'), (await api('/api/chats?visibility=hidden')).chats, true);
  else renderChatList($('mobile-chat-list'), state.chats);
}
function renderChatList(list, chats, hidden = false) {
  const signature = JSON.stringify([hidden, state.chat?.id, chats]);
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature; list.replaceChildren();
  if (!chats.length) list.append(el('p', 'empty-state', hidden ? 'No hidden conversations.' : 'No conversations yet. Your conversations will appear here.'));
  for (const chat of chats) {
    const row = el('div', 'chat-list-row');
    const title=chat.title?.trim()||'Untitled conversation';
    const button = el('button', `chat-title${chat.id === state.chat?.id ? ' selected' : ''}`, title); button.title = title;
    button.disabled = hidden;
    button.onclick = () => loadChat(chat.id).then(() => $('history-dialog').close()).catch(error => toast(error.message));
    const action = el('button', 'chat-visibility', hidden ? "restore" : '×');
    action.type = 'button'; action.setAttribute('aria-label', `${hidden ? "restore" : "Hide from list"} conversation: ${title}`);
    action.title = hidden ? 'Restore to conversation history' : 'Hide from web list; preserve original data';
    action.onclick = async () => {
      action.disabled = true;
      try {
        await api(`/api/chats/${chat.id}/visibility`, { hidden: !hidden });
        if (!hidden && state.chat?.id === chat.id) {
          clearTimeout(state.polling); state.chat = null; sessionStorage.removeItem('aipa-chat'); $('context-consent').checked = false; renderChat();
        }
        await refreshChats(); toast(hidden ? 'Conversation restored to history' : 'Hidden from the web list. Original data is preserved; restore it from Hidden.');
      } catch (error) { action.disabled = false; toast(error.message); }
    };
    row.append(button, action); list.append(row);
  }
}
async function showHistory(mode = 'visible') {
  navigation.close(); state.historyMode = mode;
  $('history-visible').setAttribute('aria-selected', String(mode === 'visible'));
  $('history-hidden').setAttribute('aria-selected', String(mode === 'hidden'));
  if (!$('history-dialog').open) $('history-dialog').showModal();
  try { await refreshChats(); } catch (error) { toast(error.message); }
}
async function loadChat(id) {
  const chat = await api(`/api/chats/${encodeURIComponent(id)}`);
  if (state.chat?.id !== id) $('context-consent').checked = false;
  state.chat = chat; sessionStorage.setItem('aipa-chat', chat.id);
  showView('chat'); renderChat(); await refreshChats(); poll();
}
function renderChat() {
  const active = busy();
  if(state.projectsSupported){const select=$('chat-project'),project=state.chat?.project||'';if(state.chat){if(![...select.options].some(o=>o.value===project))select.append(new Option(project,project));select.value=project;}select.disabled=Boolean(state.chat);}
  $('welcome').hidden = Boolean(state.chat?.turns.length);
  $('send-message').disabled = Boolean(active || state.status?.engineAvailable === false && !chatImages.hasImages());
  const box = $('messages'); box.replaceChildren();
  for (const turn of state.chat?.turns || []) {
    const user = el('div', 'message user'); if(turn.input?.trim())user.append(el('div', 'message-body', turn.input)); if(turn.attachmentIds?.length)user.append(renderAttachments(turn.attachmentIds)); box.append(user);
    const answer = el('div', 'message assistant');
    const identity = el('div', 'answer-identity');
    const avatar = el('img'); avatar.src = '/icon.svg'; avatar.alt = '';
    identity.append(avatar, el('span', '', 'AIPA')); answer.append(identity);
    const content = el('div', 'message-content'); answer.append(content);
    if(turn.analyzeImages)content.append(el('p','composer-hint',turn.status==='completed'?`Images analyzed by ${turn.model?.provider||'DeepSeek'} / ${turn.model?.resolvedModel||turn.model?.requestedModel||'deepseek-flash'} using only this turn’s information.`: 'Image analysis requested. Text and images are saved; completion is shown in this turn’s result.'));
    if(turn.webQuery?.query) content.append(el('p','composer-hint',`${turn.webQuery.mode==='image'?"Image-based search":turn.webQuery.mode==='automatic'?"Automatic search":"Specified search"}: ${turn.webQuery.query}`));
    else if(turn.allowWeb && turn.status==='running') content.append(el('p','composer-hint','Generating a query and searching public sources...'));
    if (['completed','stored'].includes(turn.status)) {
      content.append(renderMarkdown(turn.answer));
      if(turn.agendaOperation)content.append(agendaUI.operationCard(turn.agendaOperation,()=>refreshCurrent()));
      if (!turn.analyzeImages && !Object.hasOwn(turn, 'recall') && /\u4e0a\u5468|\u672c\u5468|\u8fd9\u5468|\u6628\u5929|\u524d\u5929|\u4eca\u5929|\u4e0a\u6708|\u53bb\u5e74|\u6700\u8fd1|\u4e4b\u524d/.test(turn.input)) {
        content.append(el('p', 'notice', 'This older answer did not read work logs. Ask again to search daily reports and session events.'));
      }
      if (turn.sources?.length) {
        const sources = el('details', 'answer-sources');
        sources.append(el('summary', '', `Sources · ${turn.sources.length}`));
        const list = el('ul', 'source-list');
        for (const source of turn.sources) {
          const item = el('li');
          if (source.kind === 'web') {
            const link = el('a', 'source-title', source.title || source.location);
            if (source.url) { link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
            item.append(el('span', 'source-kind', "Web"), link, el('small', 'source-location', source.location));
          } else {
            item.append(el('span', 'source-title', source.title || "Memory excerpt"), el('small', 'source-location', source.location));
          }
          list.append(item);
        }
        sources.append(list);
        content.append(sources);
      }
    } else if (['error', 'interrupted'].includes(turn.status)) {
      if(turn.imageWeb?.recognition?.value?.answer){const saved=el('details','answer-sources');saved.append(el('summary','','Completed image analysis (preserved)'),renderMarkdown(turn.imageWeb.recognition.value.answer));content.append(saved);}
      const error = el('div', 'message-error', turn.error || 'This turn did not complete. Your input is saved.');
      const retry = el('button', 'retry-button', 'Retry this message'); retry.type = 'button'; retry.disabled = Boolean(active);
      const retryConsent=turn.analyzeImages?el('input'):null;
      if(retryConsent){retryConsent.type='checkbox';const label=el('label','consent');label.append(retryConsent,document.createTextNode(turn.allowWeb?'Allow this image and web request to continue: text and images go to DeepSeek; public queries go to the current search provider. Completed steps are reused; interrupted steps may be requested again.':'Allow this text and original images to be sent again to DeepSeek / deepseek-flash for analysis'));error.append(label);}
      retry.onclick = async () => { try { await api(`/api/chats/${state.chat.id}/retry`, { id: turn.id, attachmentIds:turn.attachmentIds||[], analyzeImages:turn.analyzeImages===true, visionConsent:retryConsent?.checked===true,imageWebConsent:turn.analyzeImages&&turn.allowWeb&&retryConsent?.checked===true, visionProfileVersion:turn.analyzeImages?state.status.attachments?.visionProfile?.version:undefined, consent: $('context-consent').checked, engine: state.status.engineId, modelProfileVersion:state.status.modelProfileVersion, ...(turn.attachmentIds?.length?{allowWeb:turn.allowWeb===true,webProfileVersion:turn.allowWeb?state.webSearch?.settings.revision:undefined}:currentWebOptions()) }); await refreshCurrent(); } catch (error) { toast(error.message); } };
      error.append(retry); content.append(error);
    } else {const stages={recognition:'Analyzing images...',query:'Generating a public query from the images and question...',search:'Searching the web...',answer:'Answering using the images and web sources...'};content.append(el('div', 'pending-text', turn.status === 'queued' ? 'Input saved. Waiting for an answer...' : stages[turn.imageWeb?.stage]||(turn.analyzeImages?'Analyzing images...':'Thinking with relevant memories...')));}
    if (turn.recall) {
      const coverage = turn.recall;
      const details = el('details', 'recall-coverage');
      details.append(el('summary', '', `Recall range: ${coverage.from} to ${coverage.to}`));
      if (coverage.report) details.append(el('p', '', `Read: ${coverage.report}`));
      else {
        const found = coverage.days.filter(day => ['summary', 'events', 'timeline'].includes(day.status));
        details.append(el('p', '', `Daily reports or session events read: ${found.map(day => day.date).join(', ') || "None found in this turn"}`));
        const missing = coverage.days.filter(day => day.status === 'missing');
        if (missing.length) details.append(el('p', '', `No usable logs found in this turn: ${missing.map(day => day.date).join(', ')}.This does not imply that no work took place that day.`));
        const blocked = coverage.days.filter(day => day.status === 'blocked');
        if (blocked.length) details.append(el('p', '', `Existing material withheld by privacy rules: ${blocked.map(day => day.date).join(', ')}.This differs from an unsynchronized repository.`));
        for (const day of coverage.days.filter(day => day.status === 'summary' && day.omittedSections?.length)) {
          details.append(el('p', '', `${day.date} Read ${day.readSections.join(', ')}；${day.omittedSections.join(', ')}omitted under privacy rules.`));
        }
        if (coverage.version !== 2 && blocked.length) content.append(el('p', 'notice', 'This older answer used whole-block filtering. Ask again to use the available daily summaries with updated retrieval.'));
      }
      if (coverage.omitted) details.append(el('p', '', 'Some information was withheld from the model by instance privacy rules.'));
      if (coverage.truncated || coverage.limited) details.append(el('p', '', 'This turn uses excerpts or a limited range, and does not cover the entire history.'));
      content.append(details);
    }
    if (turn.warnings?.length) content.append(el('p', 'notice', turn.warnings.join('；')));
    box.append(answer);
  }
}
async function refreshCurrent() {
  if (!state.chat) return;
  const id = state.chat.id;
  const chat = await api(`/api/chats/${id}`);
  if (state.chat?.id !== id) return;
  const changed = JSON.stringify(chat) !== JSON.stringify(state.chat);
  state.chat = chat;
  if (changed) { renderChat(); await refreshChats(); }
  poll();
}
function poll() {
  clearTimeout(state.polling);
  if (!busy() || document.hidden) return;
  state.polling = setTimeout(() => refreshCurrent().catch(() => {
    $('connection-status').textContent = "Reconnecting";
    state.polling = setTimeout(() => refreshCurrent().catch(() => toast('Cannot connect right now. Submitted input remains saved on the Hub device.')), 4000);
  }), 1200);
}
async function newChat() {
  clearTimeout(state.polling); state.chat = null; sessionStorage.removeItem('aipa-chat');
  $('chat-project').value='';$('context-consent').checked = false; showView('chat'); renderChat(); await refreshChats(); $('message-input').focus();
}
async function loadNotes() {
  const { notes } = await api('/api/notes');
  $('notes-list').replaceChildren(); $('notes-count').textContent = notes.length ? `${notes.length} records` : '';
  if (!notes.length) $('notes-list').append(el('p', 'empty-state', 'An idea can start with a single sentence.'));
  for (const note of notes) {
    const card = el('article', 'note-card'); if(note.attachmentIds?.length)card.append(renderAttachments(note.attachmentIds)); card.append(el('div', 'card-body', note.text || "Image note"), el('div', 'card-meta', date(note.created)));
    $('notes-list').append(card);
  }
}
async function loadTasks() {
  void loadMainManagement().catch(() => {});
  clearTimeout(state.taskPolling);
  const { tasks } = await api('/api/tasks');
  renderTasks(tasks);
  const sync = tasks.find(task => task.id === 'repo-sync');
  const warn = sync?.enabled && ['blocked', 'error', 'interrupted'].includes(sync.status);
  $('sync-notice').hidden = !warn;
  $('sync-notice').textContent = warn ? `Repository update incomplete: ${sync.result?.summary || 'Review and retry in Scheduled tasks'}.` : '';
  if (!document.hidden && (state.view === 'tasks' || tasks.some(task => task.status === 'running'))) state.taskPolling = setTimeout(() => loadTasks().catch(error => toast(error.message)), 4000);
}

const renderDevices = createDeviceList({ container: $('status-devices'), formatDate: date });
const renderActivity = createActivityTimeline({ container: $('status-activity'), empty: $('status-activity-empty'), timeZone:activeTimeZone });
const ACTIVITY_PAGE_SIZE = 100;
const STATUS_FILTERS = [
  { id: 'all', label: "All", query: {} },
  { id: 'sync', label: "Sync", query: { kind: ['task'], action: ['repo-sync'] } },
  { id: 'task', label: "Tasks", query: { kind: ['task'] } },
  { id: 'device', label: "Devices", query: { kind: ['device'] } },
  { id: 'system', label: "System", query: { kind: ['system'] } },
  { id: 'failed', label: 'Failures only', query: { status: ['failed', 'error', 'blocked'] } },
];
for (const filter of STATUS_FILTERS) {
  const chip = el('button', 'filter-chip', filter.label);
  chip.type = 'button'; chip.dataset.filter = filter.id; chip.setAttribute('aria-pressed', String(filter.id === state.statusFilter));
  chip.onclick = () => {
    state.statusFilter = filter.id;
    state.statusPage = 0;
    for (const other of document.querySelectorAll('#status-filters .filter-chip')) other.setAttribute('aria-pressed', String(other.dataset.filter === filter.id));
    void loadStatus().catch(error => toast(error.message));
  };
  $('status-filters').append(chip);
}
function goToPage(next) {
  const page = Math.max(0, next);
  if (page === state.statusPage) return;
  state.statusPage = page;
  void loadStatus().catch(error => toast(error.message));
}
$('status-prev').onclick = () => goToPage(state.statusPage - 1);
$('status-next').onclick = () => goToPage(state.statusPage + 1);
async function loadStatus() {
  clearTimeout(state.statusPolling);
  const snapshot = await api('/api/runtime/status');
  state.timeZone=snapshot.timeZone||activeTimeZone();
  renderDevices(snapshot);
  const filter = STATUS_FILTERS.find(item => item.id === state.statusFilter) || STATUS_FILTERS[0];
  const query = new URLSearchParams({ limit: String(ACTIVITY_PAGE_SIZE), offset: String(state.statusPage * ACTIVITY_PAGE_SIZE) });
  for (const kind of filter.query.kind || []) query.append('kind', kind);
  for (const status of filter.query.status || []) query.append('status', status);
  for (const action of filter.query.action || []) query.append('action', action);
  const page = await api(`/api/activity?${query.toString()}`);
  const total = page.total || 0, pages = Math.max(1, Math.ceil(total / ACTIVITY_PAGE_SIZE));
  if (state.statusPage > 0 && state.statusPage >= pages) { state.statusPage = pages - 1; return loadStatus(); }
  renderActivity(page.items);
  $('status-activity-count').textContent = total
    ? `Page ${state.statusPage + 1}/${pages} · filtered ${total} records (total ${page.totalAll ?? total}; retaining latest ${page.retention})`
    : `No matching records (total ${page.totalAll ?? 0}; retaining latest ${page.retention})`;
  $('status-pager').hidden = pages <= 1;
  $('status-page').textContent = `Page ${state.statusPage + 1} / ${pages} pages`;
  $('status-prev').disabled = state.statusPage === 0;
  $('status-next').disabled = state.statusPage >= pages - 1;
  const sync = snapshot.tasks.find(task => task.id === 'repo-sync');
  const online = snapshot.devices.filter(device => device.status === 'online').length;
  const next = snapshot.tasks.filter(task => task.enabled && task.nextRunAt).sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))[0];
  $('status-summary').textContent = [
    `Main Hub ${snapshot.main.status === 'online' ? "Online" : "Offline"}${snapshot.main.maintenance === 'maintenance' ? " (maintenance)" : ''} · Uptime ${snapshot.main.uptimeMs >= 0 ? new Intl.NumberFormat('en').format(Math.floor(snapshot.main.uptimeMs / 3_600_000)) : '0'} hours`,
    `Sub Hubs online ${online}/${snapshot.devices.length}`,
    sync ? `Last sync: ${sync.summary || sync.status}` : '',
    next ? `Next task: ${next.label} ${date(next.nextRunAt)}` : '',
  ].filter(Boolean).join(' · ');
  const entry = snapshot.publicEntry, entryBox = $('status-entry');
  if (!entry?.url) { entryBox.hidden = true; entryBox.replaceChildren(); }
  else {
    entryBox.hidden = false; entryBox.replaceChildren();
    entryBox.append(el('span', 'status-entry-label', "Current public entry: "));
    const link = el('a', 'status-entry-link', entry.url);
    link.href = entry.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    const checkNote = entry.lastCheck?.checkedAt ? ` · Entry self-check ${entry.lastCheck.state || "Unknown"} (${date(entry.lastCheck.checkedAt)})` : '';
    entryBox.append(link, el('span', 'status-entry-hint', (entry.claimed
      ? (entry.accepted ? ' (May change daily; use the address shown here)' : ' (Domain changed; awaiting automatic allowlist update)')
      : ' (Not claimed yet; external access is unavailable)') + checkNote));
  }
  if (!document.hidden && state.view === 'status') state.statusPolling = setTimeout(() => loadStatus().catch(error => toast(error.message)), 15000);
}
$('status-refresh').onclick = () => void loadStatus().catch(error => toast(error.message));

const renderRecovery=createRecoveryPanel({container:$('main-recovery'),request:key=>api('/api/main/retry-report',{key}),refresh:()=>loadMainManagement(),notify:message=>toast(message)});
const conflictReview=createConflictReviewPanel({container:$('main-conflict-review'),request:(path,body)=>api(path,body),notify:message=>toast(message)});
async function loadMainManagement() {
  let main;
  try { main = await api('/api/main/status'); } catch (error) { if (error.status === 404) return; throw error; }
  $('main-management').hidden = false;
  renderRecovery(main);
  if(main.capabilities?.conflictReview===1)await conflictReview.load();
  void updatePanel.refresh();
  $('main-mode').textContent = main.testMode ? 'Test mode: local saves and pulls are allowed; remote pushes are blocked.' : 'The main Hub coordinates workday closing and report generation.';
  const { nodes, operations } = await api('/api/nodes'); $('hub-nodes').replaceChildren();
  for (const node of nodes) {
    const row = el('article', 'note-card');
    row.append(el('h3', '', `${node.id} · ${node.status === 'online' ? "Online" : "Removed"}`));
    row.append(el('p', 'muted', node.taskBusy ? 'An instance task is active; synchronization is deferred.' : `Last sync: ${node.sync?.code || "No result yet"}`));
    if (node.protocolCompatible === false) row.append(el('p', 'muted', 'Protocol incompatible; task distribution to this device is paused.'));
    for (const [kind, label] of [['sync', "Sync now"], ['clear', 'Clear this sub Hub']]) {
      const button = el('button', 'text-button', label);
      button.onclick = async () => { try { await api(`/api/nodes/${encodeURIComponent(node.id)}/${kind}`, { id: crypto.randomUUID() }); toast('Request recorded; waiting for device execution and acknowledgment'); await loadMainManagement(); } catch (e) { toast(e.message); } };
      row.append(button);
    }
    const pending = operations.filter(o => o.nodeId === node.id && o.status === 'queued');
    if (pending.length) row.append(el('p', 'muted', `Pending: ${pending.length} items`));
    $('hub-nodes').append(row);
  }
  if (!nodes.length) $('hub-nodes').append(el('p', 'muted', 'No sub Hubs registered.'));
  const days = Object.entries(main.reports.days).sort(([a], [b]) => b.localeCompare(a)).slice(0, 7);
  $('main-report-state').textContent = days.map(([day, s]) => `${day}: ${s.closedAt ? "Daily report ready" : s.closing ? "Collecting" : "Workday started"}`).join('；');
  $('main-report-links').replaceChildren();
  for (const [day, s] of days.filter(([, s]) => s.closedAt)) {
    const button = el('button', 'text-button', `${day} Daily report and conflicts`);
    button.onclick = async () => { try { const report = await api(`/api/main/reports/daily/${day}`); $('main-report-detail').replaceChildren(renderMarkdown(report.markdown)); } catch (e) { toast(e.message); } };
    $('main-report-links').append(button);
  }
}
$('refresh-nodes').onclick = () => void loadMainManagement().catch(e => toast(e.message));
for (const [id, action] of [['main-start', 'start'], ['main-close', 'close']]) $(id).onclick = async () => {
  try { const result = await api(`/api/main/${action}`, {}); toast(result.summary); await loadMainManagement(); } catch (e) { toast(e.message); }
};
async function showConnection() {
  $('connection-dialog').showModal(); $('pairing-details').hidden = true;
  if (state.status?.local) {
    try {
      state.pairing = await api('/api/pairing');
      $('remote-url').textContent = state.pairing.remoteUrl || 'Phone access URL is not configured';
      $('pairing-value').textContent = state.pairing.code;
      $('phone-help').textContent = state.pairing.connectionMode === 'public'
        ? 'Open the HTTPS URL below on your phone and enter the pairing code. Share this code only with your own devices.'
        : 'Sign in to the same Tailscale account on your phone and Hub device, then open the URL below and enter the pairing code.';
      $('pairing-details').hidden = false;
    } catch (error) { $('phone-help').textContent = error.message; }
  } else $('phone-help').textContent = (state.status?.connectionMode === 'public' ? 'This device is connected. Continue using the current HTTPS URL.' : 'This device is connected. Keep Tailscale online to maintain access.') + 'The pairing code is shown only on the local Hub page, accessible through SSH local forwarding.';
}
function reportClientError(where, error) {
  try {
    const payload = JSON.stringify({ where, message: String(error && (error.stack || error.message) || error || '').slice(0, 600), stack: String(error && error.stack || '').slice(0, 400) });
    if (navigator.sendBeacon) navigator.sendBeacon('/api/client-error', new Blob([payload], { type: 'application/json' }));
    else fetch('/api/client-error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }).catch(() => {});
  } catch {  }
}
window.addEventListener('error', event => reportClientError('window.error', event.error || event.message));
window.addEventListener('unhandledrejection', event => reportClientError('unhandledrejection', event.reason));
async function boot() {
  try {
    if (['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) await api('/api/local-login', {});
    for (let attempt = 1; ; attempt++) {
      try { state.status = await api('/api/status'); break; }
      catch (error) {
        if (attempt >= 3 || error.status) throw error;
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
    }
    void loadWebSettings().catch(() => {});
    state.projectsSupported=false;$('chat-project-row').hidden=true;
    try{const data=await api('/api/projects');if(data.supported){state.projectsSupported=true;$('chat-project').replaceChildren(new Option("Global context",''),...data.projects.map(p=>new Option(p.id,p.id)));$('chat-project-row').hidden=false;}}catch{}
    for(const button of document.querySelectorAll('.attachment-controls button'))button.disabled=state.status.attachments?.available!==true;
    updateVisionConsent();
    $('app').hidden = false; $('login').hidden = true;
    $('instance-name').textContent = state.status.instance;
    $('engine-warning').hidden = state.status.engineAvailable;
    $('engine-warning').textContent = `Not found locally: ${state.status.engine}. Text chat is unavailable; notes, image storage, and configured image analysis remain available.`;
    $('context-consent-label').textContent = `Allow this conversation to use ${state.status.engine} to process input, necessary profile information, relevant memories, work logs, and recent messages. Privacy rules still apply.`;
    $('connection-status').textContent = "Connected";
    $('today').textContent = new Intl.DateTimeFormat('en', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
    for (const [name, task] of [['refreshChats', refreshChats], ['loadTasks', loadTasks], ['loadPushes', loadPushes]]) {
      try { await task(); } catch (error) { reportClientError(name, error); }
    }
    const previous = sessionStorage.getItem('aipa-chat');
    if (previous && state.chats.some(chat => chat.id === previous)) await loadChat(previous);
    else renderChat();
  } catch (error) {
    reportClientError('boot', error); if (error.status === 503) { $('connection-status').textContent = "Updating records"; setTimeout(() => void boot(), 2000); return; }
    showLogin();
    if (error.status !== 401) $('login-error').textContent = error.status ? ("Hub temporarily unavailable (" + error.status + "). Retry later.") : 'Connection interrupted. Check your network and retry.';
  }
}
$('login-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; $('login-error').textContent = '';
  try { await api('/api/login', { code: $('pair-code').value.trim() }); $('pair-code').value = ''; await boot(); }
  catch (error) { $('login-error').textContent = error.message; } finally { button.disabled = false; }
};
function currentWebOptions() {
  if (!$('allow-web').checked) return { allowWeb: false };
  const searchQuery = $('web-query').value.trim();
  if ([...searchQuery].length > 128) throw new Error('Manual queries may contain up to 128 characters. Leave blank to generate one automatically.');
  if (!state.webSearch?.settings.revision) throw new Error('Wait for search settings to load before sending');
  return { allowWeb: true, searchQuery, webProfileVersion: state.webSearch.settings.revision };
}
$('allow-web').onchange = () => { $('web-query-label').hidden = !$('allow-web').checked; };
$('chat-form').onsubmit = async event => {
  event.preventDefault(); const text = $('message-input').value.trim(); if ((!text && !chatImages.hasImages()) || busy()) return;
  if (!chatImages.hasImages() && state.status.consentRequired && !$('context-consent').checked) { toast('Confirm consent to use conversation context first. Use Notes to save without model processing.'); return; }
  $('send-message').disabled = true;
  try {
    const ids=chatImages.ids();
    const analyze=ids.length>0&&selectedImageMode()!=='save',imageWeb=analyze&&selectedImageMode()==='web';
    if(imageWeb&&!state.webSearch?.ready)throw Error('Wait for search settings to load and confirm the service is ready');
    const options = { attachmentIds:ids, analyzeImages:analyze, visionConsent:analyze,imageWebConsent:imageWeb, visionProfileVersion:analyze?state.status.attachments?.visionProfile?.version:undefined, consent:ids.length?false:$('context-consent').checked, engine: state.status.engineId, modelProfileVersion:state.status.modelProfileVersion, ...(ids.length?{allowWeb:imageWeb,...(imageWeb?{searchQuery:'',webProfileVersion:state.webSearch.settings.revision}:{})}:currentWebOptions()) };
    if (!state.chat) state.chat = await api('/api/chats', state.projectsSupported?{project:$('chat-project').value}:{});
    if(state.projectsSupported)options.project=state.chat.project||'';
    sessionStorage.setItem('aipa-chat', state.chat.id);
    let pending;
    try { pending = JSON.parse(sessionStorage.getItem('aipa-pending')); } catch {  }
    if (!pending || pending.text !== text || pending.chat !== state.chat.id || JSON.stringify(pending.options) !== JSON.stringify(options)) pending = { id: chatImages.scope(), text, chat: state.chat.id, options };
    sessionStorage.setItem('aipa-pending', JSON.stringify(pending));
    await api(`/api/chats/${state.chat.id}/turns`, { id: pending.id, text, ...pending.options });
    sessionStorage.removeItem('aipa-pending'); chatImages.clear(); resetImageMode(); $('message-input').value = ''; sessionStorage.removeItem('aipa-draft');
    await refreshCurrent();
  } catch (error) { toast(error.message || 'Connection interrupted. Retry; your text remains in the input box.'); }
  finally { $('send-message').disabled = Boolean(busy()); }
};
$('message-input').value = sessionStorage.getItem('aipa-draft') || '';
$('message-input').oninput = () => sessionStorage.setItem('aipa-draft', $('message-input').value);
$('note-input').value=sessionStorage.getItem('aipa-note-draft')||'';
$('note-input').oninput=()=>sessionStorage.setItem('aipa-note-draft',$('note-input').value);
$('note-form').onsubmit = async event => {
  event.preventDefault(); const text = $('note-input').value.trim(); if (!text && !noteImages.hasImages()) return;
  $('save-note').disabled = true;
  try {
    let pending;
    try { pending = JSON.parse(sessionStorage.getItem('aipa-pending-note')); } catch {  }
    const ids=noteImages.ids();
    if (!pending || pending.text !== text || JSON.stringify(pending.attachmentIds)!==JSON.stringify(ids)) pending = { id: noteImages.scope(), text, attachmentIds:ids };
    sessionStorage.setItem('aipa-pending-note', JSON.stringify(pending));
    const note = await api('/api/notes', pending);
    noteImages.clear(); $('note-input').value = ''; sessionStorage.removeItem('aipa-note-draft'); sessionStorage.removeItem('aipa-pending-note');
    toast(note.warning || 'Idea saved to your AIPA instance'); await loadNotes();
  } catch (error) { toast(error.message); } finally { $('save-note').disabled = false; }
};
$('search-form').onsubmit = async event => {
  event.preventDefault(); const query = $('search-input').value.trim(); if (!query) return;
  const button = event.submitter; button.disabled = true; $('search-summary').textContent = 'Finding relevant information...';
  try {
    const { hits } = await api(`/api/search?q=${encodeURIComponent(query)}`); $('search-results').replaceChildren();
    $('search-summary').textContent = hits.length ? `Found ${hits.length} relevant excerpts` : 'No matching memories yet. Try a more specific keyword.';
    for (const hit of hits) {
      const card = el('article', 'memory-card');
      const kind = { note: "Notes", daily: "Daily report", events: "Session events", month: "Monthly report", year: "Yearly report" }[hit.kind] || "AIPA memory";
      card.append(el('span', 'kind-label', kind), el('h2', '', hit.title));
      if (['daily', 'events', 'month', 'year'].includes(hit.kind)) {
        const details = el('details', 'log-details');
        details.append(el('summary', '', "View record"), renderMarkdown(hit.body)); card.append(details);
      } else card.append(renderMarkdown(hit.body));
      card.append(el('div', 'card-meta', hit.location));
      $('search-results').append(card);
    }
  } catch (error) { $('search-summary').textContent = error.message; } finally { button.disabled = false; }
};
document.querySelectorAll('[data-prompt]').forEach(button => button.onclick = () => { $('message-input').value = button.dataset.prompt; $('message-input').focus(); });
document.querySelector('[data-action="memory"]').onclick = () => showView('memory');
$('new-chat').onclick = $('mobile-new-chat').onclick = () => newChat().catch(error => toast(error.message));
$('mobile-history').onclick = $('manage-history').onclick = $('drawer-history').onclick = () => void showHistory();
$('history-visible').onclick = () => void showHistory('visible');
$('history-hidden').onclick = () => void showHistory('hidden');
$('connect-phone').onclick = () => void showConnection();
$('copy-pairing').onclick = () => navigator.clipboard.writeText(state.pairing.code).then(() => toast("Pairing code copied")).catch(() => toast('Press and hold the pairing code to copy it'));
$('logout').onclick = async () => { await api('/api/logout', {}); $('connection-dialog').close(); showLogin(); };
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.status && !$('app').hidden) { $('connection-status').textContent = "Connected"; void refreshCurrent().catch(() => toast('Reconnecting to the Hub device')); void loadTasks().catch(() => {}); void loadPushes().catch(() => {}); if (state.view === 'status') void loadStatus().catch(() => {}); } else { clearTimeout(state.polling); clearTimeout(state.taskPolling); clearTimeout(state.pushPolling); clearTimeout(state.statusPolling); } });
window.addEventListener('online', () => void refreshCurrent().catch(() => {}));

function renderDailyBriefing(briefing, target) {
  const hero = el('header', 'briefing-hero');
  hero.append(el('p', 'eyebrow', 'YOUR DAILY BRIEFING'), el('h2', '', `${briefing.day} · Daily news`), el('p', '', briefing.intro), el('small', '', `Prepared at ${date(briefing.generatedAt)}`));
  target.append(hero);
  for (const warning of briefing.warnings || []) target.append(el('p', 'notice', warning));
  for (const section of briefing.sections) {
    const group = el('section', 'briefing-section');
    const heading = el('div', 'briefing-section-heading'); heading.append(el('h3', '', section.label), el('span', 'muted', `${section.items.length} records`)); group.append(heading);
    if (!section.items.length) group.append(el('p', 'empty-state', 'No new information was available in this run.'));
    for (const item of section.items) {
      const card = el('article', 'news-card');
      const like = el('button', 'news-like', '♡');
      like.type = 'button'; like.title = 'Like this type of news'; like.setAttribute('aria-pressed', 'false'); like.setAttribute('aria-label', 'Like this type of news');
      like.onclick = () => void toggleNewsLike(item, like);
      card.append(like);
      const meta = el('div', 'news-meta'); meta.append(el('span', '', item.sourceName), el('time', '', date(item.publishedAt)));
      card.append(meta, el('h4', '', item.title), el('p', 'news-summary', item.summary));
      try {
        const url = new URL(item.url);
        if (url.protocol === 'https:' && !url.username && !url.password) {
          const link = el('a', 'news-link', 'Read original ↗'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(link);
        }
      } catch {  }
      group.append(card);
    }
    target.append(group);
  }
  target.append(el('p', 'briefing-basis', briefing.basis));
}
const pushRenderers = {
  'daily-briefing': async (push, target) => {
    if(!push.payload.digest)return renderDailyBriefing(await api(`/api/briefings/${encodeURIComponent(push.payload.day)}`),target);
    const report=await api(`/api/digests/${encodeURIComponent(push.payload.day)}`);
    const today=new Intl.DateTimeFormat('sv-SE',{timeZone:activeTimeZone(),year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    if(report.agenda)agendaUI.mountPreview(target,report.agenda,{live:report.day===today});
    if(report.news)renderDailyBriefing(report.news,target);
    else target.append(el('p','muted',report.newsStatus==='disabled'?'Daily news is paused.':report.newsStatus==='pending'?'News is being prepared. Agenda items are available now.':'News is temporarily unavailable. Agenda items remain available.'));
  },
};
async function openPush(item) {
  const push = await api(`/api/pushes/${encodeURIComponent(item.id)}`);
  const content = el('article', 'push-content');
  const renderer = pushRenderers[push.type];
  if (renderer) await renderer(push, content);
  else content.append(el('h2', '', push.title), el('p', 'news-summary', push.summary));
  $('push-detail').replaceChildren(content);
  state.pushId = item.id; state.pushVersion = item.updatedAt;
  await api(`/api/pushes/${encodeURIComponent(item.id)}/read`, {});
}
function renderBriefingSettings(data) {
  $('briefing-zone').textContent=data.settings.timeZone;
  state.timeZone=data.settings.timeZone;
  const { settings } = data;
  $('briefing-enabled').checked = settings.enabled; $('briefing-time').value = settings.dailyAt; $('briefing-interests').value = settings.interests;
  $('briefing-max-items').value = String(settings.maxItems || 60);
  state.briefingCustom = { categories: settings.customCategories || [], sources: settings.customSources || [] };
  renderCustomChips();
  for (const [target, list, selected, name] of [[$('briefing-categories'), data.categories, settings.categories, 'category'], [$('briefing-sources'), data.sources, settings.sourceIds, 'source']]) {
    target.replaceChildren();
    for (const item of list) {
      const label = el('label', 'check-line');
      const input = el('input'); input.type = 'checkbox'; input.name = name; input.value = item.id; input.checked = selected.includes(item.id);
      label.append(input, document.createTextNode(item.label || item.name)); target.append(label);
    }
  }
  state.settingsLoaded = true;
}
function renderCustomChips() {
  const { categories, sources } = state.briefingCustom;
  const boxC = $('briefing-custom-categories');
  boxC.replaceChildren();
  categories.forEach((item, index) => {
    const chip = el('span', 'chip', `${item.label} (${item.keywords.join(', ') || 'No keywords'})`);
    const remove = el('button', 'chip-remove', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove category ${item.label}`);
    remove.onclick = () => { categories.splice(index, 1); renderCustomChips(); };
    chip.append(remove); boxC.append(chip);
  });
  const boxS = $('briefing-custom-sources');
  boxS.replaceChildren();
  sources.forEach((item, index) => {
    const chip = el('span', 'chip', item.name);
    chip.title = item.url;
    const remove = el('button', 'chip-remove', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove source ${item.name}`);
    remove.onclick = () => { sources.splice(index, 1); renderCustomChips(); };
    chip.append(remove); boxS.append(chip);
  });
}
$('briefing-cc-add').onclick = () => {
  const label = $('briefing-cc-label').value.trim().slice(0, 20), keywords = $('briefing-cc-keywords').value.split(/[,，、\s]+/).map(word => word.trim()).filter(Boolean).slice(0, 8);
  if (!label) return toast('Enter a category name first');
  if (state.briefingCustom.categories.length >= 10) return toast('Up to 10 custom categories');
  state.briefingCustom.categories.push({ label, keywords });
  $('briefing-cc-label').value = ''; $('briefing-cc-keywords').value = ''; renderCustomChips();
};
$('briefing-cs-add').onclick = () => {
  const name = $('briefing-cs-name').value.trim().slice(0, 30), url = $('briefing-cs-url').value.trim();
  if (!name || !url) return toast('Enter both a source name and URL');
  if (!/^https:\/\//i.test(url)) return toast('Only HTTPS URLs are accepted');
  if (state.briefingCustom.sources.length >= 10) return toast('Up to 10 custom sources');
  state.briefingCustom.sources.push({ name, url });
  $('briefing-cs-name').value = ''; $('briefing-cs-url').value = ''; renderCustomChips();
};
async function toggleNewsLike(item, button) {
  const on = button.getAttribute('aria-pressed') === 'true';
  button.setAttribute('aria-pressed', String(!on)); button.textContent = on ? '♡' : '♥';
  try {
    await api('/api/briefing/like', { tags: item.tags || [item.category, item.sourceId].filter(Boolean), action: on ? 'unlike' : 'like' });
    toast(on ? 'Like removed' : 'Preference saved. Similar content will be ranked higher next time.');
  } catch (error) {
    button.setAttribute('aria-pressed', String(on)); button.textContent = on ? '♥' : '♡'; toast(error.message);
  }
}
async function loadWebSettings() {
  try { renderWebSettings(await api('/api/web-search/settings')); } catch {  }
}
function renderWebSettings(data) {
  state.webSearch = data;
  const select = $('web-provider');
  select.replaceChildren();
  for (const provider of data.providers) {
    const option = el('option', '', provider.label); option.value = provider.id; option.selected = provider.id === data.settings.provider; select.append(option);
  }
  $('web-key').value = '';
  $('web-key').placeholder = data.settings.independentApiKeySet ? 'Separate API key saved; leave blank to keep it' : data.settings.provider==='deepseek' ? 'Leave blank to reuse existing official DeepSeek model credentials' : 'Required for Bocha / Tavily';
  $('web-credential-status').textContent = ({model:'Reusing the current official DeepSeek model credentials. No separate key is needed.',independent:"Using a separately stored search API key.",'not-needed':"This provider does not require an API key.",missing:"No reusable official model credentials found. Enter an API key for this provider."})[data.settings.credentialSource] || '';
  $('web-endpoint').value = data.settings.endpoint || '';
  $('web-max').value = String(data.settings.maxResults);
  $('web-daily-cap').value = String(data.settings.dailyCap);
  $('web-fetch-daily-cap').value=String(data.settings.fetchDailyCap||40);
  $('web-clear-key').disabled=!data.settings.independentApiKeySet;
  const provider = data.providers.find(p => p.id === data.settings.provider);
  $('allow-web-label').textContent = `Allow this turn to use ${provider?.label || data.settings.provider} to search public material based on the question and cite sources`;
  $('web-search-status').textContent = `${data.ready ? "Configuration ready; actual connectivity depends on request results" : "Configuration incomplete"} · Today: ${data.usedToday}/${data.settings.dailyCap} search attempts (including failures); page reads ${data.fetchedToday || 0}/${data.settings.fetchDailyCap || 40} requests`;
  if(data.connectionCheck) $('web-search-status').textContent+=` · Last successful check: ${date(data.connectionCheck.checkedAt)}`;
  updateVisionConsent();
}
$('web-search-settings-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    const value = { provider: $('web-provider').value, maxResults: Number($('web-max').value) || 6, dailyCap: Number($('web-daily-cap').value) || 80, fetchDailyCap:Number($('web-fetch-daily-cap').value)||40, endpoint: $('web-endpoint').value.trim() };
    const key = $('web-key').value.trim(); if (key) value.apiKey = key;
    renderWebSettings(await api('/api/web-search/settings', value)); toast("Web search settings saved");
  } catch (error) { toast(error.message); } finally { button.disabled = false; }
};
$('web-provider').onchange=()=>{$('web-key').value='';};
$('web-check').onclick=async()=>{
  const button=$('web-check');button.disabled=true;
  try{
    if($('web-provider').value!==state.webSearch?.settings.provider)throw new Error("Save the selected search provider first");
    const result=await api('/api/web-search/check',{live:true,consent:true,webProfileVersion:state.webSearch.settings.revision});
    renderWebSettings(result.metadata);toast(`Web check passed; public sample returned ${result.resultCount} results`);
  }catch(error){toast(error.message);}finally{button.disabled=false;}
};
$('web-clear-key').onclick=async()=>{
  const button=$('web-clear-key');button.disabled=true;
  try{
    if($('web-provider').value!==state.webSearch?.settings.provider)throw new Error("Save the selected search provider first");
    const provider=state.webSearch.settings.provider;
    renderWebSettings(await api('/api/web-search/settings',{provider,clearApiKey:true}));toast(provider==='deepseek'?"Separate API key cleared; reusable official model credentials will be used if available":"Separate API key cleared for this provider");
  }catch(error){toast(error.message);}finally{button.disabled=!state.webSearch?.settings.independentApiKeySet;}
};
async function loadPushes() {
  clearTimeout(state.pushPolling);
  if (state.pushLoading) return;
  state.pushLoading = true;
  let delay = 60_000;
  try {
    const data = await api('/api/pushes');
    const paintUnread = count => {
      navigation.setUnread(count);
      $('push-notice').hidden = !count || state.view === 'pushes'; $('push-notice').textContent = `✧ ${count} unread notifications. View →`;
    };
    paintUnread(data.unread);
    const task = data.tasks.find(t => t.id === 'daily-briefing');
    if (task?.status === 'running') delay = 5000;
    if (state.view === 'pushes') {
      if (!state.settingsLoaded) {
        renderBriefingSettings(await api('/api/briefing-settings'));
        const agendaSettings=await api('/api/agenda-settings');$('agenda-enabled').checked=agendaSettings.settings.enabled;$('agenda-time').value=agendaSettings.settings.dailyAt;$('agenda-zone').textContent=agendaSettings.settings.timeZone;
      }
      const producerBox = $('push-producers'); producerBox.replaceChildren();
      for (const producer of data.producers) {
        const card = el('article', 'producer-card');
        card.append(el('span', 'kind-label', "Available notification types"), el('h2', '', producer.label), el('p', 'muted', producer.description));
        if (producer.id === 'daily-briefing') {
          card.append(el('p', 'producer-schedule', task?.enabled ? `Daily at ${task.dailyAt} · ${task.timeZone}${task.nextRunAt ? ` Next: ${date(task.nextRunAt)}` : ''}` : "Automatic notifications paused"));
          if (task?.result?.summary) card.append(el('p', 'muted', task.result.summary));
          const button = el('button', 'primary', task?.status === 'running' ? "Preparing news..." : "Generate today's news");
          button.disabled = !task?.enabled || task?.status === 'running';
          button.onclick = async () => {
            button.disabled = true;
            try { await api('/api/pushes/daily-briefing/run', {}); toast("Preparation started. Results will appear in the inbox."); await loadPushes(); }
            catch (error) { toast(error.message); button.disabled = false; }
          };
          card.append(button);
        }
        producerBox.append(card);
      }
      const inbox = $('push-inbox'); inbox.replaceChildren(); $('push-count').textContent = `${data.pushes.length} records`;
      if (!data.pushes.length) inbox.append(el('p', 'empty-state', "Your first notification is on its way. Generate today's news now or wait for the next scheduled task."));
      const selected = data.pushes.find(p => p.id === state.pushId) || data.pushes[0];
      if (selected && (selected.id !== state.pushId || selected.updatedAt !== state.pushVersion)) {
        await openPush(selected);
        if (selected.unread) { selected.unread = false; data.unread = Math.max(0, data.unread - 1); paintUnread(data.unread); }
      }
      for (const item of data.pushes) {
        const button = el('button', `inbox-item${item.id === state.pushId ? ' selected' : ''}`);
        button.append(el('span', '', `${item.unread ? '● ' : ''}${item.title}`), el('small', '', date(item.createdAt)));
        button.onclick = async () => { try { await openPush(item); await loadPushes(); } catch (error) { toast(error.message); } };
        inbox.append(button);
      }
    }
  } finally {
    state.pushLoading = false;
    if (!document.hidden && !$('app').hidden) state.pushPolling = setTimeout(() => loadPushes().catch(() => {}), delay);
  }
}
$('push-notice').onclick = () => showView('pushes');
$('briefing-settings-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    const value = { enabled: $('briefing-enabled').checked, dailyAt: $('briefing-time').value, interests: $('briefing-interests').value,
      categories: [...document.querySelectorAll('#briefing-categories input:checked')].map(i => i.value), sourceIds: [...document.querySelectorAll('#briefing-sources input:checked')].map(i => i.value),
      customCategories: state.briefingCustom.categories, customSources: state.briefingCustom.sources.map(({ name, url }) => ({ name, url })),
      maxItems: Number($('briefing-max-items').value) || 60, exploreRatio: 0.3 };
    renderBriefingSettings(await api('/api/briefing-settings', value)); toast("Daily news settings saved");
    await loadPushes(); await loadTasks();
  } catch (error) { toast(error.message); } finally { button.disabled = false; }
};

  void boot();
