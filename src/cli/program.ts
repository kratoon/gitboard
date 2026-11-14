/**
 * The CLI adapter (ADR-9b13ab6). It parses arguments, reads input files and stdin, prompts when running
 * interactively, prints results and maps errors to exit codes. Every business operation is delegated
 * to `executeOperation`; nothing here validates or manipulates issues itself.
 */
import { Command, CommanderError } from 'commander';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pkg from '../../package.json';
import {
  GitboardError,
  ID_PATTERN,
  exitCodeFor,
  executeOperation,
  toGitboardError,
  type ExecuteResult,
} from '../core';
import { registerStart } from './commands/start';
import * as fmt from './format';
import type { CliIo } from './io';

export interface CliState {
  exit: number;
  json: boolean;
}

const collect = (value: string, previous: string[] = []): string[] => [
  ...previous,
  ...value.split(',').map((part) => part.trim()).filter(Boolean),
];

function parseRemap(pairs: string[] | undefined): Record<string, string> | undefined {
  if (!pairs || pairs.length === 0) return undefined;
  const map: Record<string, string> = {};
  for (const pair of pairs) {
    const [from, to, ...rest] = pair.split('=');
    if (!from || !to || rest.length > 0) throw new GitboardError('INVALID_INPUT', `Invalid --remap value "${pair}". Use old=new.`);
    map[from.trim()] = to.trim();
  }
  return map;
}

/**
 * Builds the column list for init / project create / columns set from `--columns` and `--done`.
 * Without `--done` the columns stay plain ids (done-ness is left as it is); with it, every column states
 * explicitly whether it is done.
 */
function columnsFrom(ids: string[] | undefined, done: string[] | undefined): Array<string | { id: string; done: boolean }> | undefined {
  if (ids === undefined || done === undefined) return ids;
  const unknown = done.filter((id) => !ids.includes(id));
  if (unknown.length > 0) {
    throw new GitboardError('INVALID_INPUT', `--done lists ${unknown.join(', ')}, which ${unknown.length > 1 ? 'are' : 'is'} not in --columns.`);
  }
  return ids.map((id) => ({ id, done: done.includes(id) }));
}

