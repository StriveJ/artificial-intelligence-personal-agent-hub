const $ = id => document.getElementById(id);
export function createUpdatePanel(notify) {
  let status, plan, busy = false;
  async function api(path, body, key = crypto.randomUUID()) {
    const response = await fetch('/api/admin/updates/' + path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json(); if (!response.ok) throw new Error(data.message || data.error || "Version maintenance incomplete"); return data;
  }
  async function refresh() {
    try {
      status = await api('status'); $('hub-update-status').textContent = `Current release: ${status.releaseId}${status.activeOperationId ? " · Maintenance operation active" : status.maintenance ? " · Writes paused" : " · Updates can be checked"}`;
      const releases = await api('releases'), select = $('hub-update-release'), old = select.value; select.replaceChildren();
      const ids = [...new Set([...releases.releases.map(r => r.releaseId), ...(status.previousReleaseId ? [status.previousReleaseId] : [])])];
      for (const id of ids.filter(id => id !== status.releaseId)) { const o = document.createElement('option'); o.value = id; o.textContent = id + (status.previousReleaseId === id ? " (previous accepted release)" : ''); select.append(o); }
      if (ids.includes(old)) select.value = old;
      $('hub-update-plan').disabled = busy || !select.value || Boolean(status.activeOperationId);
      $('hub-update-apply').disabled = busy || !plan || Boolean(status.activeOperationId);
      const history = await api('history?limit=5'); $('hub-update-history').replaceChildren();
      for (const op of history.items) { const p = document.createElement('p'); p.textContent = `${op.releaseAfter || "Release check"}: ${op.status} · ${op.phase}${op.message ? ' · ' + op.message : ''}`; $('hub-update-history').append(p); }
    } catch (error) { $('hub-update-status').textContent = error.message; $('hub-update-plan').disabled = true; $('hub-update-apply').disabled = true; }
  }
  async function perform(action) { if (busy) return; busy = true; try { await action(); } catch (e) { notify(e.message); } finally { busy = false; await refresh(); } }
  $('hub-update-check').onclick = () => perform(async () => { if (!status) throw new Error("Load maintenance status first"); await api('check', { target: status.target, channel: 'stable' }); notify('Checked the locally configured trusted release catalog'); });
  $('hub-update-plan').onclick = () => perform(async () => {
    if (!status?.releaseId) return;
    const releaseId = $('hub-update-release').value, action = $('hub-update-action').value;
    const body = { target: status.target, action, releaseId, expectedCurrentReleaseId: status.releaseId, expectedDeploymentGeneration: status.deploymentGeneration, when: 'idle', waitTimeoutSeconds: 1800 };
    const created = await api('plans', body); await api(`plans/${created.planId}/prepare`, {}); plan = await api(`plans/${created.planId}`);
    $('hub-update-plan-detail').textContent = `${action === 'rollback' ? "Rollback" : "Upgrade"} to ${releaseId}, verified and prepared. Waits for existing tasks to finish naturally; on failure, attempts to restore an accepted release. Personal records are preserved.`;
    $('hub-update-apply').textContent = `${action === 'rollback' ? "Apply rollback" : "Apply upgrade"}: ${releaseId}`;
  });
  $('hub-update-apply').onclick = () => perform(async () => {
    if (!plan) return; await api(`plans/${plan.planId}/apply`, { expectedPlanRevision: plan.planRevision }); plan = null;
    $('hub-update-plan-detail').textContent = 'Operation recorded durably. Connections may briefly drop during switching; refresh after reconnecting to view the result.'; notify('Submitted to the independent local updater');
  });
  return { refresh };
}
