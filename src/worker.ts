import PostalMime from 'postal-mime'

type Env = {
  SEND_EMAIL: SendEmail
  TENANT_ID: string
  CENTRAL_API_BASE_URL: string
  PART1_TO_PART2_HMAC_SECRET: string
  PART1_TO_PART2_HMAC_SECRET_NEXT?: string
  PART2_TO_PART1_HMAC_SECRET: string
  PART2_TO_PART1_HMAC_SECRET_NEXT?: string
  ALLOWED_FROM_DOMAIN: string
}

const MAX_SKEW_SECONDS = 300

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function getHeader(req: Request, key: string): string {
  return req.headers.get(key) || ''
}

async function hmacHex(secret: string, input: string): Promise<string> {
  const enc = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(input))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function signPayload(secret: string, timestamp: string, rawBody: string): Promise<string> {
  return hmacHex(secret, `${timestamp}.${rawBody}`)
}

async function verifyAnySignature(secrets: string[], timestamp: string, rawBody: string, provided: string): Promise<boolean> {
  const candidates = secrets.map(s => s.trim()).filter(Boolean)
  for (const secret of candidates) {
    const expected = await signPayload(secret, timestamp, rawBody)
    if (expected === provided) return true
  }
  return false
}

function isFreshTimestamp(timestamp: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  return Math.abs(now - ts) <= MAX_SKEW_SECONDS
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T
}

function ensureFromDomain(fromAddress: string, allowedDomain: string): boolean {
  const normalized = fromAddress.trim().toLowerCase()
  const domain = allowedDomain.trim().toLowerCase()
  return normalized.endsWith(`@${domain}`)
}

async function verifyPart2Request(req: Request, env: Env, rawBody: string): Promise<boolean> {
  const ts = getHeader(req, 'X-Timestamp')
  const sig = getHeader(req, 'X-Signature')
  const tenant = getHeader(req, 'X-Tenant-Id')
  const keyVersion = getHeader(req, 'X-Key-Version').toLowerCase()
  if (!ts || !sig || !tenant) return false
  if (tenant !== env.TENANT_ID) return false
  if (!isFreshTimestamp(ts)) return false
  if (keyVersion === 'primary' && env.PART2_TO_PART1_HMAC_SECRET) {
    const expected = await signPayload(env.PART2_TO_PART1_HMAC_SECRET, ts, rawBody)
    return expected === sig
  }
  if (keyVersion === 'next' && env.PART2_TO_PART1_HMAC_SECRET_NEXT) {
    const expected = await signPayload(env.PART2_TO_PART1_HMAC_SECRET_NEXT, ts, rawBody)
    return expected === sig
  }
  return verifyAnySignature(
    [env.PART2_TO_PART1_HMAC_SECRET, env.PART2_TO_PART1_HMAC_SECRET_NEXT || ''],
    ts,
    rawBody,
    sig
  )
}

async function postToPart2(env: Env, path: string, payload: unknown): Promise<Response> {
  const rawBody = JSON.stringify(payload)
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const signingSecret = env.PART1_TO_PART2_HMAC_SECRET || env.PART1_TO_PART2_HMAC_SECRET_NEXT || ''
  const signingKeyVersion = env.PART1_TO_PART2_HMAC_SECRET ? 'primary' : 'next'
  const signature = await signPayload(signingSecret, timestamp, rawBody)
  const url = `${env.CENTRAL_API_BASE_URL.replace(/\/$/, '')}${path}`
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Id': env.TENANT_ID,
      'X-Timestamp': timestamp,
      'X-Signature': signature,
      'X-Key-Version': signingKeyVersion,
    },
    body: rawBody,
  })
}

