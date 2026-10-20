// Launcher orchestration for local programs. Plans never define Hub topics or
// application behavior, and saving a plan is separate from execution consent.

export function createStartupPlanUi(ctx) {
  const { state, api, el, button, refresh } = ctx;
  const say = (zh, en) => state.language === 'zh' ? zh : en;
  const field = (title, control) => el('label', { class: control.type === 'checkbox' ? 'pack-lifecycle-choice' : '' }, control.type === 'checkbox' ? [control, el('span', {}, title)] : [el('span', {}, title), control]);
  function dialog(title, className = '') {
    const node = el('dialog', { class: `dialog startup-plan-dialog ${className}`, 'aria-label': title });
    const content = el('div', { class: 'stack' }), status = el('p', { role: 'status', class: 'field-help' });
    node.append(el('div', { class: 'dialog-heading' }, [el('h2', {}, title), button(say('关闭', 'Close'), () => node.close(), 'button button-quiet')]), content, status);
    node.addEventListener('close', () => node.remove(), { once: true }); document.body.append(node); node.showModal();
    return { node, content, status };
  }
  const resultLabel = value => ({
    queued: say('等待执行', 'Queued'), starting: say('启动中', 'Starting'), started: say('已启动', 'Started'),
    'already-running': say('原已运行，保持运行', 'Already running; retained'), running: say('运行中', 'Running'),
    skipped: say('未加入计划', 'Outside plan'), blocked: say('启动前置未就绪', 'Blocked by prerequisites'),
    failed: say('启动失败', 'Start failed'), cancelled: say('已取消', 'Cancelled'), 'not-started': say('尚未启动', 'Not started')
  })[value] ?? value;
  function progressContents(value) {
    const resultRows = value?.results ?? [], byId = new Map(resultRows.map(row => [row.programId, row]));
    const members = value?.plan?.members ?? resultRows.map(row => ({ programId: row.programId, enabled: true }));
    return members.map(member => {
      const row = byId.get(member.programId), status = row?.state ?? (member.enabled ? 'queued' : 'skipped');
      return el('div', { class: 'startup-plan-progress-row', 'data-program-id': member.programId, 'data-startup-state': status }, [
      el('strong', { class: 'mono' }, member.programId), el('span', { class: `pill${['failed', 'blocked', 'cancelled'].includes(status) ? ' pill-amber' : ''}` }, resultLabel(status)),
        row?.blockedBy?.length ? el('p', { class: 'field-help' }, `${say('等待', 'Waiting for')}: ${row.blockedBy.join(', ')}`) : null,
        row?.error?.message ? el('p', { class: 'field-help' }, row.error.message) : null
      ].filter(Boolean));
    });
  }
  async function reviewPlan() {
    const review = dialog(say('审阅启动计划', 'Review startup plan'), 'startup-plan-review');
    review.status.textContent = say('正在检查已保存计划及程序来源…', 'Checking the saved plan and program sources…');
    try {
      const response = await api('/api/programs/startup-plan/review', {});
      if (!review.node.open) return;
      const checked = response.review, plan = checked.plan;
      const consent = el('input', { type: 'checkbox', name: 'acceptStartupPlan' });
      const progress = el('div', { class: 'startup-plan-progress', 'aria-live': 'polite' });
      const cancel = button(say('取消本次启动计划', 'Cancel this startup plan'), async () => {
        if (!operationId || cancel.disabled) return;
        cancel.disabled = true;
        review.status.textContent = say('已请求取消，正在确认当前未完成启动的清理；已完成成员保持运行…', 'Cancellation requested; confirming cleanup of the current unfinished start. Completed members remain running…');
        try { await api(`/api/operations/${encodeURIComponent(operationId)}/cancel`, {}); }
        catch (error) { if (!finished) { review.status.textContent = error.message; cancel.disabled = false; } }
      }, 'button button-quiet', true);
      cancel.hidden = true;
      let operationId, finished = false;
      const start = button(say('确认并执行启动计划', 'Confirm and run startup plan'), async () => {
        if (!consent.checked || start.disabled) return;
        start.disabled = true; consent.disabled = true;
        try {
          const launched = await api('/api/programs/startup-plan/start', { reviewId: response.reviewId, accepted: true });
          operationId = launched.operationId; cancel.hidden = false; cancel.disabled = false;
          review.status.textContent = say('正在执行计划。关闭此窗口后，仍可在任务中心查看或取消。', 'Running the plan. You can still view or cancel it in the task center after closing this window.');
          while (review.node.open) {
            const { operation } = await api(`/api/operations/${encodeURIComponent(operationId)}`);
            if (!review.node.open) return;
            const observation = operation.result ?? operation.progress;
            if (observation) progress.replaceChildren(...progressContents(observation));
            if (['succeeded', 'partial', 'failed', 'cancelled'].includes(operation.state)) {
              finished = true;
              cancel.disabled = true;
              const problem = observation?.results?.some(row => ['failed', 'blocked', 'cancelled', 'not-started'].includes(row.state));
              review.status.textContent = operation.state === 'cancelled' || observation?.cancelled ? say('本次启动计划已取消，请核对各成员的清理结果。', 'This startup plan was cancelled. Check each member’s cleanup result.')
                : operation.state === 'failed' ? operation.error?.message ?? say('启动计划失败，请检查各成员结果。', 'The startup plan failed. Check the member results.')
                  : operation.state === 'partial' || problem ? say('启动计划部分完成，请检查失败或受阻成员。', 'The startup plan completed partially. Check failed or blocked members.')
                    : say('启动计划已完成。计划外模块保持原状态，可稍后单独启动。', 'The startup plan completed. Programs outside it retain their state and can be started individually later.');
              await refresh?.({ explicit: true }); return;
            }
            await new Promise(done => setTimeout(done, 500));
          }
        } catch (error) {
          if (!review.node.open) return;
          review.status.textContent = error.message;
          // Once dispatched, a failed observation cannot safely create a second
          // launch. The existing operation remains accessible in the task center.
          if (!operationId) { start.disabled = !consent.checked; consent.disabled = false; }
          else { cancel.disabled = false; review.status.append(el('p', {}, say('任务已提交；请在任务中心继续查看结果或取消，勿重复执行。', 'The task was submitted. Continue observing or cancel it in the task center; do not launch it again.'))); }
        }
      }, 'button button-primary', true);
      consent.addEventListener('change', () => { start.disabled = !consent.checked; });
      review.content.replaceChildren(
        el('p', {}, say('请检查本次启动范围、先后关系和程序来源。前置只检查已就绪的程序，不会自动启动计划外模块。本次执行不会停止原已运行的程序。', 'Review the selected programs, ordering and sources. Prerequisites check ready programs and never start members outside the plan. This execution will not stop programs that were already running.')),
        el('div', { class: 'panel' }, [
          el('strong', {}, say('执行顺序', 'Execution order')),
          el('div', { class: 'review-order', style: 'margin-top: 6px;' },
            (checked.order?.length ? checked.order : [say('无所选程序', 'No selected programs')]).flatMap((id, i) => [
              i ? el('span', { class: 'order-arrow', 'aria-hidden': 'true' }, '→') : null,
              el('span', { class: 'order-step-chip mono' }, id)
            ]).filter(Boolean)
          ),
          el('p', { class: 'field-help', style: 'margin-top: 8px;' }, `${say('失败处理', 'On failure')}: ${plan.onFailure === 'stop-plan' ? say('停止后续启动；已完成成员保持运行', 'Stop subsequent starts; completed members remain running') : say('继续执行互不依赖的成员', 'Continue independent members')}`)
        ]),
        ...checked.members.filter(member => member.enabled).map(member => {
          const execution = member.execution ?? {}, manifest = execution.manifest ?? {};
          return el('article', { class: 'panel startup-plan-member' }, [
            el('h3', {}, member.programId),
            el('p', { class: 'mono' }, `${manifest.id ?? execution.module?.id ?? ''} @${manifest.version ?? execution.module?.version ?? ''}`),
            el('p', { class: 'field-help' }, `${say('启动前置', 'Startup prerequisites')}: ${member.after?.join(', ') || say('无', 'None')}`)
          ]);
        }),
        el('details', {}, [el('summary', {}, say('完整来源、权限与执行审阅', 'Full sources, permissions and execution review')), el('pre', {}, JSON.stringify(checked, null, 2))]),
        field(say('我已检查本次启动计划，并允许启动上述本机程序。', 'I reviewed this startup plan and allow the selected local programs to run.'), consent),
        el('div', { class: 'result-actions' }, [start, cancel]), progress
      );
      review.status.textContent = '';
    } catch (error) { if (review.node.open) review.status.textContent = error.message; }
  }
  async function open() { return ctx.openGlobalEditor?.(); }
  async function openPack(instance) { return ctx.openPackEditor?.(instance); }
  return { open, openPack, reviewPlan, progressContents };
}
