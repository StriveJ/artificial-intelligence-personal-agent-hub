import { t, setText } from './i18n.js';
const $ = id => document.getElementById(id);
export function createUpdatePanel(notify) {
  let status, plan, busy = false;
  async function api(path, body, key = crypto.randomUUID()) {
    const response = await fetch('/api/admin/updates/' + path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json(); if (!response.ok) throw new Error(((data.message || data.error) || t("Version maintenance incomplete"))); return data;
  }
  async function refresh() {
    try {
      status = await api('status'); setText($('hub-update-status'), () => (t("Current release: {0}{1}", status.releaseId, (status.activeOperationId ? t(" · Maintenance operation active") : (status.maintenance ? t(" · Writes paused") : t(" · Updates can be checked"))))));
      const releases = await api('releases'), select = $('hub-update-release'), old = select.value; select.replaceChildren();
      const ids = [...new Set([...releases.releases.map(r => r.releaseId), ...(status.previousReleaseId ? [status.previousReleaseId] : [])])];
      for (const id of ids.filter(id => id !== status.releaseId)) { const o = document.createElement('option'); o.value = id; setText(o, () => (t('{0}{1}', id, (status.previousReleaseId === id ? t(" (previous accepted release)") : '')))); select.append(o); }
      if (ids.includes(old)) select.value = old;
      $('hub-update-plan').disabled = busy || !select.value || Boolean(status.activeOperationId);
      $('hub-update-apply').disabled = busy || !plan || Boolean(status.activeOperationId);
      const history = await api('history?limit=5'); $('hub-update-history').replaceChildren();
      for (const op of history.items) { const p = document.createElement('p'); setText(p, () => (t("{0}: {1} · {2}{3}", (op.releaseAfter || t("Release check")), op.status, op.phase, (op.message ? t('{0}{1}', ' · ', op.message) : '')))); $('hub-update-history').append(p); }
    } catch (error) { setText($('hub-update-status'), () => (error.message)); $('hub-update-plan').disabled = true; $('hub-update-apply').disabled = true; }
  }
  async function perform(action) { if (busy) return; busy = true; try { await action(); } catch (e) { notify(e.message); } finally { busy = false; await refresh(); } }
  $('hub-update-check').onclick = () => perform(async () => { if (!status) throw new Error(t("Load maintenance status first")); await api('check', { target: status.target, channel: 'stable' }); notify(t('Checked the locally configured trusted release catalog')); });
  $('hub-update-plan').onclick = () => perform(async () => {
    if (!status?.releaseId) return;
    const releaseId = $('hub-update-release').value, action = $('hub-update-action').value;
    const body = { target: status.target, action, releaseId, expectedCurrentReleaseId: status.releaseId, expectedDeploymentGeneration: status.deploymentGeneration, when: 'idle', waitTimeoutSeconds: 1800 };
    const created = await api('plans', body); await api(`plans/${created.planId}/prepare`, {}); plan = await api(`plans/${created.planId}`);
    setText($('hub-update-plan-detail'), () => (t("{0} to {1}, verified and prepared. Waits for existing tasks to finish naturally; on failure, attempts to restore an accepted release. Personal records are preserved.", (action === 'rollback' ? t("Rollback") : t("Upgrade")), releaseId)));
    setText($('hub-update-apply'), () => (t("{0}: {1}", (action === 'rollback' ? t("Apply rollback") : t("Apply upgrade")), releaseId)));
  });
  $('hub-update-apply').onclick = () => perform(async () => {
    if (!plan) return; await api(`plans/${plan.planId}/apply`, { expectedPlanRevision: plan.planRevision }); plan = null;
    setText($('hub-update-plan-detail'), () => (t('Operation recorded durably. Connections may briefly drop during switching; refresh after reconnecting to view the result.'))); notify(t('Submitted to the independent local updater'));
  });
  return { refresh };
}
