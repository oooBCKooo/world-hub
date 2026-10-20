// Deployment presets select startup behavior; failure handling is an explicit,
// independent author/operator choice. Neither changes the Hub wire protocol.
import { summarizePackLineage } from './pack-lineage.mjs';
export function effectivePackType(pack) { return pack.packType ?? 'atomic'; }
export function effectiveLifecyclePolicy(pack) { return pack.lifecyclePolicy ?? (effectivePackType(pack) === 'mesh' ? 'independent' : 'fail-fast'); }
export function componentAutostarts(pack, component) { return component.autostart !== false; }
export function summarizePack(pack) {
  const lineage = summarizePackLineage(pack);
  return { id: pack.id, version: pack.version, title: pack.title, packType: effectivePackType(pack), lifecyclePolicy: effectiveLifecyclePolicy(pack),
    ...(lineage ? { lineage } : {}),
    ...(Object.hasOwn(pack, 'startupOrder') ? { startupOrder: [...pack.startupOrder] } : {}),
    components: pack.components.map(component => ({ id: component.id, module: component.module, after: [...component.after], autostart: component.autostart ?? true, critical: component.critical ?? false })) };
}
