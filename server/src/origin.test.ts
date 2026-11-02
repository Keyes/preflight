import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { hostAllowed, originAllowed, requestAllowed } from './origin.js'

afterEach(() => {
  delete process.env.PREFLIGHT_ALLOWED_HOSTS
})

test('the app on this machine is let in, directly and through the dev server', () => {
  assert.ok(requestAllowed({ host: '127.0.0.1:3001' })) // curl, the command line tools
  assert.ok(requestAllowed({ host: 'localhost:5173', origin: 'http://localhost:5173' })) // the client, through Vite's proxy
  assert.ok(requestAllowed({ host: '[::1]:5180', origin: 'http://[::1]:5180' }))
  assert.ok(requestAllowed({ host: 'app.localhost:5173', origin: 'http://app.localhost:5173' }))
})

test('the app opened to the network by its address is let in', () => {
  assert.ok(requestAllowed({ host: '192.168.1.20:5173', origin: 'http://192.168.1.20:5173' }))
})

test('a website pointing its own name at this machine (DNS rebinding) is refused', () => {
  assert.equal(hostAllowed('rebind.evil.example:3001'), false)
  assert.equal(requestAllowed({ host: 'rebind.evil.example:3001', origin: 'http://rebind.evil.example:3001' }), false)
  assert.equal(hostAllowed(undefined), false)
})

test('a page on another site cannot send requests, not even from an IP address', () => {
  assert.equal(requestAllowed({ host: '127.0.0.1:3001', origin: 'https://evil.example' }), false)
  assert.equal(requestAllowed({ host: '127.0.0.1:3001', origin: 'http://203.0.113.7' }), false)
  assert.equal(requestAllowed({ host: 'localhost:5173', origin: 'http://localhost:8080' }), false) // another app on this machine
  assert.equal(originAllowed('null', '127.0.0.1:3001'), false) // sandboxed frames and files
})

test('host names for the network are let in only when listed in PREFLIGHT_ALLOWED_HOSTS', () => {
  const headers = { host: 'studio-mac.local:5173', origin: 'http://studio-mac.local:5173' }
  assert.equal(requestAllowed(headers), false)
  process.env.PREFLIGHT_ALLOWED_HOSTS = 'other.local, Studio-Mac.local'
  assert.ok(requestAllowed(headers))
})