async function handleInboundEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const parser = new PostalMime()
  const parsed = await parser.parse(message.raw)
  const payload = {
    event: 'part1.inbound.received',
    version: 'v1',
    tenantId: env.TENANT_ID,
    email: {
      from: message.from || parsed.from?.address || '',
      to: message.to || parsed.to?.[0]?.address || '',
      subject: parsed.subject || '',
      text: parsed.text || '',
      html: parsed.html || '',
      messageId: parsed.messageId || '',
      receivedAt: Date.now(),
      attachments: (parsed.attachments || []).map((att) => ({
        filename: att.filename || '',
        contentType: att.mimeType || '',
        size: att.content ? attachmentSize(att.content) : 0,
      })),
    },
  }
  const res = await postToPart2(env, '/api/ingest/inbound', payload)
  if (!res.ok) {
    console.error(`[Part1] Failed to deliver inbound event to part2. Status: ${res.status}`)
  }
}

type SendRequestBody = {
  from: string
  to: string[] | string
  subject: string
  text?: string
  html?: string
  cc?: string[] | string
  bcc?: string[] | string
  requestId?: string
}

function normalizeEmails(input: string[] | string | undefined): string[] {
  if (!input) return []
  if (Array.isArray(input)) return input.map((v) => v.trim()).filter(Boolean)
  return input.split(',').map((v) => v.trim()).filter(Boolean)
}

function attachmentSize(content: string | ArrayBuffer | Uint8Array): number {
  if (typeof content === 'string') return content.length
  if (content instanceof ArrayBuffer) return content.byteLength
  return content.byteLength
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    try {
      await handleInboundEmail(message, env)
    } catch (err) {
      console.error('[Part1] Inbound processing failed:', err)
    }
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/health' && req.method === 'GET') {
      return jsonResponse({
        success: true,
        service: 'skydreamemail-part1-worker',
        version: 'v1',
        tenantId: env.TENANT_ID,
        centralApiBaseUrl: env.CENTRAL_API_BASE_URL,
        allowedFromDomain: env.ALLOWED_FROM_DOMAIN,
        endpoints: {
          send: '/api/send',
        },
      })
    }

    if (url.pathname !== '/api/send' || req.method !== 'POST') {
      return jsonResponse({ error: 'Not Found' }, 404)
    }

    const rawBody = await req.text()
    const valid = await verifyPart2Request(req, env, rawBody)
    if (!valid) return jsonResponse({ error: 'Unauthorized' }, 401)

    let body: SendRequestBody
    try {
      body = parseJson<SendRequestBody>(rawBody)
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400)
    }

    const to = normalizeEmails(body.to)
    const cc = normalizeEmails(body.cc)
    const bcc = normalizeEmails(body.bcc)
    if (!body.from || to.length === 0 || !body.subject || (!body.text && !body.html)) {
      return jsonResponse({ error: 'from, to, subject and text/html are required' }, 400)
    }
    if (!ensureFromDomain(body.from, env.ALLOWED_FROM_DOMAIN)) {
      return jsonResponse({ error: 'Sender domain is not allowed' }, 400)
    }

    const requestId = body.requestId || crypto.randomUUID()
    const startedAt = Date.now()
    let status: 'sent' | 'failed' = 'sent'
    let errorMessage = ''

    try {
      await env.SEND_EMAIL.send({
        from: body.from,
        to,
        subject: body.subject,
        text: body.text,
        html: body.html,
        cc: cc.length ? cc : undefined,
        bcc: bcc.length ? bcc : undefined,
      })
    } catch (err: any) {
      status = 'failed'
      errorMessage = err?.message || 'unknown error'
    }

    const callbackPayload = {
      event: 'part1.outbound.result',
      version: 'v1',
      tenantId: env.TENANT_ID,
      requestId,
      result: {
        status,
        errorMessage,
        sentAt: Date.now(),
        durationMs: Date.now() - startedAt,
      },
      message: {
        from: body.from,
        to,
        subject: body.subject,
      },
    }
    const callbackRes = await postToPart2(env, '/api/ingest/send-result', callbackPayload)
    if (!callbackRes.ok) {
      console.error(`[Part1] Failed to deliver outbound result to part2. Status: ${callbackRes.status}`)
    }

    if (status === 'failed') {
      return jsonResponse({ success: false, requestId, error: errorMessage }, 500)
    }
    return jsonResponse({ success: true, requestId })
  },
}
