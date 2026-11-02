// The bottom-row progress bar on surfaces that draw `Svg`, after savvy-progress's band
// (github.com/johnnyvizz/claude-kit, plugins/savvy-progress): a title, a dithered bar
// with a tick per task, a pill with the count, the percent and a crab that walks while
// the turn runs. The count comes from the agent's task list rather than a progress tool.

import type { Run } from '../types'

const ACCENT = '#8f8cf4'
const DONE = '#5fbf8f'
const FAILED = '#D0453F'
const CLAY = '#D97757'
const INK = '#1F1E1D'

export const BAR_H = 22
const TRACK_H = 16
const CELL = 3
const CRAB_W = 26
const CRAB_BOX = 30
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

// CJK, Hangul, fullwidth forms and emoji advance about 1em.
const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꥠ-꥿가-힣豈-﫿︰-﹏！-｠￠-￦\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u

// Rough advance of system UI text, in em; good enough to size the title's slot.
const charEm = (ch: string): number =>
  WIDE.test(ch) ? 1 : /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-Zmw@%]/.test(ch) ? 0.72 : 0.56

const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

// Deterministic noise so the dither does not shimmer between redraws.
const noise = (x: number, y: number): number => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

// Pixel Clawd, 24×18 on a 30×28 grid; legs step and the body bobs while `.run`.
const crab = (x: number, scale: number, isWalking: boolean): string => {
  const px = (cx: number, cy: number, w: number, h: number, c: string) =>
    `<rect x="${cx}" y="${cy}" width="${w}" height="${h}" fill="${c}"/>`
  const body = [px(7, 10, 16, 12, CLAY), px(3, 14, 4, 4, CLAY), px(23, 14, 4, 4, CLAY), px(9, 12, 2, 2, INK), px(19, 12, 2, 2, INK)]
  const la = [px(7, 22, 2, 4, CLAY), px(17, 22, 2, 4, CLAY)]
  const lb = [px(11, 22, 2, 4, CLAY), px(21, 22, 2, 4, CLAY)]
  return `<g transform="translate(${x},0) scale(${scale})" shape-rendering="crispEdges"><g class="${isWalking ? 'run' : ''}"><g class="bd">${body.join('')}</g><g class="la">${la.join('')}</g><g class="lb">${lb.join('')}</g></g></g>`
}

export type BarView = { title: string; label: string; percent: string; ratio: number }

// What the bar says: the open task as the title, `Tasks 2/4` in the pill.
export function barView(r: Run, fallbackTitle: string): BarView {
  const n = r.plan.length
  const done = r.plan.filter(p => p.status === 'completed').length
  const isFinished = r.status === 'finished'
  const ratio = n ? done / n : isFinished ? 1 : 0
  const open = r.plan.find(p => p.status === 'in_progress')?.content
  const title = open || (n && done === n ? r.plan[n - 1]?.content : '') || fallbackTitle || 'Agent'
  const label = isFinished && (!n || done === n) ? 'Done' : n ? `Tasks ${done}/${n}` : `${r.steps.length} steps`
  return { title, label, percent: `${Math.round(ratio * 100)}%`, ratio }
}

