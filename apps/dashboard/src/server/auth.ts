import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Single shared operator login for the sprint (ARCHITECTURE.md Section 15.1):
 * environment-variable credentials behind a signed session cookie. The gate
 * wraps the whole Start handler, so pages and server functions are covered.
 */
export interface AuthConfig {
  username: string
  password: string
  /** HMAC key for session cookies. Rotating it (or the password) signs everyone out. */
  sessionSecret: string
  secureCookie: boolean
  sessionTtlSeconds: number
}

export const SESSION_COOKIE = 'af_session'
const DEFAULT_TTL_SECONDS = 12 * 60 * 60

type Env = NodeJS.ProcessEnv
type Handler = (request: Request) => Response | Promise<Response>

/**
 * Returns null (gate off) only outside production with no password set, so
 * `npm run dev` keeps working. Production without a password refuses to start.
 */
export function resolveAuthConfig(env: Env): AuthConfig | null {
  const production = env.NODE_ENV === 'production'
  const password = env.OPERATOR_PASSWORD
  if (!password) {
    if (production) {
      throw new Error('OPERATOR_PASSWORD is not set. The dashboard will not serve findings without a login.')
    }
    return null
  }
  return {
    username: env.OPERATOR_USERNAME || 'operator',
    password,
    sessionSecret: env.SESSION_SECRET || createHmac('sha256', password).update('agentforge-session').digest('hex'),
    secureCookie: production,
    sessionTtlSeconds: DEFAULT_TTL_SECONDS,
  }
}

function sign(config: AuthConfig, expiresAt: number) {
  return createHmac('sha256', config.sessionSecret).update(`${config.username}:${expiresAt}`).digest('base64url')
}

function safeEqual(a: string, b: string) {
  // Hash both sides so the comparison is constant-time regardless of length.
  const digest = (value: string) => createHmac('sha256', 'compare').update(value).digest()
  return timingSafeEqual(digest(a), digest(b))
}

function readCookie(request: Request, name: string) {
  const header = request.headers.get('cookie') ?? ''
  const match = header
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
  return match?.slice(name.length + 1)
}

function hasValidSession(config: AuthConfig, request: Request) {
  const value = readCookie(request, SESSION_COOKIE)
  if (!value) {
    return false
  }
  const [expiry, signature] = value.split('.')
  const expiresAt = Number(expiry)
  if (!signature || !Number.isInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
    return false
  }
  return safeEqual(signature, sign(config, expiresAt))
}

function sessionCookie(config: AuthConfig, value: string, maxAge: number) {
  const secure = config.secureCookie ? '; Secure' : ''
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

/** Only same-site paths, so the login form cannot be used as an open redirect. */
function safeNext(raw: FormDataEntryValue | string | null | undefined) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) {
    return '/'
  }
  return raw
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}

function loginPage(next: string, error?: string, status = 200) {
  const errorHtml = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · AgentForge</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f9;color:#1c2430;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
form{background:#fff;border:1px solid #dde1e6;border-radius:8px;padding:28px;width:320px;display:grid;gap:12px}
h1{margin:0;font-size:1.2rem}p{margin:0;color:#667085;font-size:.9rem}
label{display:grid;gap:4px;font-size:.9rem}input{padding:8px;border:1px solid #dde1e6;border-radius:6px;font:inherit}
button{padding:9px;border:0;border-radius:6px;background:#3b5bdb;color:#fff;font:inherit;cursor:pointer}
.error{color:#b42318}
</style>
</head>
<body>
<form method="post" action="/login">
<h1>AgentForge</h1>
<p>Operator dashboard sign-in</p>
${errorHtml}
<input type="hidden" name="next" value="${escapeHtml(next)}">
<label>Username<input name="username" autocomplete="username" required autofocus></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">Sign in</button>
</form>
</body>
</html>`
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function redirect(location: string, setCookie?: string) {
  const headers = new Headers({ location, 'cache-control': 'no-store' })
  if (setCookie) {
    headers.set('set-cookie', setCookie)
  }
  return new Response(null, { status: 303, headers })
}

async function handleLogin(config: AuthConfig, request: Request) {
  const form = await request.formData().catch(() => new FormData())
  const next = safeNext(form.get('next'))
  const username = String(form.get('username') ?? '')
  const password = String(form.get('password') ?? '')
  // Evaluate both so a wrong username takes as long as a wrong password.
  const userOk = safeEqual(username, config.username)
  const passwordOk = safeEqual(password, config.password)
  if (!userOk || !passwordOk) {
    return loginPage(next, 'Wrong username or password.', 401)
  }
  const expiresAt = Math.floor(Date.now() / 1000) + config.sessionTtlSeconds
  const value = `${expiresAt}.${sign(config, expiresAt)}`
  return redirect(next, sessionCookie(config, value, config.sessionTtlSeconds))
}

function wantsHtml(request: Request) {
  return request.method === 'GET' && (request.headers.get('accept') ?? '').includes('text/html')
}

export function withOperatorAuth(config: AuthConfig | null, handler: Handler): Handler {
  return async function gatedHandler(request) {
    const url = new URL(request.url)
    if (url.pathname === '/healthz') {
      return new Response('ok', { headers: { 'cache-control': 'no-store' } })
    }
    if (!config) {
      return url.pathname === '/logout' ? redirect('/') : handler(request)
    }
    if (url.pathname === '/login') {
      return request.method === 'POST' ? handleLogin(config, request) : loginPage(safeNext(url.searchParams.get('next')))
    }
    if (url.pathname === '/logout') {
      return redirect('/login', sessionCookie(config, '', 0))
    }
    if (hasValidSession(config, request)) {
      return handler(request)
    }
    if (wantsHtml(request)) {
      return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`)
    }
    return new Response('Unauthorized', { status: 401, headers: { 'cache-control': 'no-store' } })
  }
}
