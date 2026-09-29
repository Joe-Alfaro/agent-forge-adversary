// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { resolveAuthConfig, SESSION_COOKIE, withOperatorAuth } from '../auth.js'

const config = {
  username: 'operator',
  password: 'correct horse battery staple',
  sessionSecret: 'test-secret',
  secureCookie: false,
  sessionTtlSeconds: 3600,
}

const BASE = 'http://dash.test'

function appHandler(request: Request) {
  return Promise.resolve(new Response(`app:${new URL(request.url).pathname}`))
}

const gate = withOperatorAuth(config, appHandler)

function loginRequest(fields: Record<string, string>) {
  return new Request(`${BASE}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })
}

function cookieFrom(response: Response) {
  const header = response.headers.get('set-cookie') ?? ''
  return header.split(';')[0] ?? ''
}

async function signIn() {
  const response = await gate(loginRequest({ username: 'operator', password: config.password }))
  return cookieFrom(response)
}

describe('resolveAuthConfig', () => {
  it('reads the shared operator login', () => {
    expect(resolveAuthConfig({ OPERATOR_USERNAME: 'sec', OPERATOR_PASSWORD: 'pw', NODE_ENV: 'production' })).toMatchObject({
      username: 'sec',
      password: 'pw',
      secureCookie: true,
    })
  })

  it('defaults the username to operator', () => {
    expect(resolveAuthConfig({ OPERATOR_PASSWORD: 'pw' })?.username).toBe('operator')
  })

  it('refuses to run in production without a password', () => {
    expect(() => resolveAuthConfig({ NODE_ENV: 'production' })).toThrow('OPERATOR_PASSWORD')
  })

  it('disables the gate for local development without a password', () => {
    expect(resolveAuthConfig({ NODE_ENV: 'development' })).toBeNull()
  })
})

describe('withOperatorAuth', () => {
  it('redirects a signed-out page view to the login form, keeping the destination', async () => {
    const response = await gate(new Request(`${BASE}/findings?status=open`, { headers: { accept: 'text/html' } }))
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/login?next=%2Ffindings%3Fstatus%3Dopen')
  })

  it('rejects signed-out API and server-function calls with 401', async () => {
    const response = await gate(new Request(`${BASE}/_serverFn/abc`, { method: 'POST' }))
    expect(response.status).toBe(401)
  })

  it('serves the login form', async () => {
    const response = await gate(new Request(`${BASE}/login?next=%2Fcost`))
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('name="password"')
    expect(html).toContain('value="/cost"')
  })

  it('rejects a wrong password without setting a cookie', async () => {
    const response = await gate(loginRequest({ username: 'operator', password: 'nope' }))
    expect(response.status).toBe(401)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(await response.text()).toContain('Wrong username or password')
  })

  it('rejects a wrong username', async () => {
    const response = await gate(loginRequest({ username: 'admin', password: config.password }))
    expect(response.status).toBe(401)
  })

  it('signs in and lets the session through', async () => {
    const response = await gate(loginRequest({ username: 'operator', password: config.password, next: '/runs' }))
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/runs')
    const setCookie = response.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(`${SESSION_COOKIE}=`)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')

    const page = await gate(new Request(`${BASE}/runs`, { headers: { cookie: cookieFrom(response) } }))
    expect(await page.text()).toBe('app:/runs')
  })

  it('never redirects off-site after login', async () => {
    const response = await gate(loginRequest({ username: 'operator', password: config.password, next: '//evil.test/x' }))
    expect(response.headers.get('location')).toBe('/')
  })

  it('rejects a tampered or foreign session cookie', async () => {
    const cookie = await signIn()
    const tampered = `${cookie.slice(0, -2)}xx`
    const response = await gate(new Request(`${BASE}/_serverFn/abc`, { method: 'POST', headers: { cookie: tampered } }))
    expect(response.status).toBe(401)

    const otherGate = withOperatorAuth({ ...config, sessionSecret: 'other' }, appHandler)
    const foreign = await otherGate(new Request(`${BASE}/_serverFn/abc`, { method: 'POST', headers: { cookie } }))
    expect(foreign.status).toBe(401)
  })

  it('rejects an expired session', async () => {
    const shortGate = withOperatorAuth({ ...config, sessionTtlSeconds: -1 }, appHandler)
    const response = await shortGate(loginRequest({ username: 'operator', password: config.password }))
    const page = await shortGate(
      new Request(`${BASE}/_serverFn/abc`, { method: 'POST', headers: { cookie: cookieFrom(response) } }),
    )
    expect(page.status).toBe(401)
  })

  it('signs out by clearing the cookie', async () => {
    const response = await gate(new Request(`${BASE}/logout`, { method: 'POST' }))
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/login')
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  it('answers the health check without a session', async () => {
    const response = await gate(new Request(`${BASE}/healthz`))
    expect(response.status).toBe(200)
  })

  it('passes everything through when the gate is disabled', async () => {
    const open = withOperatorAuth(null, appHandler)
    expect(await (await open(new Request(`${BASE}/cost`))).text()).toBe('app:/cost')
  })
})
