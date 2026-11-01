// Pure helpers ported from hamzafer/claude-code-mods mods/review-watch/hooks/register.tsx:
// which commands and subagents are code reviews, their model, label, output file and findings.

// `codex review` where a command starts (after `;`, `&&`, `|`, `timeout 900` and the like), flags before `review` allowed.
// Also the Codex plugin's `/codex:review` and `/codex:adversarial-review`: `node .../codex-companion.mjs review`.
const CODEX_REVIEW =
  /(?:^|[;&|(])\s*(?:(?:timeout|nohup|nice|env|time|command)(?:\s+[-\w.=:]+)*\s+)?(?:(?:\S*\/)?codex(?:\s+-{1,2}[\w-]+(?:[\s=]+(?!-)\S+)?)*\s+review|(?:\S*\/)?node\s+(?:"[^"]*|'[^']*|\S*)\/codex-companion\.mjs["']?\s+(?:adversarial-)?review)(?=\s|$)/

export function isCodexReview(command: string) {
  return CODEX_REVIEW.test(command)
}

// A subagent whose description says review (not "preview" or "interview").
export function isReviewAgent(description: string) {
  return /\breview(?:s|er|ers|ing)?\b/i.test(description)
}

const TITLE = /--title(?:\s+|=)(?:(["'])(.*?)\1|([^\s"';&|<>]+))/

// The `codex ... review ...` part of a command, up to where the next command starts.
function codexPart(command: string) {
  const m = CODEX_REVIEW.exec(command)
  if (!m) return ''
  const rest = command.slice(m.index).replace(TITLE, '--title _')
  return rest.split(/\s*(?:&&|\|\||;|\|(?!&))\s*/)[0]!
}

export function modelOf(command: string) {
  const part = codexPart(command)
  return /\s-c\s+["']?model\s*=\s*\\?["']?([\w.:-]+)/.exec(part)?.[1] ?? /[\s"'](?:--model|-m)(?:\s+|=)["']?([\w.:-]+)/.exec(part)?.[1]
}

export function labelOf(command: string) {
  const title = titleOf(command)
  if (title) return title
  const part = codexPart(command)
  const commit = /--commit(?:\s+|=)["']?(\w+)/.exec(part)?.[1]
  if (commit) return `commit ${commit.slice(0, 7)}`
  const base = /--base(?:\s+|=)["']?([^\s"']+)/.exec(part)?.[1]
  return base ? `changes vs ${base}` : 'uncommitted changes'
}

function titleOf(command: string) {
  const m = TITLE.exec(command.slice(Math.max(0, command.search(CODEX_REVIEW))))
  return m ? (m[2] ?? m[3] ?? '') : ''
}

// The file the review's stdout goes to (`> file`): `~` from HOME, a relative one from a `cd` before it or the session's folder.
export function outputOf(command: string, cwd: string, home = '') {
  const at = Math.max(0, command.search(CODEX_REVIEW))
  const re = /(\d|&)?>>?\s*(["']?)([^\s"'&|;<>]+)\2/g
  const rest = command.slice(at).replace(TITLE, '--title _')
  for (const m of rest.matchAll(re)) {
    if (m[1] === '2' || m[3]!.startsWith('&')) continue
    let path = m[3]!
    if (path === '/dev/null' || path.includes('$')) return undefined
    if (path.startsWith('~/')) {
      if (!home) return undefined
      path = home + path.slice(1)
    }
    if (path.startsWith('/')) return path
    const cds = [...command.slice(0, at).matchAll(/(?:^|[;&|])\s*cd\s+(["']?)([^\s"';&|]+)\1/g)]
    const dir = cds.at(-1)?.[2]
    const base = dir ? (dir.startsWith('/') ? dir : dir.startsWith('~/') && home ? home + dir.slice(1) : `${cwd}/${dir}`) : cwd
    return base ? `${base}/${path}` : undefined
  }
  return undefined
}

// Codex ends with a "Full review comments:" block of `- [P2] title — file:line` items.
// Undefined when the output says neither (an error, a killed run, an unreadable file).
export function findingsOf(text: string): string[] | undefined {
  const at = text.lastIndexOf('Full review comments:')
  if (at >= 0) return [...text.slice(at).matchAll(/^\s*-\s*\[(P\d)\]/gm)].map(m => m[1]!)
  if (/\b(?:no (?:issues|findings|problems|bugs)|did not (?:find|identify)|didn't (?:find|identify)|looks good)\b/i.test(text.slice(-3000))) return []
  return undefined
}

export function findingsText(findings: string[]) {
  if (findings.length === 0) return 'no findings'
  return `${findings.length} finding${findings.length === 1 ? '' : 's'} (${findings.join(', ')})`
}

