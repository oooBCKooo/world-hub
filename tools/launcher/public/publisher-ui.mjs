// Publisher evidence is public data. This view never accepts signing secrets.
export function createPublisherUi(ctx) {
  const { state, api, el, button, definition, date, say, panel, note, field, form, value, jsonView, reviewAction, toast } = ctx;
  let trust = null, host, lastEvidence = null;
  const select = (name, title, options) => el('label', {}, [el('span', {}, title), el('select', { name }, options.map(([key, label]) => el('option', { value: key }, label)))]);
  const label = status => ({
    'verified': say('已验证', 'Verified'), 'anchored-key': say('用户固定的公钥锚通过', 'User-pinned public key matches'),
    'unanchored-key': say('签名公钥尚未被用户信任', 'Signing key is not user-pinned'), 'unanchored': say('无信任锚', 'No trust anchor'),
    'active': say('当前有效', 'Currently active'), 'revoked': say('已撤销', 'Revoked'), 'inactive': say('已停用或尚未生效', 'Retired or not yet effective'),
    'unsigned': say('未提供签名证据', 'No signature evidence'), 'unknown': say('未知', 'Unknown'),
    'not-checked': say('未核对', 'Not checked'), 'mismatch': say('不匹配', 'Mismatch')
  }[status] ?? status ?? say('未知', 'Unknown'));
  function reportView(input) {
    const report = input?.report ?? input ?? {};
    return el('div', { class: 'publisher-report stack' }, [
      definition([
        [say('签名密码学验证', 'Cryptographic signature'), label(report.signatureStatus ?? (report.present === false ? 'unsigned' : 'not-checked'))],
        [say('发布者公钥信任', 'Publisher key trust'), label(report.publisherIdentity)],
        [say('公钥状态', 'Key status'), label(report.keyStatus)],
        [say('作品身份及字节绑定', 'Artifact identity and byte binding'), label(report.contentIntegrity)],
        [say('检查时间', 'Checked at'), date(report.checkedAt)],
        [say('执行授权', 'Execution authorization'), say('仍须单独审阅', 'Separate review still required')]
      ]),
      note(say('签名证明相应私钥签署了这份声明；公钥锚的身份依据由用户核对。它不证明代码安全、业务正确或运行隔离。缓存证据不能证明不存在新的撤销或风险公告。', 'A signature proves that the corresponding private key signed this statement. The user checks the identity basis of the key anchor. This does not establish code safety, business correctness, or isolation. Cached evidence cannot establish absence of new revocations or advisories.')),
      ...(report.notices ?? []).map(notice => note(`${say('风险公告', 'Risk advisory')} · ${notice.severity}: ${notice.message}${notice.expired ? say('（已过期，仅作历史记录）', ' (expired, historical only)') : ''}`, true)),
      report.error ? note(`${report.error.code}: ${report.error.message}`, true) : null,
      jsonView(say('完整公开证据报告', 'Complete public evidence report'), report)
    ].filter(Boolean));
  }
  async function load() { const data = await api('/api/publisher-trust'); trust = data.trust; renderContents(); }
  async function changeTrust(change) {
    const preview = await api('/api/publisher-trust/preview', { change });
    reviewAction(say('改变本机发布者公钥信任', 'Change local publisher key trust'), [
      note(say('请通过你认可的独立途径核对公钥指纹。作品附带的公钥不会自动成为信任锚；这个操作也不授权任何代码运行。恢复公钥应与发布公钥独立保存。', 'Confirm the public-key fingerprint through an independent channel you trust. Artifact-supplied keys never become anchors automatically. This change does not authorize execution. Keep the recovery key separate from the publisher key.'), true),
      definition([[say('发布者标识', 'Issuer ID'), preview.summary.issuer], [say('公钥指纹', 'Public-key fingerprint'), preview.summary.keyId], [say('角色', 'Role'), preview.summary.role], [say('操作', 'Action'), preview.summary.action]]),
      jsonView(say('身份依据与本次变更', 'Identity basis and this change'), change, true)
    ], say('我已通过独立途径核对公钥指纹和身份依据，并接受这次本机信任变更。', 'I independently checked this key fingerprint and identity basis and accept this local trust change.'), async () => {
      await api('/api/publisher-trust/apply', { change, reviewDigest: preview.reviewDigest, accepted: true });
      state.reviews.clear(); state.trustReview = null; await load(); toast(say('公钥信任已更新，启动程序仍须重新审阅。', 'Key trust updated. Review programs again before execution.'));
    });
  }
  function renderContents() {
    if (!host) return;
    const keys = (trust?.issuers ?? []).flatMap(issuer => issuer.keys.map(key => el('article', { class: 'review-module' }, [
      el('h3', {}, issuer.issuer), el('p', { class: 'review-digest' }, key.keyId),
      definition([[say('角色', 'Role'), key.role], [say('状态', 'Status'), key.revokedAt ? label('revoked') : key.validUntil ? label('inactive') : label('active')]]),
      jsonView(say('身份依据与公钥', 'Identity basis and public key'), { publicKey: key.publicKey, identityBasis: key.identityBasis, validFrom: key.validFrom, validUntil: key.validUntil, revokedAt: key.revokedAt }),
      button(say('审阅停用这个信任锚', 'Review retiring this anchor'), () => changeTrust({ action: 'remove-anchor', issuer: issuer.issuer, keyId: key.keyId }), 'button button-small button-quiet', Boolean(key.validUntil || key.revokedAt))
    ])));
    const anchor = form([
      field('issuer', say('发布者标识（由双方约定）', 'Issuer ID (agreed externally)')),
      field('publicKey', say('Ed25519 公钥（32 字节 Base64）', 'Ed25519 public key (32-byte Base64)')),
      select('role', say('公钥角色', 'Key role'), [['publisher', say('发布签名', 'Publisher signing')], ['recovery', say('独立恢复与撤销', 'Independent recovery and revocation')], ['advisory', say('受信风险公告', 'Trusted advisories')]]),
      select('basis', say('你如何核对身份', 'How you checked identity'), [['public-key-fingerprint', say('独立核对公钥指纹', 'Independently checked fingerprint')], ['manual-confirmation', say('人工确认', 'Manual confirmation')]]),
      field('note', say('身份核对记录（可选）', 'Identity-check note (optional)'), '', { required: false })
    ], say('预览公钥信任变更', 'Preview key trust change'), f => changeTrust({ action: 'anchor', issuer: value(f, 'issuer'), publicKey: value(f, 'publicKey'), role: value(f, 'role'), identityBasis: { type: value(f, 'basis'), ...(value(f, 'note') ? { note: value(f, 'note') } : {}) } }), say('只输入公开公钥。私钥由作者在自己的本机签名工具中使用，绝不上传到 Launcher 或社区。', 'Enter public keys only. Authors use private keys in their own local signing tools; never send them to the Launcher or community.'));
    const results = el('div', {}, lastEvidence ? reportView(lastEvidence) : null);
    const evidence = form([
      field('evidencePath', say('公开证据 JSON 文件路径', 'Public evidence JSON file path')),
      field('artifactPath', say('作品制品文件路径（验证作品签名时填写）', 'Artifact file path (for artifact signatures)'), '', { required: false })
    ], say('检查签名、轮换、撤销或风险声明', 'Check signature, rotation, revocation or advisory'), async f => {
      const preview = await api('/api/publisher-evidence/preview', { evidencePath: value(f, 'evidencePath'), ...(value(f, 'artifactPath') ? { artifactPath: value(f, 'artifactPath') } : {}) });
      lastEvidence = preview;
      results.replaceChildren(reportView(preview));
      if (preview.report.accepted) results.append(button(say('审阅并记录这个已验证声明', 'Review and record this verified statement'), () => reviewAction(say('记录发布者公开声明', 'Record public publisher statement'), [reportView(preview), jsonView(say('声明的准确内容', 'Exact statement contents'), preview.evidence, true)], say('我已审阅这份公开声明，允许更新本机的序列、轮换、撤销或风险缓存；这不会启动程序。', 'I reviewed this public statement and allow updating local sequence, rotation, revocation or advisory records. This will not start programs.'), async () => {
        const result = await api('/api/publisher-evidence/observe', { previewId: preview.previewId, accepted: true }); lastEvidence = result; results.replaceChildren(reportView(result)); state.reviews.clear(); state.trustReview = null; await load();
      }), 'button button-small button-primary'));
    });
    host.replaceChildren(...[
      note(say('本机信任库独立于社区账号。添加、停用和记录声明都需要审阅；历史撤销及序列记录会保留。', 'Local publisher trust is independent of community accounts. Anchoring, retiring keys and recording statements require review. Revocation and sequence history is retained.')),
      button(say('读取当前公钥与记录', 'Read current keys and records'), load, 'button button-small button-quiet'),
      ...keys,
      !keys.length ? el('p', { class: 'field-help' }, trust ? say('当前没有用户固定的公钥锚。', 'No user-pinned key anchors.') : say('先读取本机信任库，或审阅添加新的公钥。', 'Read local trust state or review adding a public key.')) : null,
      el('details', { class: 'json-details' }, [el('summary', {}, say('添加公钥信任锚', 'Add a public-key trust anchor')), anchor]),
      el('details', { class: 'json-details' }, [el('summary', {}, say('检查与记录公开声明', 'Check and record public statements')), evidence, results]),
      trust ? jsonView(say('完整本机公开信任记录', 'Complete local public trust records'), trust) : null
    ].filter(Boolean));
  }
  function trustPanel() { host = el('div', { class: 'stack', id: 'publisher-trust-content' }); renderContents(); return panel(say('发布者公钥与风险证据', 'Publisher keys and risk evidence'), [host]); }
  return { trustPanel, reportView };
}
