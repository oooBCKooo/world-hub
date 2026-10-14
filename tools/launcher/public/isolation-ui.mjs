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
    field('httpComponents', say('允许界面的入口模块 ID（可选）', 'Entry module ID allowed to expose UI (optional)'), policy.http?.components?.join(',') ?? '', { required: false }),
    field('memoryMiB', say('每模块内存 MiB', 'Memory MiB per module'), policy.limits?.memoryMiB ?? 256, { type: 'number' }),
    field('pids', say('每模块 PID 配额', 'PID limit per module'), policy.limits?.pids ?? 64, { type: 'number' }),
    field('cpus', say('每模块 CPU 配额', 'CPU limit per module'), policy.limits?.cpus ?? 1, { type: 'number' }),
    field('containerUser', say('容器非 root UID', 'Non-root container UID'), policy.limits?.user ?? 1000, { type: 'number' })
  ]);
  const user = el('fieldset', { class: 'stack' }, [
    note(say('此模式要求已经具有权限的 Linux 监督者、已有非 root 账号，以及预先配置的模块目录权限。工具不创建账号、不调用 sudo、不改变权限。用户分离不限制该账号原本能读的文件、网络或子进程。', 'This profile requires an already privileged Linux supervisor, an existing non-root account, and preconfigured module-directory permissions. It creates no accounts, invokes no sudo, and changes no permissions. User separation does not restrict files, network access, or child processes already allowed to that account.'), true),
    field('setprivPath', say('已安装 setpriv 的绝对路径', 'Absolute path to installed setpriv'), policy.setprivPath ?? '/usr/bin/setpriv'),
    field('uid', say('已有非 root UID', 'Existing non-root UID'), policy.user?.uid ?? '', { type: 'number' }),
    field('gid', say('已有主组 GID', 'Existing primary GID'), policy.user?.gid ?? '', { type: 'number' })
  ]);
  const result = el('div', { role: 'status', 'aria-live': 'polite' }), current = el('div', { class: 'isolation-current' }), pending = el('div', { class: 'isolation-pending' });
  const profileName = profile => [...selector.options].find(option => option.value === profile)?.textContent ?? profile;
  function normalizedPolicy(input = {}) {
    const profile = input.profile ?? (input.image ? 'docker-node-headless/v1' : 'trusted-local');
    if (profile === 'trusted-local') return { profile };
    if (profile === 'linux-existing-user/v1') return { profile, setprivPath: input.setprivPath ?? '/usr/bin/setpriv', user: { uid: Number(input.user?.uid ?? ''), gid: Number(input.user?.gid ?? '') } };
    return { profile, dockerPath: input.dockerPath ?? '', endpoint: input.endpoint ?? 'unix:///var/run/docker.sock',
      ...(profile === 'docker-runtime/v1'
        ? { images: Object.fromEntries(['node', 'python'].filter(kind => input.images?.[kind]).map(kind => [kind, input.images[kind]])), http: { components: [...new Set(input.http?.components ?? [])].sort() } }
        : { image: input.image ?? '' }),
      limits: { memoryMiB: Number(input.limits?.memoryMiB ?? 256), pids: Number(input.limits?.pids ?? 64), cpus: Number(input.limits?.cpus ?? 1), user: Number(input.limits?.user ?? 1000) } };
  }
  function proposedPolicy() {
    const read = name => String((docker.querySelector(`[name="${name}"]`) ?? user.querySelector(`[name="${name}"]`))?.value ?? '').trim();
    const profile = selector.value;
    return normalizedPolicy({ profile, setprivPath: read('setprivPath'), user: { uid: read('uid'), gid: read('gid') }, dockerPath: read('dockerPath'), endpoint: read('endpoint'),
      ...(profile === 'docker-runtime/v1' ? { images: { node: read('nodeImage'), python: read('pythonImage') }, http: { components: read('httpComponents').split(',').map(id => id.trim()).filter(Boolean) } } : { image: read('nodeImage') }),
      limits: { memoryMiB: read('memoryMiB'), pids: read('pids'), cpus: read('cpus'), user: read('containerUser') } });
  }
  function summary() {
    const selected = normalizedPolicy(state.isolationSelection ?? {});
    const isPending = JSON.stringify(proposedPolicy()) !== JSON.stringify(selected);
    current.replaceChildren(el('div', { class: 'isolation-status-card' }, [
      el('div', { class: 'isolation-active-row' }, [
        el('span', { class: 'status-dot status-dot-active' }),
        el('strong', {}, `${say('下次审阅的默认选择', 'Default for the next review')}: `),
        el('span', { class: 'pill pill-teal' }, profileName(selected.profile))
      ]),
      isPending ? el('div', { class: 'isolation-pending-row' }, [
        el('span', { class: 'status-dot status-dot-pending' }),
        el('strong', {}, `${say('待应用配置变更', 'Pending Configuration Change')}: `),
        el('span', { class: 'pill pill-amber' }, profileName(selector.value))
      ]) : el('div', { class: 'isolation-match-row subtle' }, [
        el('span', {}, `✓ ${say('表单与已选择的完整配置一致', 'Form matches the complete selected configuration')}`)
      ]),
      note(say('此默认选择只用于后续的逐包审阅，不会改变已有运行。实例中的执行模式和参数以该次运行记录为准。', 'This default is used for subsequent package reviews and does not change existing runs. Each instance shows the profile and parameters recorded for that run.'))
    ]));
    pending.replaceChildren();
  }
  function update() { const isUser = selector.value === 'linux-existing-user/v1', isDocker = selector.value.startsWith('docker-'); docker.hidden = !isDocker; docker.disabled = !isDocker; user.hidden = !isUser; user.disabled = !isUser; summary(); }
  selector.addEventListener('change', update); update();
  docker.querySelector('[name="cpus"]').step = 'any';
  const selection = form([el('label', {}, [el('span', {}, say('执行保护模式', 'Execution protection profile')), selector]), docker, user], say('探测并选择这个执行模式', 'Probe and select this execution profile'), async f => {
    const profile = value(f, 'profile');
    if (profile === 'trusted-local') { state.isolationSelection = null; state.reviews.clear(); state.trustReview = null; result.replaceChildren(note(say('已选择 trusted-local 供后续审阅。启动仍须逐包审阅；此模式不提供 OS 隔离。', 'Selected trusted-local for subsequent reviews. Starting still requires package review; this profile provides no OS isolation.'))); summary(); return; }
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

  const securityAdvisory = el('div', { class: 'security-advisory-card' }, [
    el('div', { class: 'security-advisory-header' }, [
      el('div', { class: 'security-title-wrap' }, [
        el('h3', {}, say('权限模型与保护边界说明', 'Permission Model & Security Boundaries'))
      ]),
      el('span', { class: 'pill pill-amber' }, say('保护取决于该次运行模式', 'Protection depends on each run profile'))
    ]),
    el('p', { class: 'security-text' }, say('权限是模块的声明，用户审阅是对当前代码和环境的授权。trusted-local 不强制限制文件、网络或资源。Docker 仅在已审阅的固定范围内隔离；已有 Linux 用户模式只分离身份。', 'Permissions are module declarations; review authorizes current code and environment. Trusted-local does not enforce file, network, or resource limits. Docker isolates only within its reviewed scope; the existing Linux user profile separates identity only.')),
    el('p', { class: 'security-text' }, say('每个实例拥有独立工作目录与 Hub 身份，这些目录本身不是 OS 隔离。同账户下的本机程序仍可能读取其他实例文件。请只运行你信任的代码，并用操作系统账户与目录权限保护数据。', 'Each instance has an independent directory and Hub identity; directories alone provide no OS isolation. Local processes under the same account may read other instances. Run trusted code and use operating system controls for sensitive data.'))
  ]);

  return panel(say('执行保护模式与安全边界', 'Execution Protection Profiles & Security Boundaries'), [
    securityAdvisory,
    note(say('默认 trusted-local。Docker 模式保留 network=none，仅转交实例 Hub 的桥通讯；可选界面通道只访问已审阅入口的容器内环回 HTTP。签名、公钥信任、执行授权与保护模式分别审阅。', 'Default: trusted-local. Docker keeps network=none and forwards bridge communication only to the instance Hub. An optional UI tunnel reaches only the reviewed entry’s container-loopback HTTP. Signatures, key trust, execution authorization, and protection profiles are reviewed separately.')),
    current, pending, selection, result
  ]);
}
