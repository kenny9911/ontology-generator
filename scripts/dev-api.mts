// Local development API server for the Ontology Generator.
//
// On Vercel, `api/ontology-gen/index.ts` is served as a serverless function at
// `/api/ontology-gen`. This script reproduces that locally: a tiny HTTP server
// that adapts Node's request/response to the Vercel handler signature and
// invokes the same handler. Run via `tsx` (resolves the `.ts` sources and the
// `.js` import specifiers the handler uses). Started by `npm run dev:api`.

import 'dotenv/config'
import http from 'node:http'
import { URL } from 'node:url'
// tsx resolves this `.js` specifier to the on-disk `index.ts`.
import handler from '../api/ontology-gen/index.js'

const PORT = Number(process.env.API_PORT || 5111)

const server = http.createServer(async (nodeReq, nodeRes) => {
  const url = new URL(nodeReq.url || '/', `http://localhost:${PORT}`)

  if (!url.pathname.startsWith('/api/ontology-gen')) {
    nodeRes.statusCode = 404
    nodeRes.end('Not Found')
    return
  }

  // Collect the raw body; the handler's `bodyObject` JSON-parses strings.
  const chunks: Buffer[] = []
  for await (const chunk of nodeReq) chunks.push(chunk as Buffer)
  const rawBody = Buffer.concat(chunks).toString('utf8')

  // Build a Vercel-style query object (string | string[]).
  const query: Record<string, string | string[]> = {}
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key)
    query[key] = all.length > 1 ? all : all[0]
  }

  const req = {
    method: nodeReq.method,
    headers: nodeReq.headers,
    query,
    body: rawBody,
    url: nodeReq.url,
  }

  const res = {
    statusCode: 200,
    setHeader: (k: string, v: string | number | readonly string[]) => nodeRes.setHeader(k, v),
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(obj: unknown) {
      nodeRes.statusCode = this.statusCode
      nodeRes.setHeader('Content-Type', 'application/json')
      nodeRes.end(JSON.stringify(obj))
    },
    send(data: unknown) {
      nodeRes.statusCode = this.statusCode
      nodeRes.end(typeof data === 'string' ? data : JSON.stringify(data))
    },
    end(data?: unknown) {
      nodeRes.statusCode = this.statusCode
      nodeRes.end(data as never)
    },
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (handler as any)(req, res)
  } catch (err) {
    console.error('[dev-api] handler error:', err)
    if (!nodeRes.headersSent) {
      nodeRes.statusCode = 500
      nodeRes.setHeader('Content-Type', 'application/json')
      nodeRes.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }))
    }
  }
})

server.listen(PORT, () => {
  console.log(`[dev-api] Ontology Generator API → http://localhost:${PORT}/api/ontology-gen`)
})
