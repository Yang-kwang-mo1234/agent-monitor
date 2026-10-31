import { expect, test } from 'claude-code/testing'

import { NO_CACHE, addUsage, cacheLine, forecast, sparkline, trend, ttlFromTranscript } from '../hooks/meters'

const usage = (read: number, written: number, input = 10) => ({
  input_tokens: input,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: written,
})

test('the cache line counts down, then reads cold with the re-cache size', async () => {
  let c = addUsage(NO_CACHE, usage(0, 50_000), 0)
  c = addUsage(c, usage(50_000, 2_000), 60_000)
  c = addUsage(c, usage(0, 52_000), 120_000) // a miss
  expect(c.misses).toBe(1)

  const warm = cacheLine(c, '5m', 120_000 + 30_000)!
  expect(warm.isWarm).toBe(true)
  expect(warm.head).toBe('● 5m · 4:30 left')
  expect(warm.details).toEqual(['hit 32%', 'misses 1'])
  expect(warm.color).toBe('green')

  expect(cacheLine(c, '5m', 120_000 + 4.5 * 60_000)!.color).toBe('yellow')

  const cold = cacheLine(c, '5m', 120_000 + 6 * 60_000)!
  expect(cold.isWarm).toBe(false)
  expect(cold.details).toEqual(['next message re-caches 52k tokens'])
  expect(cacheLine(NO_CACHE, '5m', 0)).toBe(null)
})

test('the forecast, sparkline and trend follow token-weather', async () => {
  expect(forecast(10).word).toBe('Clear')
  expect(forecast(80).word).toBe('Storm')
  expect(forecast(95).word).toBe('Compact soon')
  expect(sparkline([10, 20, 40])).toBe('▂▄█')
  expect(trend([10_000, 25_000])).toBe('▲ +15k last turn')
  expect(trend([25_000, 25_000])).toBe('steady')
})

test('the cache lifetime is read from the last main-thread response', async () => {
  const line = (o: object) => JSON.stringify(o)
  const text = [
    line({ type: 'assistant', message: { usage: { cache_creation: { ephemeral_5m_input_tokens: 9 } } } }),
    line({ type: 'assistant', message: { usage: { cache_creation: { ephemeral_1h_input_tokens: 5 } } } }),
    line({ type: 'assistant', isSidechain: true, message: { usage: { cache_creation: { ephemeral_5m_input_tokens: 3 } } } }),
  ].join('\n')
  expect(ttlFromTranscript(text)).toBe('1h')
  expect(ttlFromTranscript('')).toBe(null)
})
