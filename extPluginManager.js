// ============================================================
//  TRASHCORE ULTRA — by TrashX
//  extPluginManager.js  |  Optional external plugin system
//  Installs/uninstalls extra plugin commands into existing
//  category files (e.g. plugins/downloads/downloads.js)
// ============================================================

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const http    = require('http');

// ─── Registry of available external plugins ──────────────────
// You can also host this as a remote JSON file
const REGISTRY_PATH = path.join(__dirname, 'extPluginRegistry.json');

// ─── Where installed plugin state is saved ───────────────────
const STATE_PATH = path.join(__dirname, 'database', 'extPlugins.json');

// ─── Markers used to wrap injected code in category files ────
const MARKER_START = (id) => `\n// ──── EXT_PLUGIN_START:${id} ────\n`;
const MARKER_END   = (id) => `\n// ──── EXT_PLUGIN_END:${id} ────\n`;

// ─── Logger ──────────────────────────────────────────────────
function log(msg)  { console.log(`»  \x1b[36m[EXT-PLUG]\x1b[0m ${msg}`); }
function err(msg)  { console.log(`»  \x1b[31m[EXT-PLUG]\x1b[0m ${msg}`); }

// ─── Load/save installed state ───────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    }
  } catch (e) {}
  return {};  // { pluginId: { id, name, category, installedAt } }
}

function saveState(state) {
  const dir = path.dirname(STATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

// ─── Load registry ───────────────────────────────────────────
function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    }
  } catch (e) {}
  return [];
}

function findPluginInRegistry(nameOrId) {
  const registry = loadRegistry();
  const q = nameOrId.toLowerCase();
  return registry.find(p =>
    p.id.toLowerCase() === q ||
    p.name.toLowerCase() === q ||
    (p.aliases || []).some(a => a.toLowerCase() === q)
  );
}

