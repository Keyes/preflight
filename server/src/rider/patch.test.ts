import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkPatch, parsePatchLines } from './patch.js'

// Two records to a line, as a typical printed patch table is laid out (left block, right block). Made-up values.
const LINES = [
  '   Universum 1                    14.03.26 Patch Example Hall - Console Tourpack',
  '#1   1   House<<   Dim   LX1      #201   40   Zoom1   9Ch. SSP, Example Zoom Wash 60   LX1',
  '#301   120   Strobe 1   4ch.  Flash 2000   LX1      #234   210   Front   3   4Ch. RGBW, Example PAR 25°   LX3',
  '#302   130   Strobe 2   2ch. (1.speed,2.dim)   LX2',
  '#326   60   Mirror ball motor   1ch. (default 50%)   LX3/4      #101   300   Spot 1   19Ch., Example Spot 300   LX1',
  '#331   170   Effect LED   4ch. FX-200 (1.dim,2.colwheel,3.shut,4.function)   LX3',
  '#501   380   Batten 150   Wash   LX2',
]

test('reads both blocks of a line and the table date', () => {
  const { rows, date, issues } = parsePatchLines(LINES)
  assert.equal(rows.length, 9)
  assert.equal(date, '2026-03-14')
  assert.deepEqual(issues, [])
  assert.deepEqual(rows[0], { fixId: '#1', universe: 1, address: 1, name: 'House<<', modeRaw: 'Dim', mode: 'Dim', channels: 1, truss: 'LX1' })
})

test('splits the mode column into mode, fixture and note', () => {
  const by = Object.fromEntries(parsePatchLines(LINES).rows.map((r) => [r.fixId, r]))
  assert.deepEqual([by['#201'].mode, by['#201'].typeHint, by['#201'].channels], ['9Ch. SSP', 'Example Zoom Wash 60', 9])
  assert.deepEqual([by['#301'].mode, by['#301'].typeHint], ['4ch.', 'Flash 2000'])
  assert.deepEqual([by['#302'].mode, by['#302'].typeHint, by['#302'].modeNote], ['2ch.', undefined, '1.speed,2.dim'])
  assert.deepEqual([by['#331'].mode, by['#331'].typeHint, by['#331'].modeNote], ['4ch.', 'FX-200', '1.dim,2.colwheel,3.shut,4.function'])
  assert.deepEqual([by['#101'].mode, by['#101'].typeHint, by['#101'].channels], ['19Ch.', 'Example Spot 300', 19])
  assert.equal(by['#501'].channels, undefined)
})

test('keeps spaces inside a name and a truss like LX3/4', () => {
  const by = Object.fromEntries(parsePatchLines(LINES).rows.map((r) => [r.fixId, r]))
  assert.equal(by['#234'].name, 'Front 3')
  assert.equal(by['#326'].truss, 'LX3/4')
})

test('reports a row it cannot read', () => {
  const { rows, issues } = parsePatchLines(['#9   9   Broken row without a mode'])
  assert.equal(rows.length, 0)
  assert.equal(issues.length, 1)
})

test('checkPatch finds a repeated number and an overlap, and allows one address shared', () => {
  const row = (fixId: string, address: number, channels = 4) => ({ fixId, universe: 1, address, name: fixId, modeRaw: '', mode: '', channels, truss: 'LX1' })
  assert.deepEqual(checkPatch([row('#1', 1), row('#2', 5)]), [])
  assert.deepEqual(checkPatch([row('#1', 1), row('#2', 1)]), [])
  assert.equal(checkPatch([row('#1', 1), row('#2', 3)]).length, 1)
  assert.equal(checkPatch([row('#1', 1), row('#1', 9)]).length, 1)
  assert.equal(checkPatch([row('#1', 510)]).length, 1)
})
