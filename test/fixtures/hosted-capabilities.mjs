export function capabilitiesPayload(pluginId, pluginVersion, names) {
  return {
    contract_version: '1',
    plugin_id: pluginId,
    plugin_version: pluginVersion,
    tool_count: names.length,
    tools: names.map((name) => ({ name, status: 'ready' })),
  }
}

export const gemFixtureNames = ['gem_fixture_first', 'gem_fixture_second']
export const graftFixtureNames = ['graft_fixture_first', 'graft_fixture_second']
