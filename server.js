
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const dataDir = path.join(root, 'data');
const dbPath = path.join(dataDir, 'nexus.json');

await fs.mkdir(dataDir, { recursive: true });

const initial = {
  machines: [{
    id: 'local-01',
    name: 'Local machine',
    type: 'hub',
    status: 'online',
    lastSeen: new Date().toISOString()
  }],
  projects: [],
  missions: [],
  logs: [{
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    level: 'INFO',
    message: 'NEXUS Core initialized.'
  }]
};

let db;
const eventClients = new Set();
const activeRuns = new Map();

const workspaceRoot = path.join(dataDir, 'workspaces');
await fs.mkdir(workspaceRoot, { recursive: true });

try {
  db = JSON.parse(await fs.readFile(dbPath, 'utf8'));
} catch {
  db = initial;
  await save();
}

function broadcast(event, payload = {}) {
  const frame =
    `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

  for (const client of eventClients) {
    if (!client.writableEnded) {
      client.write(frame);
    }
  }
}

async function save() {
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2));
  broadcast('state', {
    updatedAt: new Date().toISOString()
  });
}

function json(res, code, value) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });

  res.end(JSON.stringify(value));
}

function log(message, level = 'INFO') {
  db.logs.unshift({
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    level,
    message
  });

  db.logs = db.logs.slice(0, 150);
}

async function body(req) {
  let raw = '';

  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1024 * 1024) {
      throw new Error('Request body exceeds 1 MB limit');
    }
  }

  return raw ? JSON.parse(raw) : {};
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function exists(workspace, name) {
  return fsSync.existsSync(path.join(workspace, name));
}

function requireText(workspace, name) {
  return fsSync.readFileSync(
    path.join(workspace, name),
    'utf8'
  );
}

function detectProject(workspace) {
  const result = {
    stack: [],
    scripts: {},
    packageManager: null,
    git: false
  };

  try {
    const pkg = JSON.parse(
      requireText(workspace, 'package.json')
    );

    result.stack.push('Node.js');

    const dependencies = {
      ...pkg.dependencies,
      ...pkg.devDependencies
    };

    if (dependencies.react) result.stack.push('React');
    if (dependencies.vite) result.stack.push('Vite');
    if (dependencies.next) result.stack.push('Next.js');
    if (dependencies.express) result.stack.push('Express');

    result.scripts = pkg.scripts || {};
    result.packageManager = pkg.packageManager || null;
  } catch {
    // No valid package.json.
  }

  try {
    if (
      exists(workspace, 'requirements.txt') ||
      exists(workspace, 'pyproject.toml')
    ) {
      result.stack.push('Python');
    }
  } catch {}

  try {
    if (exists(workspace, 'Cargo.toml')) {
      result.stack.push('Rust');
    }
  } catch {}

  try {
    if (exists(workspace, 'go.mod')) {
      result.stack.push('Go');
    }
  } catch {}

  try {
    result.git = exists(workspace, '.git');
  } catch {}

  if (!result.stack.length) {
    result.stack.push('Unknown');
  }

  return result;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      shell: false,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', chunk => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', chunk => {
      stderr += chunk.toString();
    });

    const timer = options.timeout
      ? setTimeout(() => {
          child.kill();
          reject(new Error('Process timed out'));
        }, options.timeout)
      : null;

    child.on('error', error => {
      if (timer) clearTimeout(timer);
      reject(error);
    });

    child.on('close', code => {
      if (timer) clearTimeout(timer);

      resolve({
        code,
        stdout,
        stderr
      });
    });
  });
}

function safeWorkspace(projectId) {
  if (!projectId) return root;

  const project = db.projects.find(
    p => p.id === projectId
  );

  if (!project || !project.workspacePath) {
    return root;
  }

  return path.resolve(project.workspacePath);
}

async function resolveWorkspacePath(
  projectId,
  relativePath = ''
) {
  const base = safeWorkspace(projectId);
  const target = path.resolve(base, relativePath || '.');

  if (
    target !== base &&
    !target.startsWith(base + path.sep)
  ) {
    throw new Error('Path is outside the workspace');
  }

  const baseReal = await fs.realpath(base);
  const targetReal = await fs.realpath(target);

  if (
    targetReal !== baseReal &&
    !targetReal.startsWith(baseReal + path.sep)
  ) {
    throw new Error('Symlink escape blocked');
  }

  return targetReal;
}

function runAllowedTask(mission, taskType) {
  const workspace = safeWorkspace(mission.projectId);

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();

  mission.status = 'running';
  mission.runId = runId;
  mission.output = '';
  mission.startedAt = startedAt;

  const projectInfo = detectProject(workspace);

  const taskCommands = {
    inspect: {
      command: process.execPath,
      args: [
        '-e',
        "const fs=require('fs');console.log('Workspace:',process.cwd());console.log('Files:',fs.readdirSync(process.cwd()).slice(0,100).join(', '));"
      ],
      label: 'Inspect workspace'
    },

    git_status: {
      command: 'git',
      args: ['status'],
      label: 'Git status'
    },

    npm_test: {
      command: 'npm',
      args: ['test'],
      label: 'Run tests'
    },

    npm_build: {
      command: 'npm',
      args: ['run', 'build'],
      label: 'Build project'
    }
  };

  const task = taskCommands[taskType];

  if (!task) {
    throw new Error('Unsupported execution type');
  }

  if (taskType === 'git_status' && !projectInfo.git) {
    throw new Error(
      'Git is not initialized for this workspace. Use Initialize Git from the project card.'
    );
  }

  if (taskType === 'npm_test' && !projectInfo.scripts.test) {
    throw new Error(
      'This project has no test script in package.json.'
    );
  }

  if (taskType === 'npm_build' && !projectInfo.scripts.build) {
    throw new Error(
      'This project has no build script in package.json.'
    );
  }

  log(
    `Mission started (${task.label}): ${mission.title}`,
    'RUN'
  );

  const child = spawn(task.command, task.args, {
    cwd: workspace,
    shell: process.platform === 'win32',
    windowsHide: true,
    env: {
      ...process.env,
      CI: '1'
    }
  });

  activeRuns.set(runId, child);

  child.stdout.on('data', chunk => {
    mission.output += chunk.toString();
  });

  child.stderr.on('data', chunk => {
    mission.output += chunk.toString();
  });

  child.on('close', async code => {
    activeRuns.delete(runId);

    if (mission.status !== 'cancelled') {
      mission.status = code === 0 ? 'review' : 'failed';
    }

    mission.exitCode = code;
    mission.finishedAt = new Date().toISOString();

    log(
      `Mission ${code === 0 ? 'finished' : 'failed'} (${task.label}): ${mission.title}`,
      code === 0 ? 'INFO' : 'ERROR'
    );

    await save();
  });

  child.on('error', async error => {
    mission.status = 'failed';
    mission.output += `\n${error.message}`;

    activeRuns.delete(runId);

    log(`Mission failed: ${error.message}`, 'ERROR');
    await save();
  });

  return {
    runId,
    status: mission.status,
    startedAt
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    // STATE
    if (
      req.method === 'GET' &&
      url.pathname === '/api/state'
    ) {
      return json(res, 200, db);
    }

    // SERVER-SENT EVENTS
    if (
      req.method === 'GET' &&
      url.pathname === '/api/events'
    ) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });

      res.write('event: connected\ndata: {}\n\n');
      eventClients.add(res);

      const keepalive = setInterval(() => {
        if (!res.writableEnded) {
          res.write(': keepalive\n\n');
        }
      }, 20000);

      req.on('close', () => {
        clearInterval(keepalive);
        eventClients.delete(res);
      });

      return;
    }

    // PROJECT FILE BROWSER
    if (
      req.method === 'GET' &&
      url.pathname.match(/^\/api\/projects\/[^/]+\/files$/)
    ) {
      const projectId = url.pathname.split('/')[3];
      const rel = url.searchParams.get('path') || '';

      try {
        const dir = await resolveWorkspacePath(projectId, rel);

        const entries = await fs.readdir(dir, {
          withFileTypes: true
        });

        const items = await Promise.all(
          entries.slice(0, 300).map(async entry => {
            const full = path.join(dir, entry.name);
            const stat = await fs.lstat(full);

            return {
              name: entry.name,
              type: stat.isDirectory()
                ? 'directory'
                : stat.isFile()
                  ? 'file'
                  : 'other',
              size: stat.size,
              modifiedAt: stat.mtime.toISOString()
            };
          })
        );

        items.sort((a, b) =>
          a.type === 'directory' && b.type !== 'directory'
            ? -1
            : b.type === 'directory' && a.type !== 'directory'
              ? 1
              : a.name.localeCompare(b.name)
        );

        return json(res, 200, {
          path: rel,
          items
        });
      } catch (error) {
        return json(res, 400, {
          error: error.message
        });
      }
    }

    // FILE PREVIEW
    if (
      req.method === 'GET' &&
      url.pathname.match(/^\/api\/projects\/[^/]+\/preview$/)
    ) {
      const projectId = url.pathname.split('/')[3];
      const rel = url.searchParams.get('path') || '';

      try {
        const file = await resolveWorkspacePath(projectId, rel);
        const stat = await fs.stat(file);

        if (!stat.isFile()) {
          return json(res, 400, {
            error: 'Preview target is not a file'
          });
        }

        if (stat.size > 300 * 1024) {
          return json(res, 413, {
            error: 'File exceeds 300 KB preview limit'
          });
        }

        const content = await fs.readFile(file, 'utf8');

        if (content.includes('\u0000')) {
          return json(res, 415, {
            error: 'Binary file preview is not supported'
          });
        }

        return json(res, 200, {
          path: rel,
          content,
          size: stat.size
        });
      } catch (error) {
        return json(res, 400, {
          error: error.message
        });
      }
    }

    // GIT DIFF
    if (
      req.method === 'GET' &&
      url.pathname.match(/^\/api\/projects\/[^/]+\/git-diff$/)
    ) {
      const projectId = url.pathname.split('/')[3];
      const cwd = safeWorkspace(projectId);

      try {
        const result = await runProcess(
          'git',
          ['diff', '--no-ext-diff', '--'],
          {
            cwd,
            timeout: 20000
          }
        );

        return json(
          res,
          result.code === 0 ? 200 : 400,
          {
            diff: result.stdout,
            error: result.stderr,
            exitCode: result.code
          }
        );
      } catch (error) {
        return json(res, 400, {
          error: error.message
        });
      }
    }

    // PROJECT INFORMATION / SCAN
    if (
      req.method === 'GET' &&
      url.pathname.match(/^\/api\/projects\/[^/]+\/info$/)
    ) {
      const id = url.pathname.split('/')[3];

      const project = db.projects.find(p => p.id === id);

      if (!project) {
        return json(res, 404, {
          error: 'Project not found'
        });
      }

      if (!project.workspacePath) {
        return json(res, 400, {
          error: 'This project has no workspace folder configured.'
        });
      }

      const scan = detectProject(safeWorkspace(id));

      project.stack = scan.stack;
      project.scripts = scan.scripts;
      project.git = scan.git;
      project.packageManager = scan.packageManager;

      await save();

      return json(res, 200, {
        project,
        scan
      });
    }

    // INITIALIZE GIT
    if (
      req.method === 'POST' &&
      url.pathname.match(/^\/api\/projects\/[^/]+\/init-git$/)
    ) {
      const id = url.pathname.split('/')[3];

      const project = db.projects.find(p => p.id === id);

      if (!project) {
        return json(res, 404, {
          error: 'Project not found'
        });
      }

      if (!project.workspacePath) {
        return json(res, 400, {
          error: 'This project has no workspace folder configured.'
        });
      }

      const cwd = safeWorkspace(id);

      if (detectProject(cwd).git) {
        return json(res, 409, {
          error: 'Git is already initialized'
        });
      }

      const result = await runProcess(
        'git',
        ['init'],
        {
          cwd,
          timeout: 20000
        }
      );

      if (result.code !== 0) {
        return json(res, 400, {
          error: result.stderr || 'git init failed'
        });
      }

      const scan = detectProject(cwd);

      Object.assign(project, scan);

      log(`Git initialized: ${project.name}`);
      await save();

      return json(res, 200, {
        ok: true,
        scan
      });
    }

    // IMPORT PUBLIC GITHUB REPOSITORY
    if (
      req.method === 'POST' &&
      url.pathname === '/api/projects/import'
    ) {
      const input = await body(req);
      const repoUrl = String(input.url || '').trim();

      let parsed;

      try {
        parsed = new URL(repoUrl);
      } catch {
        return json(res, 400, {
          error: 'Enter a valid repository URL'
        });
      }

      if (
        parsed.protocol !== 'https:' ||
        !['github.com', 'www.github.com'].includes(
          parsed.hostname.toLowerCase()
        ) ||
        !/^\/[^/]+\/[^/]+(?:\.git)?$/.test(parsed.pathname)
      ) {
        return json(res, 400, {
          error: 'Only public GitHub HTTPS repository URLs are supported'
        });
      }

      const parts = parsed.pathname.split('/').filter(Boolean);
      const owner = parts[0];
      const repoName = parts[1].replace(/\.git$/, '');

      const name = String(input.name || repoName).trim();

      if (!name) {
        return json(res, 400, {
          error: 'Project name required'
        });
      }

      const folder =
        `${repoName}-${crypto.randomUUID().slice(0, 8)}`;

      const dest = path.join(workspaceRoot, folder);

      const cloneUrl =
        `https://github.com/${owner}/${repoName}.git`;

      try {
        const result = await runProcess(
          'git',
          ['clone', '--depth', '1', cloneUrl, dest],
          {
            cwd: workspaceRoot,
            timeout: 180000
          }
        );

        if (result.code !== 0) {
          await fs.rm(dest, {
            recursive: true,
            force: true
          });

          return json(res, 400, {
            error: (
              result.stderr ||
              result.stdout ||
              'Clone failed'
            ).trim().slice(-3000)
          });
        }

        const scan = detectProject(dest);

        const project = {
          id: crypto.randomUUID(),
          name,
          description: String(
            input.description ||
            `Imported from ${cloneUrl}`
          ).trim(),
          workspacePath: dest,
          sourceType: 'github',
          repoUrl: cloneUrl,
          createdAt: new Date().toISOString(),
          ...scan
        };

        db.projects.unshift(project);

        log(`Repository imported: ${project.name}`, 'INFO');

        await save();

        return json(res, 201, project);
      } catch (error) {
        await fs.rm(dest, {
          recursive: true,
          force: true
        }).catch(() => {});

        return json(res, 400, {
          error: error.message || 'Repository import failed'
        });
      }
    }

    // CREATE LOCAL PROJECT
    if (
      req.method === 'POST' &&
      url.pathname === '/api/projects'
    ) {
      const input = await body(req);

      if (!input.name?.trim()) {
        return json(res, 400, {
          error: 'Project name required'
        });
      }

      const project = {
        id: crypto.randomUUID(),
        name: input.name.trim(),
        description: (input.description || '').trim(),
        workspacePath: (input.workspacePath || '').trim(),
        createdAt: new Date().toISOString()
      };

      if (project.workspacePath) {
        const resolved = path.resolve(project.workspacePath);

        try {
          const stat = await fs.stat(resolved);

          if (!stat.isDirectory()) {
            return json(res, 400, {
              error: 'Workspace path must be a directory'
            });
          }

          project.workspacePath = resolved;
        } catch {
          return json(res, 400, {
            error: 'Workspace directory does not exist'
          });
        }
      }

      Object.assign(
        project,
        detectProject(project.workspacePath || root)
      );

      project.sourceType = 'local';

      db.projects.unshift(project);

      log(`Project created: ${project.name}`);

      await save();

      return json(res, 201, project);
    }

    // CREATE MISSION
    if (
      req.method === 'POST' &&
      url.pathname === '/api/missions'
    ) {
      const input = await body(req);

      if (!input.title?.trim()) {
        return json(res, 400, {
          error: 'Mission title required'
        });
      }

      const mission = {
        id: crypto.randomUUID(),
        title: input.title.trim(),
        details: (input.details || '').trim(),
        projectId: input.projectId || null,
        executionType: input.executionType || 'inspect',
        status: 'queued',
        machineId: 'local-01',
        createdAt: new Date().toISOString(),
        output: ''
      };

      db.missions.unshift(mission);

      log(`Mission queued: ${mission.title}`);

      await save();

      return json(res, 201, mission);
    }

    // RUN MISSION
    if (
      req.method === 'POST' &&
      url.pathname.match(/^\/api\/missions\/[^/]+\/run$/)
    ) {
      const id = url.pathname.split('/')[3];

      const mission = db.missions.find(m => m.id === id);

      if (!mission) {
        return json(res, 404, {
          error: 'Mission not found'
        });
      }

      if (mission.status === 'running') {
        return json(res, 409, {
          error: 'Mission already running'
        });
      }

      try {
        const result = runAllowedTask(
          mission,
          mission.executionType || 'inspect'
        );

        await save();

        return json(res, 202, result);
      } catch (error) {
        return json(res, 400, {
          error: error.message
        });
      }
    }

    // STOP MISSION
    if (
      req.method === 'POST' &&
      url.pathname.match(/^\/api\/missions\/[^/]+\/stop$/)
    ) {
      const id = url.pathname.split('/')[3];

      const mission = db.missions.find(m => m.id === id);

      if (!mission || !mission.runId) {
        return json(res, 404, {
          error: 'No active run found'
        });
      }

      const child = activeRuns.get(mission.runId);

      if (child) child.kill();

      mission.status = 'cancelled';

      log(`Mission stopped: ${mission.title}`, 'WARN');

      await save();

      return json(res, 200, {
        ok: true
      });
    }

    // UPDATE MISSION
    if (
      req.method === 'PATCH' &&
      url.pathname.startsWith('/api/missions/')
    ) {
      const id = url.pathname.split('/').pop();
      const input = await body(req);

      const mission = db.missions.find(m => m.id === id);

      if (!mission) {
        return json(res, 404, {
          error: 'Mission not found'
        });
      }

      if (
        ['queued', 'review', 'completed', 'cancelled'].includes(
          input.status
        )
      ) {
        mission.status = input.status;

        log(`Mission ${mission.status}: ${mission.title}`);

        await save();
      }

      return json(res, 200, mission);
    }

    // DELETE MISSION
    if (
      req.method === 'DELETE' &&
      url.pathname.startsWith('/api/missions/')
    ) {
      const id = url.pathname.split('/').pop();

      db.missions = db.missions.filter(m => m.id !== id);

      log('Mission removed.');

      await save();

      return json(res, 200, {
        ok: true
      });
    }

    // STATIC FRONTEND
    if (
      req.method === 'GET' &&
      url.pathname.startsWith('/')
    ) {
      const requested =
        url.pathname === '/'
          ? 'index.html'
          : url.pathname.slice(1);

      const file = path.resolve(publicDir, requested);

      if (
        !file.startsWith(publicDir + path.sep) &&
        file !== path.join(publicDir, 'index.html')
      ) {
        return json(res, 403, {
          error: 'Forbidden'
        });
      }

      try {
        const content = await fs.readFile(file);

        res.writeHead(200, {
          'content-type':
            mime[path.extname(file)] ||
            'application/octet-stream'
        });

        res.end(content);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }

      return;
    }

    json(res, 404, {
      error: 'Route not found'
    });

  } catch (error) {
    json(res, 500, {
      error: error.message || 'Internal error'
    });
  }
});

const port = Number(process.env.PORT || 3030);

server.listen(port, '0.0.0.0', () => {
  console.log(
    `NEXUS Core running at http://localhost:${port}`
  );
});
