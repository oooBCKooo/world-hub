// Explicit optional execution profiles; a selected profile still needs package review.
export function createIsolationPanel(ctx) {
  const { state, api, el, button, say, panel, note, field, form, value, jsonView } = ctx;
  const policy = state.isolationSelection ?? {};
  const selector = el('select', { name: 'profile', 'aria-label': say('执行保护模式', 'Execution protection profile') }, [
    ['trusted-local', say('可信本机：不提供 OS 隔离', 'Trusted local: no OS isolation')],
    ['docker-runtime/v1', say('Docker：Node／Python，可选界面通道', 'Docker: Node/Python, optional UI tunnel')],
    ['docker-node-headless/v1', say('Docker：原 Node 无界面模式', 'Docker: original Node headless profile')],
    ['linux-existing-user/v1', say('Linux：已有独立用户（不是完整沙箱）', 'Linux: existing separate user (not a full sandbox)')]
  ].map(([key, title]) => el('option', { value: key }, title)));
  selector.value = policy.profile ?? (policy.image ? 'docker-node-headless/v1' : 'trusted-local');
  const docker = el('fieldset', { class: 'stack' }, [
    field('dockerPath', say('已安装 Docker 的绝对路径', 'Absolute path to installed Docker'), policy.dockerPath ?? ''),
    field('endpoint', say('本机 Linux daemon 地址', 'Local Linux daemon endpoint'), policy.endpoint ?? 'unix:///var/run/docker.sock'),
    field('nodeImage', say('预先取得的 Node 镜像摘要', 'Already available Node image digest'), policy.images?.node ?? policy.image ?? '', { required: false }),
    field('pythonImage', say('预先取得的 Python 镜像摘要', 'Already available Python image digest'), policy.images?.python ?? '', { required: false }),
    field('httpComponents', say('允许界面的入口组件 ID（可选）', 'Entry component ID allowed to expose UI (optional)'), policy.http?.components?.join(',') ?? '', { required: false }),
    field('memoryMiB', say('每组件内存 MiB', 'Memory MiB per component'), policy.limits?.memoryMiB ?? 256, { type: 'number' }),
    field('pids', say('每组件 PID 配额', 'PID limit per component'), policy.limits?.pids ?? 64, { type: 'number' }),
    field('cpus', say('每组件 CPU 配额', 'CPU limit per component'), policy.limits?.cpus ?? 1, { type: 'number' }),
    field('containerUser', say('容器非 root UID', 'Non-root container UID'), policy.limits?.user ?? 1000, { type: 'number' })
  ]);
  const user = el('fieldset', { class: 'stack' }, [
    note(say('此模式要求已经具有权限的 Linux 监督者、已有非 root 账号，以及预先配置的组件目录权限。工具不创建账号、不调用 sudo、不改变权限。用户分离不限制该账号原本能读的文件、网络或子进程。', 'This profile requires an already privileged Linux supervisor, an existing non-root account, and preconfigured component-directory permissions. It creates no accounts, invokes no sudo, and changes no permissions. User separation does not restrict files, network access, or child processes already allowed to that account.'), true),
    field('setprivPath', say('已安装 setpriv 的绝对路径', 'Absolute path to installed setpriv'), policy.setprivPath ?? '/usr/bin/setpriv'),
    field('uid', say('已有非 root UID', 'Existing non-root UID'), policy.user?.uid ?? '', { type: 'number' }),
    field('gid', say('已有主组 GID', 'Existing primary GID'), policy.user?.gid ?? '', { type: 'number' })
  ]);
  const result = el('div', { role: 'status', 'aria-live': 'polite' }), current = el('div', { class: 'isolation-current' }), pending = el('div', { class: 'isolation-pending' });
  const profileName = profile => [...selector.options].find(option => option.value === profile)?.textContent ?? profile;
  function summary() {
    const active = state.isolationSelection?.profile ?? 'trusted-local';
    current.replaceChildren(note(`${say('当前默认选择', 'Current default selection')}: ${profileName(active)}`));
    pending.replaceChildren(note(`${say('正在配置，尚未应用', 'Being configured, not yet applied')}: ${profileName(selector.value)}`));
  }
  function update() { const isUser = selector.value === 'linux-existing-user/v1', isDocker = selector.value.startsWith('docker-'); docker.hidden = !isDocker; docker.disabled = !isDocker; user.hidden = !isUser; user.disabled = !isUser; summary(); }
  selector.addEventListener('change', update); update();
  docker.querySelector('[name="cpus"]').step = 'any';
  const selection = form([el('label', {}, [el('span', {}, say('执行保护模式', 'Execution protection profile')), selector]), docker, user], say('探测并选择这个执行模式', 'Probe and select this execution profile'), async f => {
    const profile = value(f, 'profile');
    if (profile === 'trusted-local') { state.isolationSelection = null; state.reviews.clear(); state.trustReview = null; result.replaceChildren(note(say('已应用 trusted-local。启动仍须逐包审阅；不提供 OS 隔离。', 'Applied trusted-local. Execution still needs package review; it provides no OS isolation.'))); summary(); return; }
    const chosen = profile === 'linux-existing-user/v1'
      ? { profile, setprivPath: value(f, 'setprivPath'), user: { uid: Number(value(f, 'uid')), gid: Number(value(f, 'gid')) } }
      : { profile, dockerPath: value(f, 'dockerPath'), endpoint: value(f, 'endpoint'),
        ...(profile === 'docker-runtime/v1' ? { images: Object.fromEntries([['node', value(f, 'nodeImage')], ['python', value(f, 'pythonImage')]].filter(([, image]) => image)), http: { components: value(f, 'httpComponents').split(',').map(id => id.trim()).filter(Boolean) } } : { image: value(f, 'nodeImage') }),
        limits: { memoryMiB: Number(value(f, 'memoryMiB')), pids: Number(value(f, 'pids')), cpus: Number(value(f, 'cpus')), user: Number(value(f, 'containerUser')) } };
    const probeInput = profile === 'linux-existing-user/v1' ? chosen : { profile, dockerPath: chosen.dockerPath, endpoint: chosen.endpoint };
    const data = await api('/api/isolation/probe', probeInput);
    result.replaceChildren(jsonView(say('实际提供者探测', 'Actual provider probe'), data.probe, true));
    if (!data.probe.available) throw new Error(say('提供者不可用，执行选择没有改变。', 'Provider unavailable; execution selection was not changed.'));
    state.isolationSelection = chosen; state.reviews.clear(); state.trustReview = null; summary();
    result.append(note(profile === 'linux-existing-user/v1'
      ? say('已选择用户身份分离，sandbox:false。逐包审阅会再检查身份、解释器与目录权限，失败时拒绝启动。', 'User identity separation selected, sandbox:false. Package review rechecks identity, interpreters, and directory access; execution fails closed.')
      : say('已选择容器模式。逐包审阅将检查实际镜像版本、摘要、资源、只读挂载和界面通道；不会自动拉取镜像或回退到本机执行。', 'Container profile selected. Package review checks actual image versions and digests, resources, read-only mounts, and the UI tunnel. Images are never pulled automatically and there is no local-execution fallback.')));
  });
  update(); selection.addEventListener('input', summary); selection.addEventListener('change', update);
  return panel(say('选择执行保护等级', 'Select execution protection'), [
    note(say('默认 trusted-local。Docker 模式保留 network=none，仅转交实例 Hub 的桥通讯；可选界面通道只访问已审阅入口的容器内环回 HTTP。签名、公钥信任、执行授权与保护模式分别审阅。', 'Default: trusted-local. Docker keeps network=none and forwards bridge communication only to the instance Hub. An optional UI tunnel reaches only the reviewed entry’s container-loopback HTTP. Signatures, key trust, execution authorization, and protection profiles are reviewed separately.')),
    current, pending, selection, result
  ]);
}
