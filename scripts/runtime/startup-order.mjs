// Exact deployment order is an optional Launcher/Runtime choice, outside the Hub protocol.
const fault = message => Object.assign(new Error(message), { code: 'STARTUP_ORDER_INVALID', status: 409 });

export function resolveStartupOrder(components, startupOrder) {
  const byId = new Map(components.map(component => [component.id, component]));
  if (byId.size !== components.length) throw fault('Startup order requires distinct component IDs.');
  if (startupOrder !== undefined) {
    if (!Array.isArray(startupOrder) || startupOrder.length !== components.length || startupOrder.length > 128
        || new Set(startupOrder).size !== startupOrder.length || startupOrder.some(id => !byId.has(id)))
      throw fault('Startup order must list every installed member exactly once, including manual members.');
    const positions = new Map(startupOrder.map((id, index) => [id, index]));
    for (const component of components) for (const prerequisite of component.after)
      if (!positions.has(prerequisite) || positions.get(prerequisite) >= positions.get(component.id))
        throw fault(`Startup order must place prerequisite ${prerequisite} before ${component.id}. Adjust the order or its explicit prerequisites.`);
    return startupOrder.map(id => byId.get(id));
  }
  const ordered = [], visiting = new Set(), visited = new Set();
  const visit = component => {
    if (!component) throw fault('Startup prerequisites refer to an unknown member.');
    if (visiting.has(component.id)) throw fault('Component dependency cycle');
    if (visited.has(component.id)) return;
    visiting.add(component.id);
    for (const id of component.after) visit(byId.get(id));
    visiting.delete(component.id); visited.add(component.id); ordered.push(component);
  };
  for (const component of components) visit(component);
  return ordered;
}
