import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import worker from '../src/worker'

type CliOptions = Record<string, string | boolean>

type DevEnv = {
  SEND_EMAIL: {
    send(message: {
      from: string
      to: string[]
      cc?: string[]
      bcc?: string[]
      subject: string
      text?: string
      html?: string
    }): Promise<void>
  }
  TENANT_ID: string
  CENTRAL_API_BASE_URL: string
  PART1_TO_PART2_HMAC_SECRET: string
  PART1_TO_PART2_HMAC_SECRET_NEXT?: string
  PART2_TO_PART1_HMAC_SECRET: string
  PART2_TO_PART1_HMAC_SECRET_NEXT?: string
  ALLOWED_FROM_DOMAIN: string
}

const outDir = join(import.meta.dir, '..', '.dev-mailbox')
const inboundDir = join(outDir, 'inbound')
const outboundDir = join(outDir, 'outbound')
const callbacksDir = join(outDir, 'callbacks')

function parseArgs(argv: string[]): { command: string; options: CliOptions } {
  const [command = 'all', ...rest] = argv
  const options: CliOptions = {}
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = rest[i + 1]
    if (!next || next.startsWith('--')) {
      options[key] = true
    } else {
      options[key] = next
      i++
    }
  }
  return { command, options }
}

function option(options: CliOptions, key: string, fallback: string): string {
  const value = options[key]
  return typeof value === 'string' && value.trim() ? value : fallback
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9@._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'message'
}

function makeEml(input: { from: string; to: string; subject: string; text: string }): string {
  return [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Message-ID: <dev-${crypto.randomUUID()}@local.test>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    input.text,
    '',
  ].join('\r\n')
}

