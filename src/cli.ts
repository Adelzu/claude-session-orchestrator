#!/usr/bin/env node
// session-orchestrator CLI: set up, run, and register the MCP server with coding agents.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { stringify } from 'yaml';

const NAME = 'session-orchestrator';
const PKG = 'claude-session-orchestrator';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'); // package root, from src/ or dist/
const HOME_DIR = process.env.ORCH_HOME ?? join(homedir(), '.config', NAME);
const SKILL = join(ROOT, 'plugin', 'skills', 'manage-sessions');

const HELP = `Usage: ${NAME} <command>

  init [--machine <id>] [--projects-root <dir>]   Create config, tokens and this machine in ${HOME_DIR}
  serve                                           Run the HTTP server (/mcp for clients, /events for hooks)
  stdio                                           Serve the MCP tools over stdio (what agents launch)
  install <claude|codex|cursor|print>             Register the MCP server (and its skill) with an agent
  hooks <local|ssh-target> <machine-id> [url]     Install the status hooks on a machine

Config lives in ${HOME_DIR} (override with ORCH_HOME). Docs: https://github.com/Nurhak/${PKG}`;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Point the server at ~/.config/session-orchestrator unless the environment already says otherwise. */
function useHome() {
  const env = join(HOME_DIR, '.env');
  if (existsSync(env)) process.loadEnvFile(env); // never overrides variables that are already set
  process.env.CONFIG_DIR ??= HOME_DIR;
  process.env.DB_PATH ??= join(HOME_DIR, 'orchestrator.db');
  if (!existsSync(join(process.env.CONFIG_DIR, 'machines.yaml'))) fail(`No config in ${process.env.CONFIG_DIR}. Run: ${NAME} init`);
}

function init(machine = 'local', projectsRoot = '~/projects') {
  if (!/^[a-z0-9-]+$/.test(machine)) fail('--machine must match [a-z0-9-]+');
  mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  const write = (file: string, body: string, mode = 0o644) => {
    const p = join(HOME_DIR, file);
    if (existsSync(p)) return console.log(`kept    ${p}`);
    writeFileSync(p, body, { mode });
    console.log(`created ${p}`);
  };
  const os = platform() === 'darwin' ? 'macos' : 'linux';
  write('machines.yaml', stringify({ machines: [{ id: machine, local: true, os, projects_root: projectsRoot }] }));
  write('projects.yaml', 'projects: []\n');
  const tok = () => randomBytes(32).toString('hex');
  write('.env', `EVENTS_TOKEN=${tok()}\nMCP_TOKEN=${tok()}\n`, 0o600);
  console.log(`\nNext: ${NAME} install claude   (or codex, cursor, print)\n      ${NAME} serve            (keep it running so hooks can report status)\n      ${NAME} hooks local ${machine}`);
}

/** The command an agent should launch. An npx run lives in a temporary cache, so point at npx then. */
function serverCmd(): string[] {
  const cli = fileURLToPath(import.meta.url);
  return cli.includes(`${sep}_npx${sep}`) ? ['npx', '-y', PKG, 'stdio'] : [process.execPath, cli, 'stdio'];
}

function run(bin: string, args: string[], quiet = false) {
  const r = spawnSync(bin, args, { stdio: quiet ? 'ignore' : 'inherit' });
  if (r.error) fail(`${bin} not found on PATH. Install it first.`);
  return r.status === 0;
}

function copySkill(skillsDir: string) {
  const dest = join(skillsDir, 'manage-sessions');
  mkdirSync(skillsDir, { recursive: true });
  cpSync(SKILL, dest, { recursive: true });
  console.log(`skill   ${dest}`);
}

function install(target?: string) {
  const [command, ...args] = serverCmd();
  switch (target) {
    case 'claude':
      run('claude', ['mcp', 'remove', '-s', 'user', NAME], true); // re-install replaces the old entry
      if (!run('claude', ['mcp', 'add', '-s', 'user', NAME, '--', command, ...args])) fail('claude mcp add failed.');
      copySkill(join(homedir(), '.claude', 'skills'));
      break;
    case 'codex':
      run('codex', ['mcp', 'remove', NAME], true);
      if (!run('codex', ['mcp', 'add', NAME, '--', command, ...args])) fail('codex mcp add failed.');
      copySkill(join(homedir(), '.agents', 'skills'));
      break;
    case 'cursor': {
      const f = join(homedir(), '.cursor', 'mcp.json');
      const cfg = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
      cfg.mcpServers = { ...cfg.mcpServers, [NAME]: { command, args } };
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n');
      console.log(`added ${NAME} to ${f}`);
      break;
    }
    case 'print': // any other MCP client (Claude Desktop, Gemini CLI, Windsurf, …): paste into its config
      console.log(JSON.stringify({ mcpServers: { [NAME]: { command, args } } }, null, 2));
      return;
    default:
      fail('Usage: install <claude|codex|cursor|print>');
  }
  if (!existsSync(join(HOME_DIR, 'machines.yaml'))) console.log(`\nNo config yet: run ${NAME} init`);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'init': {
    const { values } = parseArgs({ args: rest, options: { machine: { type: 'string' }, 'projects-root': { type: 'string' } } });
    init(values.machine, values['projects-root']);
    break;
  }
  case 'serve':
    useHome();
    await (await import('./server.ts')).main();
    break;
  case 'stdio':
    useHome();
    await import('./stdio.ts');
    break;
  case 'install':
    install(rest[0]);
    break;
  case 'hooks': {
    useHome();
    const [target, machine, url = `http://127.0.0.1:${process.env.PORT ?? 8787}`] = rest;
    if (!target || !machine) fail(`Usage: ${NAME} hooks <local|ssh-target> <machine-id> [url]`);
    const r = spawnSync('sh', [join(ROOT, 'scripts', 'install-hooks.sh'), target, machine, url], { stdio: 'inherit', cwd: HOME_DIR });
    process.exit(r.status ?? 1);
  }
  case undefined: case 'help': case '--help': case '-h':
    console.log(HELP);
    break;
  default:
    fail(HELP);
}