// ─── Download plugin code from URL ───────────────────────────
function downloadText(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));

    const parsed  = new URL(url);
    const client  = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  { 'User-Agent': 'TrashcoreBot/1.0' }
    };

    const req = client.request(options, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        return resolve(downloadText(res.headers.location, redirectCount + 1));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ─── Resolve the actual category file path ───────────────────
// Plugins may be in the hidden deep path OR the visible plugins/ dir
function resolveCategoryFile(category) {
  // Try hidden deep path first (used in production)
  const deepDir = global.__PLUGINS__;
  if (deepDir && fs.existsSync(deepDir)) {
    const deepFile = path.join(deepDir, category, `${category}.js`);
    if (fs.existsSync(deepFile)) return deepFile;
  }

  // Fallback: visible plugins/ folder (dev mode)
  const localFile = path.join(__dirname, 'plugins', category, `${category}.js`);
  if (fs.existsSync(localFile)) return localFile;

  return null;
}

// ─── INSTALL ─────────────────────────────────────────────────
async function installPlugin(nameOrId) {
  const plugin = findPluginInRegistry(nameOrId);
  if (!plugin) {
    return { ok: false, msg: `❌ Plugin *${nameOrId}* not found in registry.\nUse *.plug list* to see available plugins.` };
  }

  const state = loadState();
  if (state[plugin.id]) {
    return { ok: false, msg: `⚠️ Plugin *${plugin.name}* is already installed.` };
  }

  // Download the plugin code
  let code;
  try {
    log(`Downloading plugin: ${plugin.name} from ${plugin.url}`);
    code = await downloadText(plugin.url);
  } catch (e) {
    return { ok: false, msg: `❌ Failed to download plugin: ${e.message}` };
  }

  // Find the target category file
  const categoryFile = resolveCategoryFile(plugin.category);
  if (!categoryFile) {
    return { ok: false, msg: `❌ Category file for *${plugin.category}* not found. Is the bot fully loaded?` };
  }

  // Read the existing file
  let existing;
  try {
    existing = fs.readFileSync(categoryFile, 'utf8');
  } catch (e) {
    return { ok: false, msg: `❌ Could not read category file: ${e.message}` };
  }

  // Safety: check not already injected
  if (existing.includes(`EXT_PLUGIN_START:${plugin.id}`)) {
    return { ok: false, msg: `⚠️ Plugin *${plugin.name}* code already present in file (orphaned state). Run *.plug remove ${plugin.id}* first.` };
  }

  // Append the plugin code with markers
  const injection = MARKER_START(plugin.id) + code.trim() + MARKER_END(plugin.id);
  try {
    fs.appendFileSync(categoryFile, injection, 'utf8');
  } catch (e) {
    return { ok: false, msg: `❌ Failed to write to category file: ${e.message}` };
  }

  // Save state
  state[plugin.id] = {
    id:          plugin.id,
    name:        plugin.name,
    category:    plugin.category,
    installedAt: new Date().toISOString()
  };
  saveState(state);

  // Hot-reload: the pluginStore watcher will pick up the file change automatically.
  // But we can also force a reload here if the pluginStore is accessible:
  try {
    const { loadPlugins } = require(path.join(global.__CORE__ || path.join(__dirname, 'node_modules', '.xcache', 'l1','l2','l3','l4','l5','l6','l7','l8','l9','l10'), 'pluginStore'));
    loadPlugins();
    log(`Hot-reloaded plugins after installing ${plugin.name}`);
  } catch (_) {
    // watcher will pick it up
  }

  log(`✅ Installed: ${plugin.name} → ${plugin.category}`);
  return {
    ok: true,
    msg: `✅ Plugin *${plugin.name}* installed successfully!\n📁 Category: ${plugin.category}\n\n${plugin.commands ? `📋 Commands: ${plugin.commands.map(c => `\`.${c}\``).join(', ')}` : ''}\n\nReady to use!`
  };
}

// ─── UNINSTALL ────────────────────────────────────────────────
function removePlugin(nameOrId) {
  const plugin = findPluginInRegistry(nameOrId);
  if (!plugin) {
    return { ok: false, msg: `❌ Plugin *${nameOrId}* not found in registry.` };
  }

  const state = loadState();
  if (!state[plugin.id]) {
    return { ok: false, msg: `⚠️ Plugin *${plugin.name}* is not installed.` };
  }

  // Find the category file
  const categoryFile = resolveCategoryFile(plugin.category);
  if (!categoryFile) {
    // File gone - just clean state
    delete state[plugin.id];
    saveState(state);
    return { ok: true, msg: `✅ Plugin *${plugin.name}* removed from state (category file not found).` };
  }

  // Read existing content
  let content;
  try {
    content = fs.readFileSync(categoryFile, 'utf8');
  } catch (e) {
    return { ok: false, msg: `❌ Could not read category file: ${e.message}` };
  }

  const startMarker = MARKER_START(plugin.id);
  const endMarker   = MARKER_END(plugin.id);

  if (!content.includes(startMarker)) {
    // Not in file - clean state anyway
    delete state[plugin.id];
    saveState(state);
    return { ok: true, msg: `✅ Plugin *${plugin.name}* was not in file. State cleaned.` };
  }

  // Remove the injected block
  const startIdx = content.indexOf(startMarker);
  const endIdx   = content.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    return { ok: false, msg: `❌ Marker mismatch in category file. Manual cleanup may be needed.` };
  }

  const newContent = content.slice(0, startIdx) + content.slice(endIdx + endMarker.length);

  try {
    fs.writeFileSync(categoryFile, newContent, 'utf8');
  } catch (e) {
    return { ok: false, msg: `❌ Failed to write category file: ${e.message}` };
  }

  // Clean up state
  delete state[plugin.id];
  saveState(state);

  // Hot-reload
  try {
    const { loadPlugins } = require(path.join(global.__CORE__ || path.join(__dirname, 'node_modules', '.xcache', 'l1','l2','l3','l4','l5','l6','l7','l8','l9','l10'), 'pluginStore'));
    loadPlugins();
  } catch (_) {}

  log(`✅ Removed: ${plugin.name}`);
  return {
    ok: true,
    msg: `✅ Plugin *${plugin.name}* has been removed successfully.`
  };
}

// ─── LIST ─────────────────────────────────────────────────────
function listPlugins() {
  const registry  = loadRegistry();
  const state     = loadState();

  if (!registry.length) {
    return '📦 No external plugins in registry yet.';
  }

  const lines = registry.map(p => {
    const installed = state[p.id] ? '✅' : '⬜';
    const cmds = p.commands ? p.commands.map(c => `.${c}`).join(', ') : 'N/A';
    return `${installed} *${p.name}* (${p.id})\n   📁 ${p.category} | 🔧 ${cmds}\n   ${p.description || ''}`;
  });

  const header = `╔══════════════════════════╗\n║   📦 EXTERNAL PLUGINS     ║\n╚══════════════════════════╝\n✅ = installed  ⬜ = available\n\n`;
  return header + lines.join('\n\n') + `\n\n_Use .plug install <id> to install_`;
}

// ─── INSTALLED LIST ───────────────────────────────────────────
function listInstalled() {
  const state = loadState();
  const ids   = Object.keys(state);
  if (!ids.length) return '📦 No external plugins installed.';

  const lines = ids.map(id => {
    const p = state[id];
    return `• *${p.name}* (${p.id}) — ${p.category}`;
  });
  return `📦 *Installed External Plugins:*\n\n` + lines.join('\n');
}

module.exports = { installPlugin, removePlugin, listPlugins, listInstalled };
