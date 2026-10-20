// Current Launcher language preference and bounded error localization.
export function initialLanguage() {
  try { const saved = localStorage.getItem('world-hub.launcher.language'); if (saved === 'zh' || saved === 'en') return saved; } catch {}
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function localizeErrorMessage(input, language = 'zh') {
  if (language !== 'zh' || !input || typeof input !== 'string') return input;
  let text = input.trim();
  if (!text) return input;
  let prefix = '';
  if (/^Error:\s*/i.test(text)) {
    prefix = '错误：';
    text = text.replace(/^Error:\s*/i, '');
  }

  const EXACT_MAP = {
    'The target module must be stopped before saving its configuration.': '请先停止要修改的模块实例，再保存配置。',
    'Review the selected instances and their shared consumers before stopping.': '请审阅选定实例及其共享消费者，再确认停止。',
    'This module has no verified artifact cache.': '该模块没有可重新核验的制品缓存。',
    'Reviewed source digest does not match the configured index pin.': '本次索引摘要与来源配置的固定摘要不一致，请重新检查。',
    'Start the local Hub first.': '请先启动世界枢纽。',
    'The local Hub is stopping.': '世界枢纽正在停止，请等待退出确认。',
    'Launcher is stopping.': 'Launcher 正在停止。',
    'Wait for this operation to complete.': '请等待当前操作完成。',
    'A group member must be an existing module instance.': '模块组只能引用已登记的模块实例。',
    'Supply the exact current group revision.': '请重新载入模块组，再提交当前修订。',
    'Invalid software source URL': '无效的软件源 URL 地址',
    'Invalid software source': '无效的软件源配置或地址',
    'Software source exceeds download size bound': '软件源下载内容超过大小限制',
    'Software source download timed out': '软件源下载请求超时',
    'Software source total download deadline exceeded': '软件源总下载耗时超过上限',
    'Source index hash mismatch': '软件源索引的 SHA-256 哈希校验不匹配',
    'Remote indices cannot refer to local filesystem artifacts or publisher evidence': '远程软件源索引不能引用本地文件系统制品或发布者凭据',
    'Invalid source index identity or entries': '软件源索引标识或条目列表格式无效',
    'Invalid source entry metadata': '软件源条目元数据格式无效',
    'Invalid source capability list': '软件源能力列表声明无效',
    'Invalid source capability contract': '软件源能力契约格式无效',
    'Duplicate source capability contract': '软件源包含重复的能力契约声明',
    'Invalid publisher evidence digest': '发布者签名凭据摘要无效',
    'Invalid distribution artifact': '分发制品格式无效',
    'Artifact contains generated or private source material': '制品中包含构建生成物或私有源文件',
    'Invalid or duplicate artifact file': '制品文件列表无效或存在重复路径',
    'Artifact file hash or size mismatch': '制品文件 SHA-256 哈希或大小校验不匹配',
    'Artifact file Base64 is not canonical': '制品文件 Base64 编码不规范',
    'Artifact file/directory collision': '制品中存在同名文件与目录冲突',
    'Review component licenses and explicitly acknowledge redistribution rights before copying or publishing': '在复制或发布前，请先审阅组件许可证并明确确认重新分发权限',
    'Module changed while copying; the incomplete destination requires a fresh review': '模块在复制过程中内容发生改变；未完成的目标目录需要重新审阅',
    'Comment ID conflict: preserve both documents and resolve explicitly': '评论 ID 冲突：请保留两份文档并手动排查',
    'Missing source directory': '缺少来源目录',
    'Choose --runtime node or python': '运行环境仅支持选择 node 或 python',
    'Installed Hub version is required': '缺少已安装的 Hub 版本信息',
    'lock has missing or unsupported fields': '锁文件 (pack.lock) 缺少必填字段或包含不受支持的字段',
    'hubCompatibility has missing or unsupported fields': 'hubCompatibility 缺少必填字段或包含不受支持的字段',
    'Operation cancelled by user': '操作已被用户取消',
    'Operation timed out': '操作执行超时',
    'Session expired': '本地管理会话已失效',
    'Unauthorized': '未获得操作授权',
    'fetch failed': '网络请求失败 (fetch failed)',
    'Failed to fetch': '网络请求失败 (Failed to fetch)',
    'NetworkError when attempting to fetch resource.': '获取网络资源时发生网络错误',
    'The operation was aborted': '操作已中止',
    'Aborted': '已中止',
    'Invalid local Launcher address': '无效的本机 Launcher 地址',
    'Launcher page is unavailable': 'Launcher 页面不可用',
    'Invalid port': '端口号无效',
    'Choose --inspect-lock or --clean-lock.': '请选择 --inspect-lock 或 --clean-lock。',
    'Invalid interpreter response': '解释器返回信息无效',
    'Interpreter wrappers are unsupported': '不支持解释器包装脚本，请指定实际二进制文件路径',
    'Installed source inventory differs.': '已安装的源码清单与预期不一致。',
    'Runtime digest differs.': '运行时摘要校验不匹配。',
    'Invalid instance environment': '实例运行环境配置无效',
    'Invalid Hub port': 'Hub 端口无效',
    'Default Hub exit unconfirmed': '世界枢纽退出未确认',
    'Stop all Launcher-managed programs first': '请先停止所有由 Launcher 托管的程序',
    'Stop the whole instance or wait for the current run to finish': '请先停止整个实例或等待当前运行结束',
    'Launch code is invalid. Open a new Launcher session from its owning terminal.': '启动授权码无效或已失效。请从启动该服务的终端重新打开一次新的 Launcher 页面。',
    'Launch code is invalid or already used. Open a new Launcher session from its owning terminal.': '启动授权码无效或已失效。请从启动该服务的终端重新打开一次新的 Launcher 页面。',
    'Bootstrap requires the exact Launcher origin.': '初始化引导请求必须与本机 Launcher 源地址严格一致。',
    'Only same-origin API and resource requests are accepted.': '仅接受同源 API 与资源请求。',
    'Only this Launcher origin is accepted.': '仅接受当前 Launcher 的源地址请求。',
    'Invalid request origin.': '无效的请求源地址。',
    'Launcher authorization required.': '需要有效的 Launcher 授权凭据。',
    'Launcher CSRF token required.': '缺少或无效的 Launcher CSRF 防伪令牌。',
    'Session required': '需要会话授权凭据。',
    'Session authorization is required.': '需要有效的会话授权凭据。',
    'This page has no local authorization session. Run world-hub ui --open and use the page opened by the Launcher.': '当前页面没有本地授权会话。请运行 world-hub ui --open，从 Launcher 打开的页面进入。',
    'The local management session expired. Run world-hub ui --open again to open a new authorized entry.': '本地管理会话已失效。请重新运行 world-hub ui --open 打开新的授权入口。',
    'Missing or unsupported request fields.': '请求字段缺失或包含不受支持的字段。',
    'Unsupported navigation query.': '不受支持的页面导航参数。',
    'Unsupported query.': '不受支持的请求参数。',
    'Use application/json.': '请求类型必须为 application/json。',
    'Invalid JSON body.': '请求内容不是有效的 JSON 格式。',
    'Unknown Launcher operation.': '未知的 Launcher 操作。',
    'Select a source.': '请选择一个软件源。'
  };

  if (EXACT_MAP[text]) return prefix + EXACT_MAP[text];

  text = text.replace(/Software source HTTP status (\d+); redirects are not followed/gi, (_, code) => {
    if (code === '404') return '软件源未找到该资源（HTTP 404）；出于安全考虑系统不跟随重定向';
    if (code === '403') return '软件源拒绝访问（HTTP 403）；出于安全考虑系统不跟随重定向';
    if (code === '500' || code === '502' || code === '503' || code === '504') return `软件源服务器异常（HTTP ${code}）；出于安全考虑系统不跟随重定向`;
    return `软件源返回 HTTP ${code}；出于安全考虑系统不跟随重定向`;
  });

  text = text.replace(/Software sources require HTTPS without credentials, fragments or custom ports/gi,
    '软件源必须使用 HTTPS 协议，且不能包含用户名密码凭据、URL 锚点或自定义端口');

  text = text.replace(/Remote software sources cannot contact a local or private address under the selected policy/gi,
    '在当前安全策略下，远程软件源不能请求本地或私有网络地址');

  text = text.replace(/Artifact lacks (.+)/gi, '制品缺少必需文件：$1');

  text = text.replace(/connect ECONNREFUSED ([^\s]+)/gi, '连接目标服务失败：目标拒绝连接 ($1)');
  text = text.replace(/connect ETIMEDOUT ([^\s]+)/gi, '连接目标服务超时 ($1)');
  text = text.replace(/getaddrinfo ENOTFOUND ([^\s]+)/gi, '域名解析失败，未找到对应主机 ($1)');
  text = text.replace(/ENOENT: no such file or directory, (.*)/gi, '文件或目录不存在：$1');
  text = text.replace(/EACCES: permission denied, (.*)/gi, '访问权限被拒绝：$1');
  text = text.replace(/EEXIST: file already exists, (.*)/gi, '文件或目录已存在：$1');
  text = text.replace(/EBUSY: resource busy or locked, (.*)/gi, '资源繁忙或已被其他进程锁定：$1');
  text = text.replace(/EADDRINUSE: address already in use (.*)/gi, '网络端口已被占用：$1');
  text = text.replace(/EPERM: operation not permitted, (.*)/gi, '操作未获得许可：$1');

  text = text.replace(/\bfetch failed\b/gi, '网络请求失败 (fetch failed)');
  text = text.replace(/\bFailed to fetch\b/gi, '网络请求失败 (Failed to fetch)');

  text = text.replace(/Launch code is invalid.*/gi, '启动授权码无效或已失效。请从启动该服务的终端重新打开一次新的 Launcher 页面。');
  text = text.replace(/Bootstrap requires the exact Launcher origin.*/gi, '初始化引导请求必须与本机 Launcher 源地址严格一致。');
  text = text.replace(/Only (?:same-origin|this Launcher origin).*accepted.*/gi, '仅接受来自本机 Launcher 的同源请求。');
  text = text.replace(/Launcher authorization required.*/gi, '需要有效的 Launcher 授权凭据。');
  text = text.replace(/Launcher CSRF token required.*/gi, '缺少或无效的 Launcher CSRF 防伪令牌。');

  return prefix + text;
}
