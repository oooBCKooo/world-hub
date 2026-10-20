// Optional client for a local supervisor's published lifecycle capability.
// Business requests keep their original target, topic and opaque body.
const protocol = 'world-hub.lifecycle/v1';
const fault = (code, message) => Object.assign(new Error(message), { code });
function descriptor(config) {
  if (!config || config.protocol !== protocol || typeof config.principal !== 'string' || !config.principal || typeof config.topic !== 'string' || !config.topic)
    throw fault('LIFECYCLE_CONFIG_REQUIRED', 'Use the lifecycle descriptor from this managed instance runtime configuration. Restart an existing caller after enabling on-demand execution.');
  return config;
}
async function control(bridge, config, body, timeoutMs, onLifecycleError) {
  const result = await bridge.call({ principal: config.principal }, config.topic, body, { timeoutMs, receiptTimeoutMs: Math.min(timeoutMs, 8000) });
  // Lifecycle control has its own short-lived retention policy. The caller
  // voluntarily releases only its own confirmed control request, including a
  // rejected request whose response it has actually received.
  if (Number.isSafeInteger(result.request?.seq)) await bridge.release([result.request.seq], { timeoutMs: Math.min(timeoutMs, 8000) }).catch(issue => { try { onLifecycleError?.(issue); } catch { /* Diagnostic only. */ } });
  const response = result.response?.body;
  if (!response || response.ok !== true) throw fault(response?.error?.code ?? 'LIFECYCLE_RESPONSE_INVALID', response?.error?.message ?? 'The lifecycle supervisor did not confirm this operation.');
  return response;
}
function milliseconds(value, fallback, name) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 300000) throw fault('LIFECYCLE_OPTIONS_INVALID', `${name} must be an integer from 1 to 300000 ms.`);
  return result;
}
export async function acquireManagedLease(bridge, lifecycleConfig, programId, opts = {}) {
  const config = descriptor(lifecycleConfig), activationTimeoutMs = milliseconds(opts.activationTimeoutMs, 120000, 'activationTimeoutMs');
  const controlTimeoutMs = milliseconds(opts.controlTimeoutMs, 8000, 'controlTimeoutMs');
  if (typeof programId !== 'string' || !programId) throw fault('LIFECYCLE_TARGET_REQUIRED', 'Choose a managed target instance ID.');
  await bridge.registerChannels([{ name: config.topic, publish: true, subscribe: true }]);
  const granted = await control(bridge, config, { action: 'acquire', programId }, activationTimeoutMs, opts.onLifecycleError);
  if (granted.programId !== programId || typeof granted.leaseId !== 'string' || !granted.leaseId || typeof granted.target?.principal !== 'string'
      || !Number.isSafeInteger(granted.renewAfterMs) || granted.renewAfterMs < 1 || !Number.isSafeInteger(granted.leaseTtlMs) || granted.leaseTtlMs <= granted.renewAfterMs)
    throw fault('LIFECYCLE_RESPONSE_INVALID', 'The lifecycle supervisor returned an invalid lease.');
  let timer = null, renewing = null, finished = false, lastError = null;
  const notify = issue => { lastError = issue; try { opts.onLifecycleError?.(issue); } catch { /* Diagnostics never retry business work. */ } };
  const lease = {
    programId, leaseId: granted.leaseId, target: granted.target, leaseTtlMs: granted.leaseTtlMs, renewAfterMs: granted.renewAfterMs,
    get lastError() { return lastError; },
    async renew() {
      if (finished) throw fault('LIFECYCLE_LEASE_RELEASED', 'This lease is no longer renewing.');
      if (!renewing) renewing = control(bridge, config, { action: 'renew', leaseId: granted.leaseId }, controlTimeoutMs, notify).finally(() => { renewing = null; });
      return renewing;
    },
    stopRenewing() { clearInterval(timer); timer = null; },
    async release({ completed } = {}) {
      if (typeof completed !== 'boolean') throw fault('LIFECYCLE_COMPLETION_REQUIRED', 'Explicitly state whether the actual task completed. A timeout is not completion.');
      lease.stopRenewing(); finished = true;
      // A final explicit completion can resolve a previously uncertain release.
      return control(bridge, config, { action: 'release', leaseId: granted.leaseId, completed }, controlTimeoutMs, notify);
    }
  };
  timer = setInterval(() => { if (!finished) void lease.renew().catch(issue => { lease.stopRenewing(); notify(issue); }); }, granted.renewAfterMs); timer.unref?.();
  return lease;
}
export async function callManaged(bridge, lifecycleConfig, programId, topic, body, opts = {}) {
  const timeoutMs = milliseconds(opts.timeoutMs, 30000, 'timeoutMs');
  const receiptTimeoutMs = opts.receiptTimeoutMs === undefined ? undefined : milliseconds(opts.receiptTimeoutMs, 8000, 'receiptTimeoutMs');
  const lease = await acquireManagedLease(bridge, lifecycleConfig, programId, opts);
  let completed = false, businessError;
  try {
    // There is exactly one business call. Activation retries and lease renewal
    // never replay the application's request body.
    const result = await bridge.call(lease.target, topic, body, { timeoutMs, ...(receiptTimeoutMs === undefined ? {} : { receiptTimeoutMs }),
      ...Object.fromEntries(['id', 'correlation', 'replyTo', 'headers', 'attachments'].filter(key => opts[key] !== undefined).map(key => [key, opts[key]])) });
    completed = true; return result;
  } catch (issue) { businessError = issue; throw issue; }
  finally {
    await lease.release({ completed }).catch(issue => {
      // Preserve the actual business result. A failed release leaves the
      // supervisor conservatively holding this run for manual confirmation.
      if (businessError) businessError.lifecycleError = issue;
      try { opts.onLifecycleError?.(issue); } catch { /* Diagnostic only. */ }
    });
  }
}
export async function withManagedModule(bridge, lifecycleConfig, programId, work, opts = {}) {
  if (typeof work !== 'function') throw fault('LIFECYCLE_WORK_REQUIRED', 'Provide a task whose resolved result explicitly represents completion.');
  const lease = await acquireManagedLease(bridge, lifecycleConfig, programId, opts);
  let completed = false, taskError;
  try { const value = await work({ target: lease.target, lease }); completed = true; return value; }
  catch (issue) { taskError = issue; throw issue; }
  finally { await lease.release({ completed }).catch(issue => { if (taskError) taskError.lifecycleError = issue; try { opts.onLifecycleError?.(issue); } catch { /* Diagnostic only. */ } }); }
}