export function barSvg(r: Run, v: BarView, W: number): string {
  const n = r.plan.length
  const isLive = r.status === 'running' || r.status === 'paused'
  const isFinished = r.status === 'finished'
  const color = isFinished ? DONE : r.status === 'failed' ? FAILED : ACCENT
  // The title takes what it needs, up to 40% of the row; the bar takes the rest.
  const title = fitText(v.title, 13, Math.max(60, W * 0.4))
  const barX = Math.round(16 + textWidth(title, 13) + 12)
  const barW = Math.max(60, W - barX - 46 - CRAB_W)
  const fillW = Math.round(barW * v.ratio)
  // Started, not yet done: a faint second layer.
  const open = r.plan.filter(p => p.status === 'in_progress').length
  const runW = n ? Math.round((barW * Math.min(n, r.plan.filter(p => p.status === 'completed').length + open)) / n) : 0

  // Dithered fill: sparse at the start, dense toward the head.
  const cols = Math.floor(fillW / CELL)
  const rows = Math.floor(TRACK_H / CELL)
  const dots: string[] = []
  for (let c = 0; c < cols; c++) {
    const density = 0.35 + 0.6 * Math.pow(c / Math.max(1, cols), 1.2)
    for (let y = 0; y < rows; y++) {
      if (noise(c, y) < density) dots.push(`<rect class="t${Math.floor(noise(y, c) * 4)}" x="${c * CELL + 1}" y="${y * CELL + 1}" width="2" height="2"/>`)
    }
  }
  const faint: string[] = []
  for (let c = cols; c < Math.floor(runW / CELL); c++) {
    for (let y = 0; y < rows; y++) {
      if (noise(c + 7, y + 3) < 0.2) faint.push(`<rect class="t${Math.floor(noise(y + 5, c) * 4)}" x="${c * CELL + 1}" y="${y * CELL + 1}" width="1.7" height="1.7"/>`)
    }
  }
  const ticks: string[] = []
  for (let i = 1; i < n; i++) {
    const x = Math.round((barW * i) / n)
    if (x > fillW + 4) ticks.push(`<rect x="${x}" y="${TRACK_H / 2 - 4}" width="1.5" height="8" rx="0.75"/>`)
  }

  const pillW = Math.round(18 + v.label.length * 6.6)
  const pillX = Math.max(0, Math.min(barW - pillW, fillW - pillW))
  const y0 = (BAR_H - TRACK_H) / 2
  const slow = isFinished

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${BAR_H}" viewBox="0 0 ${W} ${BAR_H}">
<style>
.t{fill:#1f1f1f}.m{fill:#8a8a8a}.k{fill:#e4e4e2}.tk{fill:#b4b4b0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#2c2c2c}.tk{fill:#5a5a5a}}
.t0,.t1,.t2,.t3{animation:tw ${slow ? 3.2 : 2.2}s ease-in-out infinite}
.t1{animation-duration:${slow ? 3.8 : 2.8}s;animation-delay:-.7s}.t2{animation-duration:${slow ? 4.4 : 1.9}s;animation-delay:-1.3s}.t3{animation-duration:${slow ? 3.5 : 3.3}s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:${slow ? 0.8 : 0.3}}}
.run .la{animation:st .5s steps(1) infinite}.run .lb{animation:st .5s steps(1) infinite -.25s}
.run .bd{animation:bob .5s steps(1) infinite -.125s}
@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}
@media (prefers-reduced-motion: reduce){.t0,.t1,.t2,.t3,.run g{animation:none}}
</style>
<defs><clipPath id="c"><rect x="0" y="0" width="${barW}" height="${TRACK_H}" rx="${TRACK_H / 2}"/></clipPath></defs>
<circle cx="5" cy="${BAR_H / 2}" r="4" fill="${color}"/>
<text class="t" x="16" y="${BAR_H / 2 + 4.5}" font-family="${FONT}" font-size="13" font-weight="500">${xml(title)}</text>
<g transform="translate(${barX},${y0})">
<rect class="k" width="${barW}" height="${TRACK_H}" rx="${TRACK_H / 2}"/>
<g clip-path="url(#c)">
<g fill="${color}">${dots.join('')}</g>
<g fill="${color}" opacity="0.45">${faint.join('')}</g>
<g class="tk">${ticks.join('')}</g>
</g>
<rect x="${pillX}" width="${pillW}" height="${TRACK_H}" rx="${TRACK_H / 2}" fill="${color}"/>
<text x="${pillX + pillW / 2}" y="${TRACK_H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="#ffffff">${xml(v.label)}</text>
</g>
<text class="m" x="${W - CRAB_W - 6}" y="${BAR_H / 2 + 4.5}" text-anchor="end" font-family="${FONT}" font-size="12.5" font-variant-numeric="tabular-nums">${v.percent}</text>
${crab(W - CRAB_W + 1, 0.8, isLive)}
</svg>`
}
