import {attachmentIds} from './attachments.mjs';
export function projectId(value=''){
 if(typeof value!=='string'||value.length>128||(value&&(!/^[\p{L}\p{N}_.-]+$/u.test(value)||['.','..'].includes(value))))throw Object.assign(Error("Invalid project ID"),{status:400});
 return value;
}
export function turnOptions(value = {}) {
  if (value.requestVersion !== undefined && value.requestVersion !== 1) throw Object.assign(new Error("Message protocol changed. Refresh the page."),{status:400});
  return {
    requestVersion: 1,
    project:value.project===undefined?undefined:projectId(value.project),
    attachmentIds: attachmentIds(value.attachmentIds),
    analyzeImages: value.analyzeImages === true,
    visionConsent: value.visionConsent === true,
    imageWebConsent: value.imageWebConsent === true,
    visionProfileVersion: typeof value.visionProfileVersion === 'string' ? value.visionProfileVersion : undefined,
    engine: value.engine,
    modelProfileVersion: typeof value.modelProfileVersion === 'string' ? value.modelProfileVersion : undefined,
    consent: value.consent === true,
    allowWeb: value.allowWeb === true,
    searchQuery: value.allowWeb === true && typeof value.searchQuery === 'string' ? value.searchQuery.trim() : '',
    webProfileVersion: value.allowWeb === true && typeof value.webProfileVersion === 'string' ? value.webProfileVersion : undefined,
  };
}

export function sameTurnRequest(turn, input, options) {
  const a = turnOptions(turn), b = turnOptions(options);
  return turn.input === input && JSON.stringify(a.attachmentIds) === JSON.stringify(b.attachmentIds) && a.analyzeImages === b.analyzeImages && a.visionConsent === b.visionConsent && a.imageWebConsent === b.imageWebConsent && a.visionProfileVersion === b.visionProfileVersion && a.engine === b.engine && a.consent === b.consent && (!a.modelProfileVersion || a.modelProfileVersion === b.modelProfileVersion) &&
    a.allowWeb === b.allowWeb && a.searchQuery === b.searchQuery && a.webProfileVersion === b.webProfileVersion && (a.project||'')===(b.project||'');
}