async function hmacHex(secret: string, input: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(input))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function ensureDirs(): Promise<void> {
  await Promise.all([mkdir(inboundDir, { recursive: true }), mkdir(outboundDir, { recursive: true }), mkdir(callbacksDir, { recursive: true })])
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function writeOutboundMessage(message: {
  from: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  text?: string
  html?: string
}): Promise<void> {
  const base = `${stamp()}-${safeName(message.subject)}`
  const txt = [
    `From: ${message.from}`,
    `To: ${message.to.join(', ')}`,
    message.cc?.length ? `Cc: ${message.cc.join(', ')}` : '',
    message.bcc?.length ? `Bcc: ${message.bcc.join(', ')}` : '',
    `Subject: ${message.subject}`,
    '',
    message.text || '',
    message.html ? `\n[HTML]\n${message.html}` : '',
  ].filter(Boolean).join('\n')
  const eml = [
    `From: ${message.from}`,
    `To: ${message.to.join(', ')}`,
    message.cc?.length ? `Cc: ${message.cc.join(', ')}` : '',
    message.bcc?.length ? `Bcc: ${message.bcc.join(', ')}` : '',
    `Subject: ${message.subject}`,
    'MIME-Version: 1.0',
    message.html ? 'Content-Type: text/html; charset=utf-8' : 'Content-Type: text/plain; charset=utf-8',
    '',
    message.html || message.text || '',
    '',
  ].filter(Boolean).join('\r\n')

  await writeFile(join(outboundDir, `${base}.txt`), txt, 'utf8')
  await writeFile(join(outboundDir, `${base}.eml`), eml, 'utf8')
}

function makeEnv(): DevEnv {
  return {
    TENANT_ID: process.env.TENANT_ID || 'tenant-demo-001',
    CENTRAL_API_BASE_URL: process.env.CENTRAL_API_BASE_URL || 'http://part2.local',
    PART1_TO_PART2_HMAC_SECRET: process.env.PART1_TO_PART2_HMAC_SECRET || 'dev-part1-to-part2-secret',
    PART1_TO_PART2_HMAC_SECRET_NEXT: process.env.PART1_TO_PART2_HMAC_SECRET_NEXT || '',
    PART2_TO_PART1_HMAC_SECRET: process.env.PART2_TO_PART1_HMAC_SECRET || 'dev-part2-to-part1-secret',
    PART2_TO_PART1_HMAC_SECRET_NEXT: process.env.PART2_TO_PART1_HMAC_SECRET_NEXT || '',
    ALLOWED_FROM_DOMAIN: process.env.ALLOWED_FROM_DOMAIN || 'example.com',
    SEND_EMAIL: {
      async send(message) {
        await writeOutboundMessage(message)
      },
    },
  }
}

async function withCapturedCallbacks<T>(env: DevEnv, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    if (url.startsWith(env.CENTRAL_API_BASE_URL)) {
      const rawBody = typeof init?.body === 'string' ? init.body : ''
      const path = new URL(url).pathname.replace(/\//g, '_').replace(/^_/, '')
      const base = `${stamp()}-${path || 'callback'}`
      await writeJson(join(callbacksDir, `${base}.json`), {
        url,
        method: init?.method || 'GET',
        headers: Object.fromEntries(new Headers(init?.headers || {}).entries()),
        body: rawBody ? JSON.parse(rawBody) : null,
      })
      return new Response(JSON.stringify({ success: true, captured: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return originalFetch(input, init)
  }) as typeof fetch
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function runInbound(env: DevEnv, options: CliOptions): Promise<void> {
  const from = option(options, 'from', 'sender@example.net')
  const to = option(options, 'to', `inbox@${env.ALLOWED_FROM_DOMAIN}`)
  const subject = option(options, 'subject', 'Local inbound smoke test')
  const text = option(options, 'text', 'Hello from the local Part 1 inbound harness.')
  const emlPath = typeof options.eml === 'string' ? options.eml : ''
  const raw = emlPath ? await readFile(emlPath, 'utf8') : makeEml({ from, to, subject, text })
  const base = `${stamp()}-${safeName(subject)}`

  await writeFile(join(inboundDir, `${base}.eml`), raw, 'utf8')
  await writeFile(join(inboundDir, `${base}.txt`), text, 'utf8')

  await withCapturedCallbacks(env, async () => {
    await worker.email({
      from,
      to,
      raw: new Response(raw).body,
      headers: new Headers(),
      rawSize: raw.length,
      setReject() {},
      forward() { return Promise.resolve() },
      reply() { return Promise.resolve() },
    } as unknown as ForwardableEmailMessage, env as any)
  })

  console.log(`Inbound simulated. Files written to ${inboundDir}`)
  console.log(`Part 2 callback captured in ${callbacksDir}`)
}

async function runSend(env: DevEnv, options: CliOptions): Promise<void> {
  const body = {
    requestId: `dev-${crypto.randomUUID()}`,
    from: option(options, 'from', `noreply@${env.ALLOWED_FROM_DOMAIN}`),
    to: option(options, 'to', 'receiver@example.net').split(',').map((value) => value.trim()).filter(Boolean),
    subject: option(options, 'subject', 'Local outbound smoke test'),
    text: option(options, 'text', 'Hello from the local Part 1 outbound harness.'),
  }
  const rawBody = JSON.stringify(body)
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const signature = await hmacHex(env.PART2_TO_PART1_HMAC_SECRET, `${timestamp}.${rawBody}`)

  await withCapturedCallbacks(env, async () => {
    const response = await worker.fetch(new Request('http://part1.local/api/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': env.TENANT_ID,
        'X-Timestamp': timestamp,
        'X-Signature': signature,
        'X-Key-Version': 'primary',
      },
      body: rawBody,
    }), env as any)
    const result = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(`Send simulation failed with ${response.status}: ${JSON.stringify(result)}`)
    }
    console.log(`Send simulated. Worker response: ${JSON.stringify(result)}`)
  })

  console.log(`Outbound files written to ${outboundDir}`)
  console.log(`Part 2 callback captured in ${callbacksDir}`)
}

function printHelp(): void {
  console.log(`Part 1 local mailbox harness

Usage:
  bun run dev:mailbox inbound [--from sender@example.net] [--to inbox@example.com] [--subject "Test"] [--text "Hello"]
  bun run dev:mailbox inbound --eml ./sample.eml
  bun run dev:mailbox send [--from noreply@example.com] [--to receiver@example.net] [--subject "Test"] [--text "Hello"]
  bun run dev:mailbox all

Output:
  .dev-mailbox/inbound/*.eml|*.txt
  .dev-mailbox/outbound/*.eml|*.txt
  .dev-mailbox/callbacks/*.json
`)
}

await ensureDirs()
const { command, options } = parseArgs(Bun.argv.slice(2))
const env = makeEnv()

if (command === 'help' || options.help) {
  printHelp()
} else if (command === 'inbound') {
  await runInbound(env, options)
} else if (command === 'send') {
  await runSend(env, options)
} else if (command === 'all') {
  await runInbound(env, options)
  await runSend(env, options)
} else {
  printHelp()
  throw new Error(`Unknown command: ${command}`)
}
