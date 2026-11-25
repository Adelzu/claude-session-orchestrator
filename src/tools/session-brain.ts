// The brain, as seen from inside a Claude Code session (served on /mcp-files): read, search and append only,
// and only inside that session's own project folder (projects/<project>/). No write, no delete, no other projects.
// The project comes from the session the caller is (see callerFor), never from an argument.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { UserError } from '../config.ts';
import { tool, type Ctx } from './common.ts';
import type { Caller } from './files.ts';
import { brainDir, brainPath, commit, search } from './memory.ts';

/** Most characters one append may add, and the size past which a notes file stops growing (summarize it instead). */
export const MAX_APPEND = 2000;
export const MAX_NOTES_BYTES = 200_000;
// Generated or owned by the orchestrator: sessions may not append to these.
const RESERVED = new Set(['context.md', 'log.md', 'links.md']);

const inside = (root: string, p: string) => p === root || p.startsWith(root + sep);

/** The folder this session may use, as a brain-relative path, or a UserError saying why there is none. */
export function projectRoot(ctx: Ctx, caller: Caller | null): string {
  if (!caller) throw new UserError('This session could not be identified (it is not running in tmux), so it has no brain folder.');
  const project = ctx.db.session(caller.session)?.project;
  if (!project || !/^[a-z0-9-]+$/.test(project)) throw new UserError('This session is not tied to a project on the hub, so it has no brain folder.');
  return `projects/${project}`;
}

/** A path inside the project folder (relative to it), checked against traversal and symlinks. Returns brain-relative + absolute. */
export function scoped(root: string, rel: string, dir = brainDir()) {
  const brainRel = `${root}/${rel.replace(/^\/+/, '')}`;
  const abs = brainPath(brainRel, dir); // inside the brain, not in .git, not through a link out of it
  const rootAbs = resolve(dir, root);
  if (!inside(rootAbs, abs)) throw new UserError(`${rel} is outside your project folder (${root}/).`);
  // A symlink inside the project folder must not lead to another project.
  let existing = abs;
  while (!existsSync(existing)) existing = dirname(existing);
  if (existsSync(rootAbs) && !inside(realpathSync(rootAbs), realpathSync(existing))) throw new UserError(`${rel} points outside your project folder.`);
  return { brainRel: relative(dir, abs), abs, rootAbs };
}

export function register(server: McpServer, ctx: Ctx, caller: Caller | null) {
  tool(server, ctx, 'memory_search', 'Search the brain notes of this session\'s own project (projects/<project>/ only).',
    { query: z.string().min(1) },
    async ({ query }) => {
      const root = projectRoot(ctx, caller);
      const hits = await search(brainDir(), query, root);
      const files = [...new Set(hits.map((h) => h.path))];
      return { summary: hits.length ? `${hits.length} matches in ${files.length} files: ${files.slice(0, 5).join(', ')}.` : `Nothing found for "${query}" in ${root}/.`, hits };
    });

  tool(server, ctx, 'memory_read', 'Read a brain file of this session\'s own project, or list its folder. Paths are relative to projects/<project>/ ("." lists it).',
    { path: z.string().default('.') },
    async ({ path }) => {
      const root = projectRoot(ctx, caller);
      const { abs, brainRel } = scoped(root, path);
      if (!existsSync(abs)) throw new UserError(`${brainRel} does not exist in the brain.`);
      if (statSync(abs).isDirectory()) {
        const entries = readdirSync(abs, { withFileTypes: true }).filter((e) => e.name !== '.git').map((e) => e.name + (e.isDirectory() ? '/' : ''));
        return { summary: `${brainRel} has ${entries.length} entries.`, entries };
      }
      const content = readFileSync(abs, 'utf8');
      return { summary: `${brainRel}: ${content.split('\n').length} lines.`, content: content.slice(0, 50_000) };
    });

  tool(server, ctx, 'memory_append',
    `Add a short note to the brain of this session's own project: decisions, verified results, status changes (a few lines, up to ${MAX_APPEND} characters). Appends to projects/<project>/notes.md by default; git-committed with your session name. Nothing can be overwritten or deleted.`,
    { text: z.string().min(1), path: z.string().default('notes.md').describe('Markdown file inside the project folder (default notes.md)') },
    async ({ text, path }) => {
      const root = projectRoot(ctx, caller);
      if (text.length > MAX_APPEND) throw new UserError(`Too long: ${text.length} characters, the limit is ${MAX_APPEND}. Summarize it, or split it into several notes.`);
      const { abs, brainRel, rootAbs } = scoped(root, path);
      const rel = relative(rootAbs, abs);
      if (!/\.md$/i.test(rel)) throw new UserError('Notes go in .md files.');
      if (RESERVED.has(rel)) throw new UserError(`${rel} is generated by the orchestrator; use notes.md.`);
      if (existsSync(abs) && statSync(abs).size > MAX_NOTES_BYTES) throw new UserError(`${rel} is already ${MAX_NOTES_BYTES} bytes; summarize it before adding more.`);
      mkdirSync(dirname(abs), { recursive: true });
      const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
      const lead = existsSync(abs) && !readFileSync(abs, 'utf8').endsWith('\n') ? '\n' : '';
      appendFileSync(abs, `${lead}\n### ${stamp} UTC · ${caller!.session}\n${text.trim()}\n`);
      await commit(brainDir(), `memory_append: ${brainRel} (${caller!.session})`);
      return { summary: `Added to ${brainRel}.` };
    });
}
