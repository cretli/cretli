/**
 * Agent list from .cursor/agents (.md files with frontmatter: name, model, description).
 */

import fs from 'fs';
import path from 'path';
import { getConfiguredAdditionalCursorContextDirs } from './sdk/shared-cursor-context.js';

/**
 * Parses the leading YAML frontmatter (minimal parser for name, model, description).
 * @param {string} raw - file contents
 * @returns {{ name?: string, model?: string, description?: string }}
 */
function parseFrontmatter(raw) {
  const out = {};
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return out;
  const block = match[1];
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^\s*(\w+):\s*(.+)$/);
    if (m) {
      const key = m[1];
      const val = m[2].replace(/^['"]|['"]$/g, '').trim();
      if (key === 'name' || key === 'model' || key === 'description') out[key] = val;
    }
  }
  return out;
}

/**
 * @param {string} rootDir
 * @param {{ pathPrefix?: string, source?: string }} [meta]
 * @returns {Array<{ name: string, model?: string, description?: string, path: string, source?: string }>}
 */
function loadAgentsFromRoot(rootDir, meta = {}) {
  const agentsDir = path.join(rootDir, '.cursor', 'agents');
  if (!fs.existsSync(agentsDir) || !fs.statSync(agentsDir).isDirectory()) {
    return [];
  }
  const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  const agents = [];
  for (const e of entries) {
    if (!e.isFile() || (!e.name.endsWith('.md') && !e.name.endsWith('.mdc'))) continue;
    const fullPath = path.join(agentsDir, e.name);
    let raw;
    try {
      raw = fs.readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }
    const fm = parseFrontmatter(raw);
    const name = fm.name || e.name.replace(/\.(md|mdc)$/, '');
    const relativePath = meta.pathPrefix
      ? `${meta.pathPrefix}/${e.name}`
      : `.cursor/agents/${e.name}`;
    agents.push({
      name,
      model: fm.model || undefined,
      description: fm.description || undefined,
      path: relativePath,
      source: meta.source || 'project',
    });
  }
  return agents;
}

/**
 * Returns agents from the project workspace plus configured shared Cursor roots.
 * @param {string} workspaceDir
 * @returns {{ agents: Array<{ name: string, model?: string, description?: string, path: string, source?: string }> }}
 */
export function loadAgents(workspaceDir) {
  const agents = loadAgentsFromRoot(workspaceDir, { source: 'project' });
  const seen = new Set(agents.map((agent) => agent.name));
  const workspaceResolved = workspaceDir ? path.resolve(workspaceDir) : '';
  for (const sharedRoot of getConfiguredAdditionalCursorContextDirs()) {
    if (sharedRoot === workspaceResolved) continue;
    const sharedAgents = loadAgentsFromRoot(sharedRoot, {
      pathPrefix: path.join(sharedRoot, '.cursor', 'agents').replace(/\\/g, '/'),
      source: `shared:${path.basename(sharedRoot)}`,
    });
    for (const agent of sharedAgents) {
      if (seen.has(agent.name)) continue;
      seen.add(agent.name);
      agents.push(agent);
    }
  }
  return { agents };
}
