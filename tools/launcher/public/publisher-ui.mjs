// Publisher evidence is public data. This view never accepts signing secrets.
export function createPublisherUi(ctx) {
  const { state, api, el, button, definition, date, say, note, field, form, value, jsonView, reviewAction, toast } = ctx;
  let trust = null, host, lastEvidence = null, loading = false, loadError = null;
  const select = (name, title, options) => el('label', {}, [el('span', {}, title), el('select', { name }, options.map(([key, itemLabel]) => el('option', { value: key }, itemLabel)))]);
  const label = status => ({
    'verified': say('✓ 已通过对应密码学核验', '✓ Cryptographically verified'),
    'anchored-key': say('✓ 已匹配受信任作者公钥', '✓ Matches user-pinned trusted key'),
    'unanchored-key': say('⚠️ 未固定作者公钥（常规公开发布）', '⚠️ Signing key is not user-pinned'),
    'unanchored': say('⚠️ 无专属信任锚', '⚠️ No trust anchor'),
    'active': say('● 正常生效中', '● Currently active'),
    'revoked': say('✕ 已撤销', '✕ Revoked'),
    'inactive': say('○ 已停用或尚未生效', '○ Inactive or not yet effective'),
    'unsigned': say('⚠️ 未提供数字防伪签名', '⚠️ No signature evidence'),
    'unknown': say('未知', 'Unknown'),
    'not-checked': say('未核对', 'Not checked'),
    'mismatch': say('✕ 签名不匹配（存在篡改风险）', '✕ Mismatch')
  }[status] ?? status ?? say('未知', 'Unknown'));

  function reportView(input) {
    const report = input?.report ?? input ?? {};
    return el('div', { class: 'publisher-report stack' }, [
      definition([
        [say('数字防伪签名核验', 'Digital signature'), label(report.signatureStatus ?? (report.present === false ? 'unsigned' : 'not-checked'))],
        [say('发布者身份信任', 'Publisher identity trust'), label(report.publisherIdentity)],
        [say('公钥状态', 'Key status'), label(report.keyStatus)],
        [say('内容完整性防篡改', 'Artifact & byte integrity'), label(report.contentIntegrity)],
        [say('核验时间', 'Checked at'), date(report.checkedAt)],
        [say('运行权限状态', 'Execution permission'), say('此报告不授权运行；启动前仍须单独审阅', 'This report grants no execution permission; separate review is required')]
      ]),
      note(say('有效签名证明对应私钥签署了被核对的声明，制品完整性以报告中的独立检查为准。作者身份还需通过可信独立渠道核对公钥并建立信任；自带公钥不会自动证明作者身份或代码安全。', 'A valid signature establishes that the corresponding private key signed the checked statement. Artifact integrity follows the separate report check. Author identity needs an independently verified key and trust anchor; a bundled key does not establish identity or code safety.')),
      ...(report.notices ?? []).map(notice => note(`${say('风险公告', 'Risk advisory')} · ${notice.severity}: ${notice.message}${notice.expired ? say('（已过期，仅作历史记录）', ' (expired, historical only)') : ''}`, true)),
      report.error ? note(`${report.error.code}: ${report.error.message}`, true) : null,
      jsonView(say('查看完整公开证据技术报告 (JSON)', 'Complete public evidence report (JSON)'), report)
    ].filter(Boolean));
  }

  async function load() {
    if (loading) return;
    loading = true;
    loadError = null;
    renderContents();
    try {
      const data = await api('/api/publisher-trust');
      trust = data.trust;
    } catch (err) {
      loadError = err;
    } finally {
      loading = false;
      renderContents();
    }
  }

  async function changeTrust(change) {
    const preview = await api('/api/publisher-trust/preview', { change });
    const roleNames = {
      'publisher': say('作品发布签名（防伪认证）', 'Publisher signing'),
      'recovery': say('独立紧急恢复与撤销（挂失注销）', 'Independent recovery and revocation'),
      'advisory': say('安全风险公告（漏洞预警）', 'Trusted advisories')
    };
    const actionNames = {
      'anchor': say('导入并信任此证书', 'Import and trust key'),
      'remove-anchor': say('停用并移除此证书信任', 'Retire and remove trust')
    };
    reviewAction(say('变更本机作者证书信任', 'Change local publisher key trust'), [
      note(say('请确保您已通过可信的独立渠道核验了作者的公钥指纹。作品自带的证书不会自动成为信任锚；导入证书也不会授权任何代码自动运行。', 'Confirm the public-key fingerprint through an independent trusted channel. Artifact-supplied keys never become anchors automatically. This change does not authorize execution.'), true),
      definition([
        [say('发布者标识', 'Issuer ID'), preview.summary.issuer],
        [say('公钥指纹', 'Public-key fingerprint'), preview.summary.keyId],
        [say('证书角色用途', 'Role'), roleNames[preview.summary.role] ?? preview.summary.role],
        [say('本次操作', 'Action'), actionNames[preview.summary.action] ?? preview.summary.action]
      ]),
      jsonView(say('身份依据与本次变更技术详情', 'Identity basis and change details'), change, true)
    ], say('我已通过独立渠道核对了公钥指纹和作者身份，确认进行本次证书信任变更。', 'I independently checked this key fingerprint and author identity and accept this local trust change.'), async () => {
      await api('/api/publisher-trust/apply', { change, reviewDigest: preview.reviewDigest, accepted: true });
      state.reviews.clear();
      state.trustReview = null;
      await load();
      toast(say('作者证书信任已更新！启动程序仍须重新审阅。', 'Key trust updated. Review programs again before execution.'));
    });
  }

  function renderContents() {
    if (!host) return;

    // Each claim follows a separate backend check; downloads do not grant execution.
    const zeroConfigBanner = el('div', { class: 'audit-zero-config-tip' }, [
      el('span', {}, '💡 '),
      el('strong', {}, say('下载与运行分别审阅：', 'Download and execution are reviewed separately: ')),
      el('span', {}, say('软件源获取会检查声明的内容摘要。签名证据、公钥身份信任、运行授权和执行保护模式各有独立结果；下载不会启动程序或自动提供 OS 沙箱。', 'Source fetches check the declared content digest. Signature evidence, pinned identity trust, execution authorization, and protection profiles have separate results. Downloading never starts programs or automatically provides an OS sandbox.'))
    ]);

    // 1. Safety Pillars
    const safetyCards = el('div', { class: 'audit-safety-cards' }, [
      el('div', { class: 'audit-safety-card' }, [
        el('div', { class: 'safety-card-icon', 'aria-hidden': 'true' }, '🔒'),
        el('div', { class: 'safety-card-content' }, [
          el('h4', {}, say('SHA-256 内容完整性', 'SHA-256 Content Integrity')),
          el('p', {}, say('获取软件源制品时核对其声明的摘要，不一致则拒绝。摘要只能说明内容与该声明一致，不能证明声明作者的身份或程序安全。', 'Source artifacts are checked against their declared digest; mismatches are rejected. A digest establishes agreement with that declaration, not author identity or code safety.'))
        ])
      ]),
      el('div', { class: 'audit-safety-card' }, [
        el('div', { class: 'safety-card-icon', 'aria-hidden': 'true' }, '✍️'),
        el('div', { class: 'safety-card-content' }, [
          el('h4', {}, say('签名与发布者身份', 'Signatures & Publisher Identity')),
          el('p', {}, say('有效签名说明对应私钥签署了声明。没有签名或没有独立核对并固定的公钥时，显示未签名或身份未受信任；不会自动认定为真实作者。', 'A valid signature ties a statement to its signing key. Missing signatures or independently pinned keys remain unsigned or untrusted; they do not automatically establish authentic authorship.'))
        ])
      ]),
      el('div', { class: 'audit-safety-card' }, [
        el('div', { class: 'safety-card-icon', 'aria-hidden': 'true' }, '🛡️'),
        el('div', { class: 'safety-card-content' }, [
          el('h4', {}, say('运行授权与保护模式', 'Execution Review & Protection Profiles')),
          el('p', {}, say('获取和导入不启动程序。启动须审阅当前代码、权限与环境；默认 trusted-local 无 OS 沙箱，可另行选择并审阅容器或 Linux 用户模式。', 'Fetching and importing do not start programs. Starting requires current code, permissions, and environment review. Default trusted-local has no OS sandbox; container or Linux user profiles need separate selection and review.'))
        ])
      ])
    ]);

    // 2. Section Header
    const sectionHeader = el('div', { class: 'audit-section-header' }, [
      el('div', {}, [
        el('h3', {}, say('本机已受信任的作者与证书', 'Locally Trusted Publishers & Certificates')),
        el('p', { class: 'field-help' }, say('本机的证书信任库完全保存在您的电脑本地，由您自主管理，独立于任何远端云服务。', 'Your local trust store is stored on your machine and managed by you, independent of cloud services.'))
      ]),
      button(loading ? say('读取中…', 'Loading…') : say('🔄 刷新证书库', '🔄 Refresh Trust'), load, 'button button-small button-quiet', loading)
    ]);

    // 3. Keys or Empty / Loading
    let keysList = null;
    if (loading && !trust) {
      keysList = el('div', { class: 'audit-loading-bar' }, [
        el('span', { class: 'status-dot pulse' }),
        el('span', {}, say('正在读取本机证书信任库…', 'Reading local trust store…'))
      ]);
    } else if (loadError) {
      keysList = note(`${say('读取信任库失败', 'Failed to read trust store')}: ${loadError.message}`, true);
    } else {
      const keys = (trust?.issuers ?? []).flatMap(issuer => (issuer.keys ?? []).map(key => {
        const now = Date.now();
        const status = key.revokedAt && Date.parse(key.revokedAt) <= now ? 'revoked'
          : Date.parse(key.validFrom) <= now && (!key.validUntil || now < Date.parse(key.validUntil)) ? 'active' : 'inactive';
        const statusBadge = el('span', { class: `cert-status-badge ${status}` }, [
          el('span', { class: 'status-dot' }),
          status === 'revoked' ? say('✕ 已撤销', '✕ Revoked') : status === 'inactive' ? say('○ 已停用', '○ Inactive') : say('✓ 正常有效', '✓ Active')
        ]);
        const roleMap = {
          'publisher': say('作品发布签名（核对声明签名）', 'Publisher signing'),
          'recovery': say('独立恢复与撤销（紧急挂失凭据）', 'Recovery & revocation'),
          'advisory': say('安全风险公告（漏洞预警）', 'Trusted advisories')
        };
        return el('article', { class: 'publisher-cert-card' }, [
          el('div', { class: 'publisher-cert-header' }, [
            el('div', { class: 'publisher-cert-title-group' }, [
              el('span', { class: 'publisher-cert-icon' }, '📜'),
              el('h4', { class: 'publisher-cert-title' }, issuer.issuer)
            ]),
            statusBadge
          ]),
          el('div', { class: 'publisher-cert-keyid' }, `${say('指纹: ', 'Key ID: ')}${key.keyId}`),
          definition([
            [say('证书用途', 'Purpose'), roleMap[key.role] ?? key.role],
            [say('生效时间', 'Valid from'), date(key.validFrom)],
            ...(key.validUntil ? [[say('截止时间', 'Valid until'), date(key.validUntil)]] : []),
            ...(key.revokedAt ? [[say('撤销时间', 'Revoked at'), date(key.revokedAt)]] : []),
            ...(key.identityBasis?.type ? [[say('核验方式', 'Verification'), key.identityBasis.type === 'public-key-fingerprint' ? say('核对公钥指纹', 'Fingerprint') : say('人工确认', 'Manual')]] : [])
          ]),
          jsonView(say('查看证书技术详情与公钥', 'Certificate details & public key'), {
            publicKey: key.publicKey,
            identityBasis: key.identityBasis,
            validFrom: key.validFrom,
            validUntil: key.validUntil,
            revokedAt: key.revokedAt
          }),
          el('div', { class: 'publisher-cert-actions' }, [
            button(
              say('停用此证书信任', 'Retire this key anchor'),
              () => changeTrust({ action: 'remove-anchor', issuer: issuer.issuer, keyId: key.keyId }),
              'button button-small button-danger',
              Boolean(key.validUntil || key.revokedAt)
            )
          ])
        ]);
      }));

      if (!keys.length) {
        keysList = el('div', { class: 'audit-empty-card' }, [
          el('div', { class: 'audit-empty-icon' }, '🛡️'),
          el('div', { class: 'audit-empty-info' }, [
            el('h4', {}, say('尚未建立发布者公钥信任', 'No Publisher Keys Pinned Yet')),
            el('p', {}, say('本机尚未固定第三方发布者的公钥。内容摘要核对不会建立身份信任；没有签名的制品仍会明确显示未签名。启动需独立审阅，默认 trusted-local 不提供 OS 沙箱。', 'No third-party publisher keys are pinned locally. Digest checks do not establish identity trust; unsigned artifacts remain explicitly unsigned. Execution requires separate review, and default trusted-local provides no OS sandbox.')),
            el('p', { class: 'audit-empty-hint' }, say('如果您从知名作者处获取了专属防伪公钥，可在下方展开“高级工具”进行导入。', 'If you received a public key from a trusted author, expand the advanced tools below to import it.'))
          ])
        ]);
      } else {
        keysList = el('div', { class: 'stack' }, keys);
      }
    }

    // 4. Forms (Streamlined to 2 required fields + collapsed optional parameters)
    const optionalFields = el('details', { class: 'audit-options-drawer' }, [
      el('summary', {}, say('⚙️ 更多可选设置（默认已优选：发布签名 · 指纹核对）', '⚙️ Optional advanced parameters (defaults recommended)')),
      el('div', { class: 'stack audit-options-stack' }, [
        select('role', say('证书用途', 'Key role'), [
          ['publisher', say('发布签名（核对声明签名）', 'Publisher signing')],
          ['recovery', say('独立恢复与撤销（紧急挂失注销）', 'Independent recovery and revocation')],
          ['advisory', say('安全风险公告（漏洞预警）', 'Trusted advisories')]
        ]),
        select('basis', say('身份核对方式', 'Identity verification method'), [
          ['public-key-fingerprint', say('已核对官方公布的公钥指纹', 'Independently checked fingerprint')],
          ['manual-confirmation', say('通过可信渠道人工确认', 'Manual confirmation')]
        ]),
        field('note', say('核验记录备注（可选，例如：来源于作者推特或官网）', 'Verification note (optional)'), '', { required: false })
      ])
    ]);

    const anchor = form([
      field('issuer', say('作者或发布者标识（例如：peros.official 或 团队名称）', 'Issuer ID (e.g., peros.official or team name)')),
      field('publicKey', say('公开 Ed25519 公钥（32 字节原始公钥的 Base64）', 'Public Ed25519 key (Base64 of the 32-byte raw public key)')),
      optionalFields
    ], say('预览并导入证书信任', 'Preview key trust change'), f => changeTrust({
      action: 'anchor',
      issuer: value(f, 'issuer'),
      publicKey: value(f, 'publicKey'),
      role: value(f, 'role') || 'publisher',
      identityBasis: { type: value(f, 'basis') || 'public-key-fingerprint', ...(value(f, 'note') ? { note: value(f, 'note') } : {}) }
    }), say('注意：仅能录入公开的公钥字符串。私钥由作者自行保存，严禁输入任何私钥。', 'Public keys only. Authors retain private keys; never enter private keys.'));

    const results = el('div', {}, lastEvidence ? reportView(lastEvidence) : null);
    const evidence = form([
      field('evidencePath', say('签名证据文件路径（.json）', 'Public evidence JSON file path')),
      field('artifactPath', say('被验证的作品文件路径（可选，核验具体安装包时填写）', 'Artifact file path (optional, for artifact signatures)'), '', { required: false })
    ], say('解析并核对签名', 'Verify signature & statement'), async f => {
      const preview = await api('/api/publisher-evidence/preview', { evidencePath: value(f, 'evidencePath'), ...(value(f, 'artifactPath') ? { artifactPath: value(f, 'artifactPath') } : {}) });
      lastEvidence = preview;
      results.replaceChildren(reportView(preview));
      if (preview.report.accepted) results.append(button(say('审阅并记录这个已验证声明到本机信任库', 'Review and record this verified statement'), () => reviewAction(say('记录发布者公开声明', 'Record public publisher statement'), [reportView(preview), jsonView(say('声明的准确内容', 'Exact statement contents'), preview.evidence, true)], say('我已审阅这份公开声明，允许更新本机的序列、轮换、撤销或风险缓存；这不会启动程序。', 'I reviewed this public statement and allow updating local sequence, rotation, revocation or advisory records. This will not start programs.'), async () => {
        const result = await api('/api/publisher-evidence/observe', { previewId: preview.previewId, accepted: true }); lastEvidence = result; results.replaceChildren(reportView(result)); state.reviews.clear(); state.trustReview = null; await load();
      }), 'button button-small button-primary'));
    });

    // 5. Advanced drawer
    const advancedDrawer = el('details', { class: 'source-advanced-filters-drawer', id: 'publisher-advanced-tools' }, [
      el('summary', {}, say('⚙️ 高级工具：导入作者公钥与离线文件验签（面向开发者与管理员）', '⚙️ Advanced Tools: Import Public Keys & Offline Statement Verification (Developers/Admins)')),
      el('div', { class: 'stack audit-advanced-stack' }, [
        el('div', { class: 'audit-subpanel' }, [
          el('h4', {}, say('＋ 导入作者防伪公钥到本机信任库', '＋ Import Author Public Key')),
          el('p', { class: 'field-help' }, say('用于将作者公开的防伪公钥保存到本机。只需填写作者标识与公钥字符串两项，私钥永远保存在作者本地，绝不在此输入。', 'Enter public keys only. Authors keep private keys locally; never send private keys here.')),
          anchor
        ]),
        el('div', { class: 'audit-subpanel' }, [
          el('h4', {}, say('🔍 离线文件签名与风险公告验签', '🔍 Offline File Signature & Statement Audit')),
          el('p', { class: 'field-help' }, say('核对本地的签名证据 JSON 文件与作品文件，核查防伪签名、公钥轮换、撤销或安全预警。', 'Verify local signature evidence JSON files and artifacts against rotations, revocations, and advisories.')),
          evidence,
          results
        ]),
        trust ? jsonView(say('查看本机完整技术信任记录 (JSON)', 'Complete local trust records (JSON)'), trust) : null
      ].filter(Boolean))
    ]);

    host.replaceChildren(...[
      zeroConfigBanner,
      safetyCards,
      sectionHeader,
      keysList,
      advancedDrawer
    ].filter(Boolean));
  }

  function trustPanel() {
    host = el('div', { class: 'stack', id: 'publisher-trust-content' });
    renderContents();
    if (!trust && !loading) {
      void load();
    }
    return host;
  }

  return { trustPanel, reportView, load };
}
