// Pure admission check shared by reviews and execution. No installer or process
// starts when the optional owned-children lifecycle lacks an OS adapter.
export function assertHostedPlatform(manifest, platform = process.platform) {
  if (manifest?.permissions?.processes === 'owned-children' && !['win32', 'linux'].includes(platform))
    throw Object.assign(new Error('Owned child-process deployment requires the supported Windows Job or Linux current-owned-group lifecycle adapter.'), { code: 'HOST_LIFECYCLE_UNSUPPORTED' });
}
