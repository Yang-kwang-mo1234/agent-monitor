// Turns a tool call into a human label, an icon key and a source name.
// Edit freely: add MCP servers to BRANDS, or change the wording below.

const BRANDS = {
  github: { icon: 'github', name: 'GitHub' },
  notion: { icon: 'notion', name: 'Notion' },
  slack: { icon: 'slack', name: 'Slack' },
  linear: { icon: 'linear', name: 'Linear' },
  figma: { icon: 'plug', name: 'Figma' },
  vercel: { icon: 'plug', name: 'Vercel' },
  sentry: { icon: 'plug', name: 'Sentry' },
  atlassian: { icon: 'plug', name: 'Jira' },
  jira: { icon: 'plug', name: 'Jira' },
};

const base = (p) => (p ? String(p).split(/[\\/]/).filter(Boolean).pop() : '');
const trim = (s, n = 60) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const humanize = (s) => {
  s = String(s || '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
};
const host = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return trim(u, 30); } };

function describe(tool, input) {
  tool = String(tool || 'Tool');
  input = input || {};

  if (tool.startsWith('mcp__')) {
    const [, server = '', ...rest] = tool.split('__');
    const key = server.toLowerCase();
    const hit = Object.keys(BRANDS).find((k) => key.includes(k));
    const name = hit ? BRANDS[hit].name : humanize(server.replace(/^claude[_-]?ai[_-]?/i, '')) || 'MCP';
    return { label: humanize(rest.join(' ')) || name, icon: hit ? BRANDS[hit].icon : 'plug', source: name };
  }

  switch (tool) {
    case 'Bash': {
      const cmd = String(input.command || '');
      const gh = /^\s*gh\s/.test(cmd);
      return {
        label: trim(input.description || cmd, 60) || 'Running a command',
        icon: gh ? 'github' : 'terminal',
        source: gh ? 'GitHub' : 'Terminal',
      };
    }
    case 'Read':
      return { label: 'Reading ' + (base(input.file_path) || 'a file'), icon: 'file', source: 'Files' };
    case 'Write':
      return { label: 'Writing ' + (base(input.file_path) || 'a file'), icon: 'edit', source: 'Files' };
    case 'Edit':
    case 'MultiEdit':
      return { label: 'Editing ' + (base(input.file_path) || 'a file'), icon: 'edit', source: 'Files' };
    case 'NotebookEdit':
      return { label: 'Editing ' + (base(input.notebook_path) || 'a notebook'), icon: 'edit', source: 'Files' };
    case 'Grep':
      return { label: `Searching for “${trim(input.pattern, 32)}”`, icon: 'search', source: 'Search' };
    case 'Glob':
      return { label: 'Finding ' + trim(input.pattern, 40), icon: 'search', source: 'Search' };
    case 'WebFetch':
      return { label: 'Reading ' + host(input.url), icon: 'web', source: 'Web' };
    case 'WebSearch':
      return { label: 'Searching the web for “' + trim(input.query, 36) + '”', icon: 'web', source: 'Web' };
    case 'Task':
    case 'Agent':
      return { label: trim(input.description, 60) || 'Running a subagent', icon: 'agent', source: 'Subagent' };
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return { label: 'Updating the plan', icon: 'plan', source: 'Plan' };
    case 'Skill':
      return { label: 'Using the ' + (input.skill || input.command || 'a') + ' skill', icon: 'skill', source: 'Skill' };
    default:
      return { label: humanize(tool), icon: 'tool', source: tool };
  }
}

module.exports = { describe };
