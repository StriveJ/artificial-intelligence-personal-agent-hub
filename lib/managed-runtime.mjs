export function bindManagedRuntime({ role, root, testMode, idle, close }) {
  if (!process.send) return () => {};
  const publish = () => {
    try { process.send?.({ type: 'hub-ready', role, releaseId: process.env.AIPA_HUB_RELEASE_ID, deploymentGeneration: Number(process.env.AIPA_HUB_DEPLOYMENT_GENERATION), root, testMode, protocol: 1, runtimeSchema: 1, idle: idle() }); }
    catch {  }
  };
  const timer = setInterval(publish, 1000); timer.unref(); publish(); let stopping;
  const message = value => {
    if (value?.type === 'hub-stop' && !stopping) stopping = Promise.resolve().then(close).then(() => { clearInterval(timer); process.exit(0); });
  };
  process.on('message', message);
  process.once('disconnect', () => message({ type: 'hub-stop' }));
  return () => { clearInterval(timer); process.removeListener('message', message); };
}
