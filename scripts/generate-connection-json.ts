import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

type ConnectionJson = {
  accountId: string
  workerUrl: string
  apiToken: string
  zoneId?: string
  tenantId?: string
  centralApiBaseUrl?: string
  generatedAt: string
}

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag)
  if (idx === -1) return undefined
  return process.argv[idx + 1]
}

const accountId = argValue('--account-id') || process.env.CF_ACCOUNT_ID || ''
const workerUrl = argValue('--worker-url') || process.env.WORKER_URL || ''
const apiToken = argValue('--api-token') || process.env.CF_API_TOKEN || ''
const zoneId = argValue('--zone-id') || process.env.CF_ZONE_ID || ''
const tenantId = argValue('--tenant-id') || process.env.TENANT_ID || ''
const centralApiBaseUrl = argValue('--central-api-base-url') || process.env.CENTRAL_API_BASE_URL || ''
const outPath = argValue('--out') || 'testing/worker-connection.local.json'

if (!accountId || !workerUrl || !apiToken) {
  console.error(
    'Missing required values. Provide --account-id, --worker-url, --api-token or set CF_ACCOUNT_ID, WORKER_URL, CF_API_TOKEN.'
  )
  process.exit(1)
}

const payload: ConnectionJson = {
  accountId,
  workerUrl,
  apiToken,
  generatedAt: new Date().toISOString(),
}

if (zoneId) payload.zoneId = zoneId
if (tenantId) payload.tenantId = tenantId
if (centralApiBaseUrl) payload.centralApiBaseUrl = centralApiBaseUrl

const output = resolve(process.cwd(), outPath)
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

console.log(`Generated: ${output}`)
