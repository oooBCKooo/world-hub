// World Hub 原生模块生命周期管理与拓扑编排服务
import { mkdir, readFile, writeFile, rename, unlink, rm, readdir, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalPrograms } from '../../tools/launcher/local-programs.mjs';
import { ModuleGroups, normalizeModuleGroup } from '../../tools/launcher/module-groups.mjs';
import { ModuleVersions } from '../../tools/launcher/module-versions.mjs';
import { ModuleUninstall } from '../../tools/launcher/module-uninstall.mjs';
import { ModuleResources } from '../../tools/launcher/resources.mjs';
import { WiringDefaults } from '../../tools/launcher/wiring-defaults.mjs';
import { DemandLifecycle } from '../../tools/launcher/demand-lifecycle.mjs';
import { PathsService } from '../../tools/launcher/paths-service.mjs';
import { defaultLauncherRoot } from '../../tools/launcher/owner-lock.mjs';
import { inspectDeployment } from '../../scripts/runtime/deployment.mjs';
import { repository } from '../../scripts/runtime/package.mjs';
import { validateExecutionDefaults } from '../../scripts/runtime/execution-defaults.mjs';
import { prepareDependencies } from '../../scripts/runtime/dependency-prepare.mjs';
import { importLocalArtifact } from '../../tools/launcher/local-artifacts.mjs';
import { GlobalExternalPrograms } from '../../tools/launcher/global-external-programs.mjs';
import { SourceRegistry } from '../../tools/launcher/source-registry.mjs';
import { readSourceIndex, fetchSourceArtifact, publishArtifact } from '../../scripts/runtime/sources.mjs';
import { ordinaryPath, privateJson, readBounded } from '../../scripts/runtime/paths.mjs';
import { configurationRevision } from '../../tools/launcher/program-configuration.mjs';
import { ManagementCommunity } from './management-community.mjs';

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const groupsWithProfiles = (groups, state) => groups.map(group => ({ ...group,
  activeProfiles: (state?.profiles ?? []).filter(profile => state.active.includes(profile.profileId) && profile.groupId === group.id)
    .map(profile => ({ profileId: profile.profileId, id: profile.manifest.id, title: profile.manifest.title, version: profile.manifest.version, ownsGroup: profile.ownsGroup === true })) }));

export class ManagementModules {
  constructor({ hub, config, root = null }) {
    this.hub = hub;
    this.config = config;
    const defaultRoot = config.management?.explicitStateFile
      ? join(dirname(config.management.stateFile), 'launcher')
      : defaultLauncherRoot();
    this.root = resolve(root ?? config.management?.launcherRoot ?? defaultRoot);
    this.layoutFile = join(this.root, 'canvas-layout.json');
    this.layout = { version: 1, nodes: {}, modes: {} };
    this.dissolvedGroupsFile = join(this.root, 'dissolved-groups.json');
    this.dissolvedGroups = new Map();
    this.localPrograms = null;
    this.moduleGroups = null;
    this.pathsService = null;
    this.externalPrograms = null;
    this.sourceRegistry = null;
    this.community = new ManagementCommunity(this);
    this.versions = null;
    this.uninstall = null;
    this.wiringDefaults = null;
    this.demandLifecycle = null;
    this.resources = null;
  }

  async updateCredentials(change) {
    const credentials = { ...this.config.acl.credentials, ...change.credentials };
    for (const id of change.remove ?? []) delete credentials[id];
    // Disconnect updated principals if permissions changed
    for (const id of [...Object.keys(change.credentials ?? {}), ...(change.remove ?? [])]) {
      if (this.config.acl.credentials[id] && JSON.stringify(this.config.acl.credentials[id]) !== JSON.stringify(credentials[id])) {
        this.hub.disconnectPrincipal(id, 'owner changed credentials');
      }
    }
    this.config.acl.credentials = credentials;
    return { confirmed: true, persisted: true };
  }

  async initialize() {
    await ordinaryPath(this.root, { allowMissing: true });
    await mkdir(this.root, { recursive: true, mode: 0o700 });

    const environment = {
      nodePath: process.execPath,
      pythonPath: process.platform === 'win32' ? 'python.exe' : 'python3'
    };

    const host = this.config.transport.host || '127.0.0.1';
    const port = this.config.transport.port || 51780;
    const path = this.config.transport.path || '/bridge';

    this.localPrograms = new LocalPrograms({
      root: this.root,
      environment,
      inspectDeployment,
      prepareDependencies,
      getHub: async () => this.connection(),
      updateCredentials: async (change) => this.updateCredentials(change)
    });

    await this.localPrograms.initialize();
    this.moduleGroups = new ModuleGroups({ localPrograms: this.localPrograms });
    this.versions = new ModuleVersions(this);
    await this.versions.initialize();
    this.uninstall = new ModuleUninstall(this);
    this.wiringDefaults = new WiringDefaults(this);
    this.demandLifecycle = new DemandLifecycle(this);
    this.pathsService = new PathsService(this.root);
    await this.pathsService.initialize();
    this.sourceRegistry = new SourceRegistry(this.root);
    await this.sourceRegistry.initialize();
    this.resources = new ModuleResources(this);
    await this.resources.initialize(); this.resourcesInitialized = true;

    this.hubHandle = {
      url: `http://${host}:${port}/`,
      launcherRunId: this.hub.runId || 'world-hub-run',
      exit: false
    };

    this.externalPrograms = new GlobalExternalPrograms({
      getHub: () => this.hubHandle,
      updateCredentials: async (change, options) => this.updateCredentials(change, options),
      managedPrincipals: () => new Set([...this.localPrograms.records.values()].map(row => row.principal)),
      isStopping: () => false
    });

    // Load saved canvas layout
    try {
      const data = JSON.parse(await readFile(this.layoutFile, 'utf8'));
      if (data && typeof data === 'object' && typeof data.nodes === 'object') {
        this.layout = {
          version: 1,
          nodes: data.nodes || {},
          modes: data.modes || {},
          updatedAt: data.updatedAt || new Date().toISOString()
        };
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // Fall back to blank layout on parse errors
        this.layout = { version: 1, nodes: {}, modes: {} };
      }
    }

    try {
      const dissolvedData = JSON.parse(await readFile(this.dissolvedGroupsFile, 'utf8'));
      if (Array.isArray(dissolvedData)) {
        for (const item of dissolvedData) {
          if (item?.id) this.dissolvedGroups.set(item.id, item);
        }
      }
    } catch {
      // Missing or corrupt file is safely ignored
    }
  }