export function buildProgram(io: CliIo, state: CliState): Command {
  const program = new Command();
  program
    .name('gitboard')
    .description('Git-native, local-first Kanban board. Issues are Markdown files in your repository.')
    .version(pkg.version)
    .option('-r, --repo <name|path>', 'repository to use (default: the repo containing the current directory)')
    .option('--json', 'machine-readable JSON output')
    .showHelpAfterError(false)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.out(text),
      writeErr: (text) => {
        if (!state.json) io.err(text);
      },
    });

  const interactive = () => io.stdinIsTTY && io.stdoutIsTTY && !state.json;

  const emit = (result: ExecuteResult, render: (data: never) => string): void => {
    if (state.json) {
      io.out(`${JSON.stringify({ ok: true, data: result.data, ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}) }, null, 2)}\n`);
      return;
    }
    for (const warning of result.warnings) io.err(`warning: ${warning}\n`);
    io.out(`${render(result.data as never)}\n`);
  };

  const run = async (cmd: Command, operation: string, input: unknown, render: (data: never) => string): Promise<ExecuteResult> => {
    const { repo } = cmd.optsWithGlobals<{ repo?: string }>();
    const result = await executeOperation(operation, input, { cwd: io.cwd, repo });
    emit(result, render);
    return result;
  };

  const confirm = async (question: string): Promise<boolean> => /^y(es)?$/i.test((await io.prompt(`${question} [y/N] `)).trim());

  async function readBody(opts: { body?: string; bodyFile?: string; stdin?: boolean }): Promise<string | undefined> {
    const given = [opts.body !== undefined, opts.bodyFile !== undefined, opts.stdin === true].filter(Boolean).length;
    if (given > 1) throw new GitboardError('INVALID_INPUT', 'Use only one of --body, --body-file and --stdin.');
    if (opts.body !== undefined) return opts.body;
    if (opts.stdin || opts.bodyFile === '-') return io.readStdin();
    if (opts.bodyFile !== undefined) {
      try {
        return await readFile(path.resolve(io.cwd, opts.bodyFile), 'utf8');
      } catch {
        throw new GitboardError('INVALID_INPUT', `Cannot read body file: ${opts.bodyFile}`);
      }
    }
    return undefined;
  }

  // --- init and repositories -----------------------------------------------------------------
  program
    .command('init')
    .description('Initialise Gitboard in the current repository')
    .option('--columns <ids>', 'repository columns, comma separated (default: todo,in-progress,done)', collect)
    .option('--done <ids>', 'which of --columns are done columns, comma separated (default: the last one)', collect)
    .option('--project-key <KEY>', 'key of the default project')
    .option('--project-name <name>', 'name of the default project')
    .action(async (opts, cmd: Command) => {
      await run(cmd, 'repo.init', { columns: columnsFrom(opts.columns, opts.done), projectKey: opts.projectKey, projectName: opts.projectName }, (d: { root: string; projectKey?: string; created: boolean; registered: boolean }) =>
        [
          d.created
            ? `Initialised Gitboard in ${d.root} with default project ${d.projectKey}.`
            : `Gitboard is already initialised in ${d.root}; nothing changed.`,
          d.registered ? 'It is registered, so it shows up in `gitboard start`.' : '',
          d.created ? 'Commit the new .gitboard/ directory to share it.' : '',
        ]
          .filter(Boolean)
          .join('\n'));
    });

  const repo = program.command('repo').description('Manage registered repositories');
  repo
    .command('add <path-or-ssh-url>')
    .description('Register a local repository, or clone and register an SSH remote')
    .option('--name <name>', 'name to register it under')
    .action(async (source: string, opts, cmd: Command) => {
      await run(cmd, 'repo.add', { source, name: opts.name }, fmt.renderRepo);
    });
  repo.command('list').description('List registered repositories').action(async (_opts, cmd: Command) => {
    await run(cmd, 'repo.list', {}, fmt.renderRepos);
  });
  repo
    .command('remove <repo>')
    .description('Remove a repository from Gitboard without deleting it')
    .action(async (name: string, _opts, cmd: Command) => {
      await run(cmd, 'repo.remove', { repo: name }, (d: { name: string }) => `Removed ${d.name} from the registry. The repository was not deleted.`);
    });
  repo
    .command('default <repo>')
    .description('Use this repository when running outside any repository')
    .action(async (name: string, _opts, cmd: Command) => {
      await run(cmd, 'repo.default', { repo: name }, (d: { name: string }) => `Default repository is now ${d.name}.`);
    });

  // --- projects ------------------------------------------------------------------------------
  const project = program.command('project').description('Manage projects (groups of issues identified by a key)');
  project
    .command('create <KEY>')
    .description('Create a project')
    .option('--name <name>', 'display name (default: the key)')
    .option('--description <text>', 'description')
    .option('--columns <ids>', 'override the repository columns for this project, comma separated', collect)
    .option('--done <ids>', 'which of --columns are done columns, comma separated (default: the last one)', collect)
    .action(async (key: string, opts, cmd: Command) => {
      await run(cmd, 'project.create', { key, name: opts.name ?? key, description: opts.description, columns: columnsFrom(opts.columns, opts.done) }, (d: { key: string; name: string }) => `Created project ${d.key} (${d.name}).`);
    });
  project.command('list').description('List projects').action(async (_opts, cmd: Command) => {
    await run(cmd, 'project.list', {}, fmt.renderProjects);
  });
  project
    .command('update <KEY>')
    .description('Rename a project or change its description')
    .option('--name <name>')
    .option('--description <text>')
    .option('--clear-description', 'remove the description')
    .action(async (key: string, opts, cmd: Command) => {
      await run(cmd, 'project.update', { key, name: opts.name, description: opts.clearDescription ? null : opts.description }, (d: { key: string; name: string }) => `Updated project ${d.key} (${d.name}).`);
    });
  project.command('delete <KEY>').description('Delete an empty project').action(async (key: string, _opts, cmd: Command) => {
    await run(cmd, 'project.delete', { key }, (d: { key: string }) => `Deleted project ${d.key}.`);
  });

  // --- columns -------------------------------------------------------------------------------
  const columns = program.command('columns').description('Show or change board columns (statuses)');
  columns
    .command('show')
    .description('Show the effective columns and where they come from')
    .option('--project <KEY>')
    .action(async (opts, cmd: Command) => {
      await run(cmd, 'columns.show', { project: opts.project }, fmt.renderColumns);
    });
  columns
    .command('set')
    .description('Override columns for the repository, or for one project with --project')
    .requiredOption('--columns <ids>', 'comma-separated column ids, in board order', collect)
    .option('--done <ids>', 'which of --columns are done columns, comma separated (default: unchanged for existing columns)', collect)
    .option('--project <KEY>')
    .option('--remap <old=new...>', 'move issues from a removed status to another (repeatable)', collect)
    .action(async (opts, cmd: Command) => {
      await run(cmd, 'columns.set', { columns: columnsFrom(opts.columns, opts.done), project: opts.project, remap: parseRemap(opts.remap) }, fmt.renderColumnsChange);
    });
  columns
    .command('reset')
    .description('Remove a column override so the layer below applies')
    .option('--project <KEY>')
    .option('--remap <old=new...>', 'move issues from a removed status to another (repeatable)', collect)
    .action(async (opts, cmd: Command) => {
      await run(cmd, 'columns.reset', { project: opts.project, remap: parseRemap(opts.remap) }, fmt.renderColumnsChange);
    });

  // --- config --------------------------------------------------------------------------------
  const config = program.command('config').description('Manage the repository config file');
  config
    .command('convert')
    .description('Convert .gitboard/config between YAML (default) and JSON')
    .option('--to <format>', 'yaml (default) or json')
    .action(async (opts, cmd: Command) => {
      await run(cmd, 'config.convert', { to: opts.to }, (d: { from: string; to: string; changed: boolean }) =>
        d.changed
          ? `Converted .gitboard/${d.from} to .gitboard/${d.to}.${d.to.endsWith('.json') ? ' (YAML comments are not kept in JSON.)' : ''}`
          : `.gitboard/${d.from} already uses that format; nothing changed.`);
    });

  // --- views ---------------------------------------------------------------------------------
  const views = program.command('views').description('Show or change which views (kanban, backlog) are enabled');
  views
    .command('show')
    .description('Show the enabled views and where they come from')
    .option('--project <KEY>')
    .action(async (opts, cmd: Command) => {
      await run(cmd, 'views.show', { project: opts.project }, fmt.renderViews);
    });
  views
    .command('set')
    .description('Enable specific views for the repository, or for one project with --project')
    .requiredOption('--views <ids>', 'comma-separated view ids; the first is the default (kanban, backlog)', collect)
    .option('--project <KEY>')
    .action(async (opts, cmd: Command) => {
      await run(cmd, 'views.set', { views: opts.views, project: opts.project }, fmt.renderViews);
    });
  views
    .command('reset')
    .description('Remove a views override so the layer below applies')
    .option('--project <KEY>')
    .action(async (opts, cmd: Command) => {
      await run(cmd, 'views.reset', { project: opts.project }, fmt.renderViews);
    });

  // --- issues --------------------------------------------------------------------------------
  const issue = program.command('issue').description('Manage issues');
  issue
    .command('list')
    .description('List issues')
    .option('--project <KEY>')
    .option('--status <status>')
    .option('--label <label>')
    .option('--priority <priority>', 'low | medium | high | urgent')
    .option('--type <type>', 'story | epic')
    .option('--parent <ref>', 'only children of this epic')
    .option('-q, --search <text>', 'search titles, bodies and ids')
    .action(async (opts, cmd: Command) => {
      await run(cmd, 'issue.list', { project: opts.project, status: opts.status, label: opts.label, priority: opts.priority, type: opts.type, parent: opts.parent, q: opts.search }, fmt.renderIssues);
    });
  issue.command('show <ref>').description('Show an issue (short id, KEY-shortid or full id)').action(async (ref: string, _opts, cmd: Command) => {
    await run(cmd, 'issue.get', { ref }, fmt.renderIssue);
  });
  issue
    .command('create [title]')
    .description('Create an issue')
    .option('-t, --title <title>')
    .option('--project <KEY>', 'required when the repository has more than one project')
    .option('--type <type>', 'story (default) | epic')
    .option('--status <status>', 'default: the first column')
    .option('--priority <priority>', 'low | medium | high | urgent')
    .option('--label <labels...>', 'label (repeatable or comma separated)', collect)
    .option('--parent <ref>', 'epic to attach the issue to')
    .option('--body <markdown>')
    .option('--body-file <path>', 'read the body from a file (- for stdin)')
    .option('--stdin', 'read the body from stdin')
    .action(async (titleArg: string | undefined, opts, cmd: Command) => {
      let title: string | undefined = opts.title ?? titleArg;
      if (title === undefined) {
        if (!interactive()) throw new GitboardError('MISSING_INPUT', 'A title is required: pass it as an argument or with --title.');
        title = (await io.prompt('Title: ')).trim();
      }
      const body = await readBody(opts);
      await run(cmd, 'issue.create', { title, body, project: opts.project, type: opts.type, status: opts.status, priority: opts.priority, labels: opts.label, parent: opts.parent }, fmt.renderCreated);
    });
  issue
    .command('update <ref>')
    .description('Update issue metadata or body')
    .option('--title <title>')
    .option('--status <status>')
    .option('--priority <priority>', 'low | medium | high | urgent')
    .option('--clear-priority')
    .option('--add-label <labels...>', 'add labels', collect)
    .option('--remove-label <labels...>', 'remove labels', collect)
    .option('--set-labels <labels...>', 'replace all labels', collect)
    .option('--project <KEY>', 'move the issue to another project')
    .option('--parent <ref>', 'set the parent epic')
    .option('--no-parent', 'remove the parent')
    .option('--rank <rank>', 'set the raw ordering key (normally use `issue move`)')
    .option('--body <markdown>')
    .option('--body-file <path>', 'read the body from a file (- for stdin)')
    .option('--stdin', 'read the body from stdin')
    .option('--expected-hash <hash>', 'fail with a conflict if the issue changed since this hash')
    .action(async (ref: string, opts, cmd: Command) => {
      const body = await readBody(opts);
      await run(
        cmd,
        'issue.update',
        {
          ref,
          title: opts.title,
          body,
          status: opts.status,
          priority: opts.clearPriority ? null : opts.priority,
          labels: opts.setLabels,
          addLabels: opts.addLabel,
          removeLabels: opts.removeLabel,
          project: opts.project,
          parent: opts.parent === false ? null : opts.parent,
          rank: opts.rank,
          expectedHash: opts.expectedHash,
        },
        fmt.renderUpdated,
      );
    });
  issue
    .command('move <ref> [status]')
    .description('Change status and/or position: gitboard issue move <ref> done --top')
    .option('--before <ref>', 'place before this issue')
    .option('--after <ref>', 'place after this issue')
    .option('--top', 'place at the top of the column')
    .option('--bottom', 'place at the bottom of the column')
    .option('--expected-hash <hash>')
    .action(async (ref: string, status: string | undefined, opts, cmd: Command) => {
      if (opts.top && opts.bottom) throw new GitboardError('INVALID_INPUT', 'Use only one of --top and --bottom.');
      await run(cmd, 'issue.move', { ref, status, before: opts.before, after: opts.after, position: opts.top ? 'top' : opts.bottom ? 'bottom' : undefined, expectedHash: opts.expectedHash }, fmt.renderMoved);
    });
  issue
    .command('check <ref> <n>')
    .description('Check (or --uncheck) the n-th checklist item (1-based)')
    .option('--uncheck')
    .action(async (ref: string, n: string, opts, cmd: Command) => {
      await run(cmd, 'issue.check', { ref, index: Number(n), checked: !opts.uncheck }, fmt.renderChecklist);
    });
  issue
    .command('delete <id>')
    .description('Delete an issue (requires the full 12-character id)')
    .option('-y, --yes', 'do not ask for confirmation')
    .option('--unlink-children', 'when deleting an epic, detach its children instead of refusing')
    .action(async (id: string, opts, cmd: Command) => {
      if (!ID_PATTERN.test(id)) {
        throw new GitboardError('INVALID_INPUT', `issue delete needs the full 12-character id, not "${id}". Use \`gitboard issue show ${id}\` to find it.`);
      }
      if (!opts.yes) {
        if (!interactive()) throw new GitboardError('MISSING_INPUT', 'Refusing to delete without confirmation. Pass --yes.');
        if (!(await confirm(`Delete issue ${id}?`))) {
          io.out('Cancelled.\n');
          return;
        }
      }
      await run(cmd, 'issue.delete', { id, unlinkChildren: opts.unlinkChildren }, fmt.renderDeleted);
    });

  // --- board, validate, status ---------------------------------------------------------------
  program.command('board').description('Show the board').option('--project <KEY>').action(async (opts, cmd: Command) => {
    await run(cmd, 'board.get', { project: opts.project }, fmt.renderBoards);
  });
  program
    .command('backlog')
    .description('List open work as an ordered list grouped by status (the done column is hidden)')
    .option('--project <KEY>')
    .option('--all', 'include the done column')
    .action(async (opts, cmd: Command) => {
      await run(cmd, 'backlog.get', { project: opts.project, includeDone: opts.all ? true : undefined }, fmt.renderBacklog);
    });
  program.command('validate').description('Check issue storage for problems (exit code 4 if any)').action(async (_opts, cmd: Command) => {
    const { repo: selector } = cmd.optsWithGlobals<{ repo?: string }>();
    const result = await executeOperation('validate', {}, { cwd: io.cwd, repo: selector });
    const data = result.data as { ok: boolean; problems: unknown[] };
    if (state.json) {
      const envelope = data.ok
        ? { ok: true, data }
        : { ok: false, error: { code: 'VALIDATION_FAILED', message: `${data.problems.length} problem(s) found` }, data };
      io.out(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      io.out(`${fmt.renderValidate(data as never)}\n`);
    }
    if (!data.ok) state.exit = exitCodeFor('VALIDATION_FAILED');
  });
  program.command('status').description('Show the Git branch and uncommitted .gitboard changes').action(async (_opts, cmd: Command) => {
    await run(cmd, 'git.status', {}, fmt.renderGitStatus);
  });

  // --- agent skills --------------------------------------------------------------------------
  const skills = program.command('skills').description('Install and update the Gitboard agent skill');
  const skillCommand = (name: 'install' | 'sync' | 'status', description: string) =>
    skills
      .command(name)
      .description(description)
      .option('-a, --agent <ids...>', 'agents to install for (default: universal,claude-code)', collect)
      .option('-g, --global', 'use your home directory instead of the current repository')
      .option('--mode <mode>', 'copy | link (default: copy for projects, link for --global)')
      .option('--path <dir>', 'extra skills directory for an agent that is not built in')
      .option('--force', 'overwrite customised skill files')
      .option('-y, --yes', 'never prompt')
      .action(async (opts, cmd: Command) => {
        const input = { agents: opts.agent, global: opts.global, mode: opts.mode, path: opts.path, force: opts.force };
        try {
          await run(cmd, `skills.${name}`, input, fmt.renderSkills);
        } catch (error) {
          const err = toGitboardError(error);
          if (err.code === 'SKILL_MODIFIED' && !opts.yes && !opts.force && interactive()) {
            io.err(`${err.message}\n`);
            if (await confirm('Overwrite these files?')) {
              await run(cmd, `skills.${name}`, { ...input, force: true }, fmt.renderSkills);
              return;
            }
          }
          throw error;
        }
      });
  skillCommand('install', 'Install the skill into this repository (or --global)');
  skillCommand('sync', 'Update installed copies of the skill to this version');
  skillCommand('status', 'Show what is installed and whether it is current');

  registerStart(program, io, state);
  return program;
}

/** Runs the CLI and returns the process exit code. Never throws and never exits the process. */
export async function main(argv: string[], io: CliIo): Promise<number> {
  const state: CliState = { exit: 0, json: argv.includes('--json') };
  const program = buildProgram(io, state);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return state.exit;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return 0;
      if (state.json) {
        io.out(`${JSON.stringify({ ok: false, error: { code: 'INVALID_INPUT', message: error.message.replace(/^error: /, '') } }, null, 2)}\n`);
      }
      return exitCodeFor('INVALID_INPUT');
    }
    const err = toGitboardError(error);
    if (state.json) {
      io.out(`${JSON.stringify({ ok: false, error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } }, null, 2)}\n`);
    } else {
      io.err(`error: ${err.message}\n`);
    }
    return exitCodeFor(err.code);
  }
}
