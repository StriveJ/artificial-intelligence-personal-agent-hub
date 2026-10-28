import {join} from 'node:path';
import {localDay,timeZone as validateTimeZone} from './time-zone.mjs';
import {readJson,writeJson,safeInstancePath} from './storage.mjs';
import {validDate,revisionOf,agendaError} from './agenda.mjs';

export function createDailyDigest({root,runtimeDir,agenda,store,pushes,defaults={},now=Date.now,timeZone:sharedTimeZone}){
  const config=join(runtimeDir,'agenda-settings.json');
  let settings={enabled:false,dailyAt:'07:00',timeZone:'Asia/Shanghai',...readJson(config,defaults)};
  const currentZone=()=>sharedTimeZone?validateTimeZone(sharedTimeZone()):validateTimeZone(settings.timeZone);
  if(sharedTimeZone)settings.timeZone=currentZone();
  function configure(value){
    if(!value||typeof value.enabled!=='boolean'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.dailyAt)||sharedTimeZone&&value.timeZone!==undefined&&value.timeZone!==currentZone())throw agendaError("Check agenda display switch and time");
    settings={enabled:value.enabled,dailyAt:value.dailyAt,timeZone:validateTimeZone(value.timeZone??currentZone())};writeJson(config,settings);return {...settings};
  }
  configure(settings);
  const path=day=>{if(!validDate(day))throw agendaError("Invalid date");return safeInstancePath(root,join(root,'user-space','logs','hub','digests',day+'.json'));};
  function snapshot(day=localDay(now(),currentZone()),{newsStatus,newsError}={}){
    if(!settings.enabled)return null;
    const previous=readJson(path(day),null),news=store.readBriefing(day);
    const preview=day===localDay(now(),currentZone())?agenda.list({preview:true}):previous?.agenda;
    if(!preview)throw agendaError("No agenda snapshot for this date",404);
    const fingerprint=revisionOf({timeZone:currentZone(),items:preview.items,total:preview.total,invalid:preview.invalid,conflicts:preview.conflicts,news:news?.generatedAt||null,newsStatus:newsStatus||previous?.newsStatus||news?.status||'pending',newsError:newsError||null});
    if(previous?.revision===fingerprint)return previous;
    const value={version:1,day,timeZone:currentZone(),agenda:preview,newsStatus:newsStatus||previous?.newsStatus||news?.status||'pending',newsError:newsError||null,revision:fingerprint,createdAt:previous?.createdAt||new Date(now()).toISOString(),updatedAt:new Date(now()).toISOString()};
    writeJson(path(day),value);
    pushes.publish('daily-briefing',{id:`daily-briefing-${day}`,title:`${day} Daily briefing`,summary:`Agenda: ${preview.total} items; showing the next ${preview.items.length} items.${news?.intro||"See details for news status."}`,payload:{day,digest:true,revision:fingerprint}},{silent:Boolean(store.readPush(`daily-briefing-${day}`))});
    return value;
  }
  function report(day){
    const saved=readJson(path(day),null),news=store.readBriefing(day);
    if(!saved&&!news)throw agendaError("Briefing not found",404);
    return {day,timeZone:saved?.timeZone||news?.timeZone||currentZone(),news,newsStatus:saved?.newsStatus||news?.status||'pending',newsError:saved?.newsError||null,agenda:settings.enabled&&day===localDay(now(),currentZone())?agenda.list({preview:true}):saved?.agenda||null,generatedAt:saved?.createdAt||news?.generatedAt};
  }
  return {settings:()=>({...settings,timeZone:currentZone()}),configure,snapshot,report};
}