  async saveDissolvedGroups() {
    try {
      await writeFile(this.dissolvedGroupsFile, JSON.stringify([...this.dissolvedGroups.values()], null, 2), 'utf8');
    } catch (e) {
      console.warn('Failed to save dissolved-groups.json:', e);
    }
  }

  connection() {
    const configured = this.config.transport.host;
    const host = configured === '::' || configured === '::1' ? '[::1]' : !configured || configured === '0.0.0.0' ? '127.0.0.1' : configured;
    const port = this.listeningPort ?? this.config.transport.port;
    return { url: `http://${host}:${port}/`, endpoint: `ws://${host}:${port}${this.config.transport.path || '/bridge'}` };
  }

  setListeningPort(port) {
    this.listeningPort = port; Object.assign(this.hubHandle, this.connection());
    if (this.demandLifecycle?.enabled()) void this.demandLifecycle.connect().catch(() => {});
  }

  async close() { await this.demandLifecycle?.close(); await this.localPrograms.close(); }

  async saveLayout(newLayout) {
    if (!newLayout || typeof newLayout !== 'object' || typeof newLayout.nodes !== 'object') {
      throw fail(400, 'LAYOUT_INVALID', '画布排版数据格式无效');
    }
    const sanitizedNodes = {};
    for (const [id, pos] of Object.entries(newLayout.nodes)) {
      if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
        sanitizedNodes[id] = { x: Math.round(pos.x), y: Math.round(pos.y) };
      }
    }
    const sanitizedModes = {};
    if (newLayout.modes && typeof newLayout.modes === 'object') {
      for (const [modeKey, modeNodes] of Object.entries(newLayout.modes)) {
        if (modeNodes && typeof modeNodes === 'object') {
          sanitizedModes[modeKey] = {};
          for (const [id, pos] of Object.entries(modeNodes)) {
            if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
              sanitizedModes[modeKey][id] = { x: Math.round(pos.x), y: Math.round(pos.y) };
            }
          }
        }
      }
    }
    this.layout = {
      version: 1,
      nodes: sanitizedNodes,
      modes: sanitizedModes,
      updatedAt: new Date().toISOString()
    };
    const tempFile = `${this.layoutFile}.${randomUUID()}.tmp`;
    await writeFile(tempFile, JSON.stringify(this.layout, null, 2), 'utf8');
    await rename(tempFile, this.layoutFile);
    return this.layout;
  }

  getWiringOverview() {
    const programs = [...this.localPrograms.records.values()];
    const wires = [];
    const topicProviders = new Map(); // topicName -> array of { programId, slot, direction: 'publish' }
    const topicConsumers = new Map(); // topicName -> array of { programId, slot, direction: 'subscribe' }

    for (const prog of programs) {
      const topics = prog.topics ?? {};
      const bridges = prog.bridges ?? {};
      for (const [slot, perms] of Object.entries(bridges)) {
        for (const pubAlias of perms.publish ?? []) {
          const concreteTopic = topics[pubAlias];
          if (concreteTopic) {
            if (!topicProviders.has(concreteTopic)) topicProviders.set(concreteTopic, []);
            topicProviders.get(concreteTopic).push({ programId: prog.programId, slot, alias: pubAlias, topic: concreteTopic });
          }
        }
        for (const subAlias of perms.subscribe ?? []) {
          const concreteTopic = topics[subAlias];
          if (concreteTopic) {
            if (!topicConsumers.has(concreteTopic)) topicConsumers.set(concreteTopic, []);
            topicConsumers.get(concreteTopic).push({ programId: prog.programId, slot, alias: subAlias, topic: concreteTopic });
          }
        }
      }
    }

    for (const [topic, providers] of topicProviders.entries()) {
      const consumers = topicConsumers.get(topic) ?? [];
      for (const prov of providers) {
        for (const cons of consumers) {
          if (prov.programId !== cons.programId) {
            wires.push({
              topic,
              from: { programId: prov.programId, slot: prov.slot, alias: prov.alias },
              to: { programId: cons.programId, slot: cons.slot, alias: cons.alias }
            });
          }
        }
      }
    }

    return { wires, topicProviders: Object.fromEntries(topicProviders), topicConsumers: Object.fromEntries(topicConsumers) };
  }

  async startProgram(id, options = {}) {
    let reviewId = options.reviewId;
    if (!reviewId) {
      const review = await this.localPrograms.reviewStart(id);
      reviewId = review.reviewId;
    }
    return this.localPrograms.start(id, { reviewId, accepted: true, ...options, startReason: 'manual' });
  }

  async stopProgram(id) {
    return this.localPrograms.stop(id);
  }

  async startGroup(groupId, options = {}) {
    const group = this.moduleGroups.row(groupId);
    if (options.reviewId) {
      const saved = this.localPrograms.reviewed(options.reviewId, 'startup-plan');
      if (saved.review.groupId !== groupId || saved.review.groupRevision !== group.revision) throw fail(409, 'GROUP_REVIEW_TARGET_MISMATCH', 'Use the current startup review for this exact local group.');
    }
    if (this.startupExecution?.active) throw fail(409, 'STARTUP_ACTIVE', '请等待当前启动计划结束');
    this.startupExecution = { active: true, currentProgramId: null, results: [] };
    try {
      const reviewed = options.reviewId ? { reviewId: options.reviewId }
        : await this.moduleGroups.reviewStart({ groupId, expectedRevision: group.revision });
      const result = await this.moduleGroups.applyStart({ reviewId: reviewed.reviewId, accepted: true,
        progress: progress => { this.startupExecution = { ...progress, active: true,
          currentProgramId: progress.results.find(member => member.state === 'starting')?.programId ?? null }; } });
      return { ...result, groupId, results: result.results.map(member => ({ ...member, ok: ['started', 'running', 'already-running'].includes(member.state) })) };
    } finally { this.startupExecution.active = false; this.startupExecution.currentProgramId = null; }
  }

  async stopGroup(groupId) {
    const group = this.moduleGroups.row(groupId);
    const members = group.memberProgramIds ?? [];
    const results = [];
    for (const id of members) {
      try {
        const res = await this.stopProgram(id);
        results.push({ programId: id, ok: true, res });
      } catch (err) {
        results.push({ programId: id, ok: false, error: err.message });
      }
    }
    return { groupId, results };
  }

  async startStartupPlan(input = {}) {
    let reviewId = input.reviewId;
    if (!reviewId) {
      const review = await this.localPrograms.reviewStartupPlan(input.planData ? { planData: input.planData } : undefined);
      reviewId = review.reviewId;
    }
    this.startupExecution = {
      active: true,
      currentProgramId: null,
      results: [],
      order: []
    };
    const progress = (info) => {
      const currentStarting = info?.results?.find(r => r.state === 'starting');
      this.startupExecution = {
        active: !info?.halted && !info?.cancelled,
        currentProgramId: currentStarting?.programId || null,
        results: info?.results || [],
        order: info?.order || [],
        halted: info?.halted || false,
        cancelled: info?.cancelled || false
      };
    };
    try {
      const result = await this.localPrograms.startStartupPlan({ ...input, reviewId, accepted: true, progress });
      this.startupExecution = {
        active: false,
        currentProgramId: null,
        results: result?.results || [],
        order: result?.order || [],
        halted: result?.halted || false,
        cancelled: result?.cancelled || false
      };
      return result;
    } catch (err) {
      this.startupExecution = {
        active: false,
        currentProgramId: null,
        results: this.startupExecution?.results || [],
        error: err.message
      };
      throw err;
    } finally {
      if (this.startupExecution?.active) {
        this.startupExecution.active = false;
        this.startupExecution.currentProgramId = null;
      }
    }
  }

  async handle(req, res, url, body) {
    const pathname = url.pathname;
    const method = req.method;

    const json = (status, data) => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      });
      res.end(JSON.stringify(data));
      return true;
    };

    if (pathname === '/manage/api/resources' || pathname.startsWith('/manage/api/resources/')) {
      this.resources ??= new ModuleResources(this);
      if (!this.resourcesInitialized) { await this.resources.initialize(); this.resourcesInitialized = true; }
      return json(200, await this.resources.dispatch(method, pathname.slice('/manage/api/resources'.length).replace(/^\//, ''), body ?? {}));
    }

    // 1. Programs Overview
    if (method === 'GET' && pathname === '/manage/api/programs') {
      const programs = await this.localPrograms.programs();
      const planOverview = await this.localPrograms.startupPlanOverview();
      const groupsList = await this.moduleGroups.list();
      const wiring = this.getWiringOverview();
      return json(200, {
        programs,
        startupPlan: planOverview.plan,
        groups: groupsWithProfiles(groupsList.groups, this.localPrograms.resourceState),
        dissolvedGroups: [...this.dissolvedGroups.values()],
        wiring,
        layout: this.layout
      });
    }

    if (method === 'GET' && pathname === '/manage/api/execution/status') {
      if (this.demandLifecycle.enabled()) await this.demandLifecycle.connect().catch(() => {});
      return json(200, this.demandLifecycle.state());
    }
    const executionPolicyMatch = pathname.match(/^\/manage\/api\/programs\/([a-z0-9][a-z0-9._-]{0,63})\/execution-policy$/);
    if (executionPolicyMatch) {
      if (method !== 'POST') throw fail(405, 'METHOD_NOT_ALLOWED', 'Save the local execution policy with its current revision.');
      const result = await this.localPrograms.saveExecutionPolicy(executionPolicyMatch[1], body ?? {});
      if (this.demandLifecycle.enabled()) await this.demandLifecycle.connect().catch(() => {});
      return json(200, { ...result, lifecycle: this.demandLifecycle.state() });
    }

    // 2. Startup Plan
    if (method === 'GET' && (pathname === '/manage/api/programs/startup-plan/status' || pathname === '/manage/api/programs/startup-plan/progress')) {
      return json(200, { ok: true, status: this.startupExecution || { active: false, currentProgramId: null, results: [] } });
    }
    if (method === 'GET' && pathname === '/manage/api/programs/startup-plan') {
      const result = await this.localPrograms.startupPlanOverview();
      return json(200, result);
    }
    if (method === 'POST' && pathname === '/manage/api/programs/startup-plan/save') {
      const result = await this.localPrograms.saveStartupPlan(body);
      return json(200, result);
    }
    if (method === 'POST' && pathname === '/manage/api/programs/startup-plan/review') {
      const result = await this.localPrograms.reviewStartupPlan();
      return json(200, result);
    }
    if (method === 'POST' && pathname === '/manage/api/programs/startup-plan/start') {
      const result = await this.startStartupPlan(body ?? {});
      return json(202, { ok: true, result });
    }

    // 3. Program Registration & Inspection
    if (method === 'POST' && pathname === '/manage/api/programs/inspect') {
      const result = await this.localPrograms.inspect(body.directory, body);
      return json(200, result);
    }
    if (method === 'POST' && pathname === '/manage/api/programs/preview') {
      const result = await this.localPrograms.preview(body);
      return json(200, result);
    }
    if (method === 'POST' && pathname === '/manage/api/programs/register') {
      const result = await this.localPrograms.register(body);
      return json(200, result);
    }

    // 4. Program Lifecycle Actions
    const programActionMatch = pathname.match(/^\/manage\/api\/programs\/([a-z0-9][a-z0-9._-]{0,63})\/(start|stop|logs|remove|review)$/);
    if (programActionMatch && programActionMatch[1] !== 'startup-plan') {
      const [, id, action] = programActionMatch;
      if (action === 'logs' && method === 'GET') {
        const logs = await this.localPrograms.logs(id);
        return json(200, { logs });
      }
      if (action === 'start' && method === 'POST') {
        const result = await this.startProgram(id, body ?? {});
        return json(200, { ok: true, ...result });
      }
      if (action === 'stop' && method === 'POST') {
        const result = await this.stopProgram(id);
        return json(200, { ok: true, ...result });
      }
      if (action === 'review' && method === 'POST') {
        const review = await this.localPrograms.reviewStart(id);
        return json(200, review);
      }
      if (action === 'remove' && method === 'POST') {
        const result = await this.localPrograms.remove(id);
        return json(200, result);
      }
    }

    const wiringDefaultsMatch = pathname.match(/^\/manage\/api\/wiring\/defaults\/(preview|apply)$/);
    if (wiringDefaultsMatch) {
      if (method !== 'POST') throw fail(405, 'METHOD_NOT_ALLOWED', 'Review and confirm the default wiring before restoring it.');
      const result = wiringDefaultsMatch[1] === 'preview' ? await this.wiringDefaults.preview(body ?? {})
        : await this.wiringDefaults.apply(body ?? {});
      return json(200, result);
    }

    const uninstallMatch = pathname.match(/^\/manage\/api\/uninstall\/(modules|groups)\/([a-z0-9][a-z0-9._-]{0,63})\/(preview|apply)$/);
    if (uninstallMatch) {
      if (method !== 'POST') throw fail(405, 'METHOD_NOT_ALLOWED', 'Review and confirm an uninstall action.');
      const [, collection, id, action] = uninstallMatch;
      const kind = collection === 'modules' ? 'module' : 'module-group';
      const result = action === 'preview' ? await this.uninstall.preview(kind, id, body ?? {})
        : await this.uninstall.apply(kind, id, body ?? {});
      return json(200, result);
    }

    // Version changes affect independent deployments, never Hub routing rules.
    const versionMatch = pathname.match(/^\/manage\/api\/versions\/(modules|groups)\/([a-z0-9][a-z0-9._-]{0,63})(?:\/(preview|rollback-preview|apply|recover))?$/);
    if (versionMatch) {
      const [, collection, id, action] = versionMatch;
      const kind = collection === 'modules' ? 'module' : 'module-group';
      if (method === 'GET' && !action) return json(200, await this.versions.overview(kind, id));
      if (method === 'POST') {
        if (action === 'preview') return json(200, await this.versions.preview(kind, id, body ?? {}));
        if (action === 'rollback-preview') return json(200, await this.versions.rollbackPreview(kind, id, body ?? {}));
        if (action === 'apply') return json(200, await this.versions.apply(kind, id, body ?? {}));
        if (action === 'recover') {
          if (body?.accepted !== true) throw fail(409, 'TRUST_REQUIRED', 'Review the interrupted version transaction before restoring it.');
          return json(200, await this.versions.recover(kind, id, body ?? {}));
        }
      }
      throw fail(405, 'METHOD_NOT_ALLOWED', 'Use the version overview or a reviewed version action.');
    }

    // 5. Program Configuration
    const configMatch = pathname.match(/^\/manage\/api\/programs\/([a-z0-9][a-z0-9._-]{0,63})\/configuration\/(preview|apply)$/);
    if (configMatch && method === 'POST' && configMatch[1] !== 'startup-plan') {
      const [, id, action] = configMatch;
      if (body?.directory !== undefined) throw fail(409, 'VERSION_REVIEW_REQUIRED', 'Use version management to change module source so the reviewed update and rollback history are retained.');
      if (action === 'preview') {
        const result = await this.localPrograms.configurationPreview(id, body ?? {});
        return json(200, result);
      }
      if (action === 'apply') {
        let reviewId = body?.reviewId;
        if (!reviewId) {
          const row = this.localPrograms.records.get(id);
          const expectedRevision = row ? configurationRevision(row) : body?.expectedRevision;
          const preview = await this.localPrograms.configurationPreview(id, { ...body, expectedRevision });
          reviewId = preview.reviewId;
        }
        const result = await this.localPrograms.configurationApply(id, { reviewId, accepted: true });
        return json(200, result);
      }
    }

    // 6. Module Groups
    if (method === 'GET' && pathname === '/manage/api/groups') {
      const result = await this.moduleGroups.list();
      return json(200, {
        ...result,
        groups: groupsWithProfiles(result.groups, this.localPrograms.resourceState),
        dissolvedGroups: [...this.dissolvedGroups.values()]
      });
    }
    if (method === 'POST' && pathname === '/manage/api/groups/save') {
      let input = body;
      if (body?.group && typeof body.group === 'object' && !Array.isArray(body.group)) {
        // Snapshot metadata is derived from resources, never authored by a
        // group editor. Round-tripping a public group cannot forge association.
        const { activeProfiles: ignoredActiveProfiles, ...group } = body.group;
        input = { ...body, group };
      }
      const result = await this.moduleGroups.save(input);
      if (body?.group?.id && this.dissolvedGroups.has(body.group.id)) {
        this.dissolvedGroups.delete(body.group.id);
        await this.saveDissolvedGroups();
      }
      return json(200, result);
    }
    const groupReviewMatch = pathname.match(/^\/manage\/api\/groups\/([a-z0-9][a-z0-9._-]{0,63})\/(review|stop-preview|stop-apply)$/);
    if (groupReviewMatch) {
      if (method !== 'POST') throw fail(405, 'METHOD_NOT_ALLOWED', 'Review and explicitly accept the selected local group operation.');
      const [, groupId, action] = groupReviewMatch;
      if (action === 'review') return json(200, await this.moduleGroups.reviewStart({ groupId, expectedRevision: body?.expectedRevision }));
      if (action === 'stop-preview') return json(200, await this.moduleGroups.stopPreview({ groupId, expectedRevision: body?.expectedRevision }));
      const saved = this.localPrograms.reviewed(body?.reviewId, 'group-stop');
      if (saved.review.groupId !== groupId) throw fail(409, 'GROUP_REVIEW_TARGET_MISMATCH', 'Use the stop review for this exact local group.');
      return json(200, await this.moduleGroups.applyStop(body ?? {}));
    }
    const groupActionMatch = pathname.match(/^\/manage\/api\/groups\/([a-z0-9][a-z0-9._-]{0,63})\/(remove|start|stop|restore|discard)$/);
    if (groupActionMatch && method === 'POST') {
      const [, id, action] = groupActionMatch;
      if (action === 'remove') {
        let existingGroup = null;
        try {
          existingGroup = this.moduleGroups.row(id);
        } catch {}
        const result = await this.moduleGroups.remove({ groupId: id, expectedRevision: body?.expectedRevision });
        if (existingGroup) {
          this.dissolvedGroups.set(id, {
            ...existingGroup,
            dissolvedAt: new Date().toISOString()
          });
          await this.saveDissolvedGroups();
        }
        return json(200, { ...result, dissolved: true });
      }
      if (action === 'restore') {
        const dissolved = this.dissolvedGroups.get(id);
        if (!dissolved) {
          throw fail(404, 'DISSOLVED_GROUP_NOT_FOUND', '未找到已解散的分组记录');
        }
        const hadMembers = (dissolved.memberProgramIds || []).length > 0;
        const existingMembers = (dissolved.memberProgramIds || []).filter(progId => this.localPrograms.records.has(progId));
        if (hadMembers && existingMembers.length === 0) {
          throw fail(400, 'NO_MEMBERS_AVAILABLE', '原分组中的模块均已不存在，无法恢复此分组。');
        }
        const { dissolvedAt, revision, ...groupData } = dissolved;
        let startupPlan = undefined;
        if (groupData.startupPlan) {
          const keptMembers = (groupData.startupPlan.members || []).filter(m => existingMembers.includes(m.programId)).map(m => ({
            ...m,
            after: (m.after || []).filter(a => existingMembers.includes(a))
          }));
          startupPlan = {
            ...groupData.startupPlan,
            members: keptMembers,
            ...(Object.hasOwn(groupData.startupPlan, 'startupOrder') ? { startupOrder: groupData.startupPlan.startupOrder.filter(mid => existingMembers.includes(mid)) } : {})
          };
        }
        let origin = undefined;
        if (groupData.origin && typeof groupData.origin === 'object') {
          const keptMembers = Object.fromEntries(
            Object.entries(groupData.origin.members || {}).filter(([, instId]) => existingMembers.includes(instId))
          );
          origin = {
            ...groupData.origin,
            members: keptMembers
          };
        }
        let wiringBaseline = undefined;
        if (groupData.wiringBaseline && origin) {
          const keptBaselineMembers = (groupData.wiringBaseline.members || []).filter(m => Object.hasOwn(origin.members, m.id));
          wiringBaseline = {
            ...groupData.wiringBaseline,
            members: keptBaselineMembers
          };
        }
        const groupToRestore = {
          format: groupData.format,
          id: groupData.id,
          title: groupData.title,
          memberProgramIds: existingMembers,
          ...(startupPlan ? { startupPlan } : {}),
          ...(origin ? { origin } : {}),
          ...(wiringBaseline ? { wiringBaseline } : {})
        };
        const group = normalizeModuleGroup(groupToRestore, [...this.localPrograms.records.keys()]);
        this.localPrograms.groups.set(group.id, group);
        await this.localPrograms.save();
        this.dissolvedGroups.delete(id);
        await this.saveDissolvedGroups();
        return json(200, { ok: true, restored: true, group });
      }
      if (action === 'discard') {
        this.dissolvedGroups.delete(id);
        await this.saveDissolvedGroups();
        return json(200, { ok: true, discarded: true, id });
      }
      if (action === 'start') {
        const result = await this.startGroup(id, body ?? {});
        return json(200, result);
      }
      if (action === 'stop') {
        const result = await this.stopGroup(id);
        return json(200, result);
      }
    }

    // 7. Canvas Layout Persistence
    if (method === 'GET' && pathname === '/manage/api/layout') {
      return json(200, { layout: this.layout });
    }
    if (method === 'POST' && pathname === '/manage/api/layout') {
      const saved = await this.saveLayout(body.layout ?? body);
      return json(200, { ok: true, layout: saved });
    }

    // 8. Paths & Artifacts
    if (method === 'GET' && pathname === '/manage/api/paths/known') {
      const result = await this.pathsService.known({
        defaults: {},
        localPrograms: this.localPrograms,
        sourceRegistry: { records: [] }
      });
      return json(200, result);
    }
    if (method === 'POST' && pathname === '/manage/api/paths/browse') {
      const result = await this.pathsService.browse(body);
      return json(200, result);
    }
    if (method === 'POST' && pathname === '/manage/api/paths/native-pick') {
      try {
        const result = await this.pathsService.nativePick(body ?? { purpose: 'module' });
        return json(200, result);
      } catch (err) {
        return json(err.status ?? 500, { error: err.code || 'NATIVE_PICK_FAILED', message: err.message });
      }
    }
    if (method === 'POST' && pathname === '/manage/api/environment') {
      try {
        const { detectEnvironment, discoverEnvironment } = await import('../../tools/launcher/environment.mjs');
        const chosen = {
          nodePath: body?.nodePath ?? process.execPath,
          pythonPath: body?.pythonPath ?? 'python'
        };
        const [environment, candidates] = await Promise.all([
          detectEnvironment(chosen),
          discoverEnvironment(chosen)
        ]);
        return json(200, {
          environment,
          candidates,
          guidance: ['Select an installed interpreter and check again. Prepare the supported dependency in a reviewed private venv, or install other dependencies manually in your own private environment.']
        });
      } catch (err) {
        return json(err.status ?? 500, { error: err.code || 'ENV_DETECT_FAILED', message: err.message });
      }
    }
    if (method === 'POST' && pathname === '/manage/api/artifacts/import') {
      const result = await importLocalArtifact({ root: this.root, ...body });
      await this.pathsService.remember({ path: result.object.path, purpose: result.object.kind, library: true });
      return json(200, result);
    }
    if (method === 'POST' && pathname === '/manage/api/artifacts/preview') {
      return json(200, await this.community.preview(body));
    }
    if (method === 'POST' && pathname === '/manage/api/artifacts/apply') {
      return json(200, await this.community.apply(body));
    }
    const exportGroup = pathname.match(/^\/manage\/api\/groups\/([a-z0-9][a-z0-9._-]{0,63})\/export$/);
    if (method === 'POST' && exportGroup) return json(200, await this.community.exportGroup(exportGroup[1], body));

    // 9. External Client Grants & Code Generation
    if (method === 'GET' && pathname === '/manage/api/external') {
      try {
        const result = await this.externalPrograms.inventory();
        return json(200, result);
      } catch (err) {
        return json(err.status ?? 500, { error: err.code || 'EXTERNAL_FAILED', message: err.message });
      }
    }
    if (method === 'POST' && pathname === '/manage/api/external/preview') {
      try {
        const result = await this.externalPrograms.preview(body);
        return json(200, result);
      } catch (err) {
        return json(err.status ?? 500, { error: err.code || 'EXTERNAL_FAILED', message: err.message });
      }
    }
    if (method === 'POST' && pathname === '/manage/api/external/apply') {
      try {
        const result = await this.externalPrograms.apply(body);
        return json(200, result);
      } catch (err) {
        return json(err.status ?? 500, { error: err.code || 'EXTERNAL_FAILED', message: err.message });
      }
    }
    if (method === 'POST' && pathname === '/manage/api/external/quick-grant') {
      try {
        const programId = body?.programId?.trim();
        if (!programId) throw new Error('需要指定客户端标识 (programId)');
        const publish = Array.isArray(body?.publish) ? body.publish : (body?.publish ? String(body.publish).split(/[\n,]/).map(s => s.trim()).filter(Boolean) : []);
        const subscribe = Array.isArray(body?.subscribe) ? body.subscribe : (body?.subscribe ? String(body.subscribe).split(/[\n,]/).map(s => s.trim()).filter(Boolean) : []);
        const inv = await this.externalPrograms.inventory();
        const preview = await this.externalPrograms.preview({
          action: 'admit',
          expectedRunId: inv.runId,
          expectedRevision: inv.revision,
          programId,
          title: body?.title || programId,
          bridges: [{ slot: 'main', publish, subscribe }],
          provides: [],
          requires: [],
          bindings: []
        });
        const applied = await this.externalPrograms.apply({
          reviewId: preview.reviewId,
          accepted: true
        });
        const conn = applied.connection;
        const host = this.config.transport.host || '127.0.0.1';
        const port = this.config.transport.port || 51780;
        const path = this.config.transport.path || '/bridge';
        const endpoint = conn?.endpoint || `ws://${host}:${port}${path}`;
        const token = conn?.bridges?.[0]?.token || '';
        const principal = conn?.principal || `external.${programId}`;

        const pythonSnippet = `import asyncio, json, websockets

async def connect_to_hub():
    uri = "${endpoint}"
    async with websockets.connect(uri) as ws:
        # 发送身份握手
        await ws.send(json.dumps({
            "command": "hello",
            "principal": "${principal}",
            "token": "${token}"
        }))
        print("✓ 已成功连接到世界枢纽!")

        # 接收消息循环
        async for msg in ws:
            print("收到消息:", msg)

asyncio.run(connect_to_hub())`;

        const nodeSnippet = `import { WebSocket } from 'ws';

const ws = new WebSocket("${endpoint}");
ws.on('open', () => {
  ws.send(JSON.stringify({
    command: 'hello',
    principal: "${principal}",
    token: "${token}"
  }));
  console.log('✓ 已成功连接到世界枢纽!');
});

ws.on('message', (data) => {
  console.log('收到消息:', data.toString());
});`;

        return json(200, {
          ok: true,
          connection: conn,
          snippets: {
            python: pythonSnippet,
            node: nodeSnippet
          }
        });
      } catch (err) {
        return json(err.status ?? 500, { error: err.code || 'EXTERNAL_FAILED', message: err.message });
      }
    }
    if (method === 'POST' && pathname === '/manage/api/external/quick-revoke') {
      try {
        const programId = body?.programId?.trim();
        const inv = await this.externalPrograms.inventory();
        const preview = await this.externalPrograms.preview({
          action: 'revoke',
          expectedRunId: inv.runId,
          expectedRevision: inv.revision,
          programId
        });
        const applied = await this.externalPrograms.apply({
          reviewId: preview.reviewId,
          accepted: true
        });
        return json(200, applied);
      } catch (err) {
        return json(err.status ?? 500, { error: err.code || 'EXTERNAL_FAILED', message: err.message });
      }
    }

    // 10. Creator Tools: Scaffold New Module
    if (method === 'POST' && pathname === '/manage/api/creator/scaffold') {
      try {
        const id = body?.id?.trim();
        if (!id || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
          throw fail(400, 'CREATOR_ID_INVALID', '模块标识必须为 1~64 位小写字母、数字及下划线短横线');
        }
        const title = body?.title?.trim() || id;
        const description = body?.description?.trim() || '基于 World Hub 的独立语义微服务';
        const runtime = body?.runtime === 'python' ? 'python' : 'node';
        const entryFile = body?.entry?.trim() || (runtime === 'python' ? 'main.py' : 'index.mjs');
        const executionDefaults = validateExecutionDefaults(Object.hasOwn(body ?? {}, 'executionDefaults') ? body.executionDefaults : { mode: 'resident' });
        const rawDir = body?.directory?.trim() || join(this.root, 'local-programs', id, 'module');
        const dir = await ordinaryPath(resolve(rawDir), { allowMissing: true });

        await mkdir(dir, { recursive: true, mode: 0o700 });

        const pubList = Array.isArray(body?.publish) ? body.publish : (body?.publish ? String(body.publish).split(/[\n,]/).map(s => s.trim()).filter(Boolean) : [`${id}/data`]);
        const subList = Array.isArray(body?.subscribe) ? body.subscribe : (body?.subscribe ? String(body.subscribe).split(/[\n,]/).map(s => s.trim()).filter(Boolean) : ['system/alert']);

        // Build valid module.json
        const moduleJson = {
          format: 'world-hub.module/v1',
          id,
          version: '1.0.0',
          license: 'Apache-2.0',
          platforms: ['win32-x64', 'linux-x64', 'darwin-arm64'],
          runtime: {
            kind: runtime,
            entry: entryFile
          },
          bridges: ['main'],
          provides: [],
          requires: [],
          permissions: {
            filesystem: 'instance-state',
            network: ['hub-loopback'],
            processes: runtime === 'node' ? 'owned-children' : 'none'
          }
        };

        const topicMap = {};
        const pubAliases = [];
        pubList.forEach((t, i) => {
          const alias = `pub_${i + 1}`;
          topicMap[alias] = t;
          pubAliases.push(alias);
        });

        const subAliases = [];
        subList.forEach((t, i) => {
          const alias = `sub_${i + 1}`;
          topicMap[alias] = t;
          subAliases.push(alias);
        });

        if (Object.keys(topicMap).length === 0) {
          topicMap['default_event'] = `${id}/event`;
          pubAliases.push('default_event');
        }

        // Build valid deployment.json
        const deploymentJson = {
          format: 'world-hub.deployment/v1',
          title: { zh: title, en: id },
          description: { zh: description, en: description },
          executionDefaults,
          topics: topicMap,
          bridges: {
            main: {
              publish: pubAliases,
              subscribe: subAliases
            }
          },
          settings: [
            {
              key: 'interval',
              type: 'number',
              label: { zh: '上报频率 (秒)', en: 'Interval (seconds)' },
              default: 5,
              min: 1,
              max: 60
            }
          ]
        };

        await privateJson(join(dir, 'module.json'), moduleJson);
        await privateJson(join(dir, 'deployment.json'), deploymentJson);
        for (const file of ['LICENSE', 'NOTICE']) {
          await writeFile(join(dir, file), await readBounded(join(repository, file)), { mode: 0o600 });
        }

        // Generate boilerplate entry file
        let starterCode = '';
        if (runtime === 'python') {
          starterCode = `import sys
import json
import asyncio
import websockets

config_path = None
for i in range(len(sys.argv) - 1):
    if sys.argv[i] == "--runtime-config":
        config_path = sys.argv[i + 1]
        break

if not config_path:
    print("缺少 --runtime-config 参数", file=sys.stderr)
    sys.exit(1)

with open(config_path, "r", encoding="utf-8") as f:
    config = json.load(f)

bridge = config["bridges"][0]
endpoint = bridge["endpoint"]
principal = bridge["principal"]
token = bridge["token"]

async def main():
    async with websockets.connect(endpoint) as ws:
        await ws.send(json.dumps({
            "command": "hello",
            "principal": principal,
            "token": token
        }))
        print(json.dumps({"event": "module-ready"}), flush=True)

        async for raw in ws:
            try:
                msg = json.loads(raw)
            except Exception:
                continue

            if msg.get("command") == "health":
                print(json.dumps({"event": "module-health", "id": msg.get("id"), "ready": True}), flush=True)

if __name__ == "__main__":
    asyncio.run(main())
`;
        } else {
          starterCode = `import { readFile } from 'node:fs/promises';
import { WebSocket } from 'ws';

const configIndex = process.argv.indexOf('--runtime-config');
if (configIndex === -1 || !process.argv[configIndex + 1]) {
  console.error('缺少 --runtime-config 参数');
  process.exit(1);
}

const config = JSON.parse(await readFile(process.argv[configIndex + 1], 'utf8'));
const bridge = config.bridges[0];
const ws = new WebSocket(bridge.endpoint);

ws.on('open', () => {
  ws.send(JSON.stringify({
    command: 'hello',
    principal: bridge.principal,
    token: bridge.token
  }));
  console.log(JSON.stringify({ event: 'module-ready' }));
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    if (msg.command === 'health') {
      console.log(JSON.stringify({ event: 'module-health', id: msg.id, ready: true }));
    }
  } catch {}
});

process.on('message', (msg) => {
  if (msg?.command === 'health') {
    process.send?.({ event: 'module-health', id: msg.id, ready: true });
  }
});
`;
        }

        await writeFile(join(dir, entryFile), starterCode, 'utf8');

        // Remember path
        await this.pathsService.remember({ path: dir, purpose: 'module', library: true });

        // Auto inspect and register
        const inspected = await this.localPrograms.inspect(dir);
        const preview = await this.localPrograms.preview({ programId: id, directory: dir });
        const registered = await this.localPrograms.register({ reviewId: preview.reviewId, accepted: true });

        return json(200, { ok: true, programId: id, directory: dir, registered });
      } catch (err) {
        return json(err.status ?? (err.code === 'DEPLOYMENT_INVALID' ? 400 : 500), { error: err.code || 'CREATOR_FAILED', message: err.message });
      }
    }

    // 11. Creator Tools: Package Module Artifact
    if (method === 'POST' && pathname === '/manage/api/creator/package') {
      try {
        const directory = body?.directory?.trim();
        const destination = body?.destination?.trim();
        if (!directory || !destination) {
          throw fail(400, 'PACKAGE_INPUT', '需要指定源模块目录与打包输出目录');
        }
        if (body.redistributionAcknowledged !== true) throw fail(400, 'REDISTRIBUTION_REQUIRED', '请确认有权再分发模块或模块组中的全部源码');
        const object = await importLocalArtifact({ root: this.root, path: directory });
        const result = await publishArtifact(directory, {
          kind: object.object.kind,
          destination,
          redistributionAcknowledged: true,
          nodePath: process.execPath,
          pythonPath: process.platform === 'win32' ? 'python.exe' : 'python3'
        });
        return json(200, { ok: true, ...result });
      } catch (err) {
        return json(err.status ?? 500, { error: err.code || 'PACKAGE_FAILED', message: err.message });
      }
    }

    // 12. Workshop Sources & Inspect
    if (method === 'GET' && pathname === '/manage/api/workshop/sources') {
      try {
        let records = this.sourceRegistry.records;
        if (!records || !records.length) {
          records = [{
            id: 'official-workshop',
            name: 'World Hub 官方社区工坊',
            source: 'https://peros.cn/workshop/index.json',
            enabled: true,
            priority: 100,
            allowPrivateNetwork: false,
            revision: 1
          }];
        }
        return json(200, { ok: true, sources: records });
      } catch (err) {
        return json(err.status ?? 500, { error: err.code || 'WORKSHOP_FAILED', message: err.message });
      }
    }

    if (method === 'POST' && pathname === '/manage/api/workshop/inspect') {
      try {
        const source = body?.source?.trim() || 'https://peros.cn/workshop/index.json';
        const chosen = await this.sourceRegistry.resolve({ source, ...(body?.allowPrivateNetwork !== undefined ? { allowPrivateNetwork: body.allowPrivateNetwork === true } : {}) });
        const result = await readSourceIndex(chosen.source, chosen);
        await this.sourceRegistry.assertCurrent(chosen);
        const entries = result.index.entries.filter(entry => ['module', 'configuration', 'data'].includes(entry.kind));
        let catalog = null;
        try {
          if (/^https?:\/\//i.test(source)) {
            const catalogUrl = new URL('api/catalog?limit=100', source).href;
            const res = await fetch(catalogUrl, { signal: AbortSignal.timeout(6000) });
            if (res.ok) {
              const data = await res.json();
              if (Array.isArray(data.publications)) catalog = data.publications;
            }
          }
        } catch {}

        const resolveUrl = (asset) => {
          if (!asset || !asset.url) return asset;
          try { return { ...asset, url: new URL(asset.url, source).href }; } catch { return asset; }
        };

        const enrichedEntries = entries.map(entry => {
          if (!catalog) return entry;
          const match = catalog.find(p => p.kind === entry.kind && p.id === entry.id && (p.version === entry.version || p.sha256 === entry.sha256))
            || catalog.find(p => p.kind === entry.kind && p.id === entry.id);
          if (!match) return entry;
          const presentation = match.presentation ? {
            icon: resolveUrl(match.presentation.icon),
            cover: resolveUrl(match.presentation.cover),
            screenshots: Array.isArray(match.presentation.screenshots) ? match.presentation.screenshots.map(resolveUrl) : []
          } : null;
          return {
            ...entry,
            owner: match.owner,
            versionCount: match.versionCount ?? 1,
            commentsCount: match.commentsCount ?? 0,
            proposalsCount: match.proposalsCount ?? 0,
            presentation
          };
        });

        let cachedSha256s = [];
        try {
          const cache = join(this.root, 'source-cache');
          const cacheFiles = await readdir(cache);
          cachedSha256s = cacheFiles
            .filter(name => name.endsWith('.artifact.json'))
            .map(name => name.slice(0, -14));
        } catch {}

        return json(200, {
          ok: true,
          source: result.source,
          index: { ...result.index, entries: enrichedEntries },
          digest: result.digest,
          cachedSha256s
        });
      } catch (err) {
        return json(200, {
          ok: false,
          offline: true,
          error: { code: err.code || 'SOURCE_UNAVAILABLE', message: err.message },
          guidance: /private or unsupported address/.test(err.message)
            ? '来源解析到了私网或代理虚拟地址。仅在你信任该来源与代理时勾选私网选项后重试；也可从社区网页下载 artifact.json 再本地导入。'
            : '来源当前无法读取。请核对网络、索引路径与 HTTPS 服务，或从社区网页下载 artifact.json 再本地导入。'
        });
      }
    }

    if (method === 'GET' && pathname === '/manage/api/workshop/cache') {
      try {
        const cache = join(this.root, 'source-cache');
        await mkdir(cache, { recursive: true, mode: 0o700 });
        const files = await readdir(cache, { withFileTypes: true });
        const artifacts = [];

        const installedModules = new Map();
        const installedGroups = new Map();

        if (this.localPrograms?.records) {
          for (const [, prog] of this.localPrograms.records) {
            const modId = prog.module?.id;
            const modVer = prog.module?.version;
            if (modId) {
              if (!installedModules.has(modId)) installedModules.set(modId, new Set());
              if (modVer) installedModules.get(modId).add(modVer);
            }
          }
        }
        if (this.moduleGroups) {
          const grpList = await this.moduleGroups.list();
          for (const g of grpList.groups || []) {
            const orgId = g.origin?.id || g.id;
            const orgVer = g.origin?.version;
            if (orgId) {
              if (!installedGroups.has(orgId)) installedGroups.set(orgId, new Set());
              if (orgVer) installedGroups.get(orgId).add(orgVer);
            }
          }
        }

        for (const f of files) {
          if (f.isFile() && f.name.endsWith('.artifact.json')) {
            const sha256 = f.name.slice(0, -14);
            try {
              const content = await readFile(join(cache, f.name), 'utf8');
              const parsed = JSON.parse(content);
              const artifactDir = join(cache, sha256);
              let hasDir = false;
              let dirStat = null;
              try {
                dirStat = await stat(artifactDir);
                hasDir = dirStat.isDirectory();
              } catch {}

              const kind = parsed.kind || parsed.artifact?.kind || 'module';
              if (!['module', 'configuration', 'data'].includes(kind)) continue;
              const id = parsed.id || parsed.artifact?.id || '';
              const version = parsed.version || parsed.artifact?.version || '';
              const title = parsed.title || parsed.artifact?.title || id;

              const isInstalled = kind === 'module' ? Boolean(installedModules.get(id)?.has(version))
                : (kind === 'configuration' ? this.resources.state.profiles : this.resources.state.data).some(row => row.manifest.id === id && row.manifest.version === version);

              artifacts.push({
                sha256,
                format: parsed.format,
                kind,
                id,
                version,
                title,
                filesCount: Array.isArray(parsed.files) ? parsed.files.length : (parsed.artifact?.files?.length || 0),
                jsonBytes: Buffer.byteLength(content, 'utf8'),
                directory: artifactDir,
                directoryExists: hasDir,
                cachedAt: dirStat?.mtime?.toISOString?.() || null,
                installed: isInstalled,
                provenance: parsed.provenance || null
              });
            } catch {}
          }
        }

        artifacts.sort((a, b) => (b.cachedAt || '').localeCompare(a.cachedAt || ''));

        return json(200, { ok: true, artifacts, cacheDirectory: cache });
      } catch (err) {
        return json(err.status ?? 500, { error: err.code || 'CACHE_FAILED', message: err.message });
      }
    }

    if (method === 'POST' && pathname === '/manage/api/workshop/cache/delete') {
      try {
        const sha256 = String(body?.sha256 || '').trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(sha256)) throw fail(400, 'SHA256_INVALID', '需要合法的 64 位 SHA-256 校验值');
        const cache = join(this.root, 'source-cache');
        const artifactFile = join(cache, `${sha256}.artifact.json`);
        const artifactDir = join(cache, sha256);
        await rm(artifactFile, { force: true });
        await rm(artifactDir, { recursive: true, force: true });
        return json(200, { ok: true, sha256 });
      } catch (err) {
        return json(err.status ?? 500, { error: err.code || 'DELETE_FAILED', message: err.message });
      }
    }

    if (method === 'POST' && pathname === '/manage/api/workshop/fetch') {
      try {
        const cache = join(this.root, 'source-cache');
        await mkdir(cache, { recursive: true, mode: 0o700 });
        const chosen = await this.sourceRegistry.resolve({ source: body.source, ...(body.allowPrivateNetwork !== undefined ? { allowPrivateNetwork: body.allowPrivateNetwork === true } : {}) });
        const result = await fetchSourceArtifact(chosen.source, body.digest, body.entryId, { ...chosen, cacheRoot: cache });
        await this.sourceRegistry.assertCurrent(chosen);
        await this.pathsService.remember({ path: result.directory, purpose: result.kind, library: true });
        if (!['module', 'configuration', 'data'].includes(result.kind)) throw fail(400, 'RESOURCE_KIND_INVALID', 'Choose a module, configuration or data artifact.');
        const resource = await this.resources.import({ path: result.directory }, result.kind);
        return json(200, { ok: true, ...result, resource });
      } catch (err) {
        return json(err.status ?? 500, { error: err.code || 'FETCH_FAILED', message: err.message });
      }
    }

    return false;
  }
}
