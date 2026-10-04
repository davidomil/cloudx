#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import https from 'node:https';

export async function createForgeContainer({ serverUrl, workerId, attemptId, specification }, request = requestEnvironment) {
  const server = new URL(serverUrl);
  if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password || server.search || server.hash) throw new Error('Use the configured CloudX server URL.');
  if (![workerId, attemptId].every(id => typeof id === 'string' && /^[a-f0-9-]{36}$/u.test(id))) throw new Error('Current worker and attempt IDs are required.');
  const response = await request(new URL(`/api/forge/workers/${workerId}/resources`, server), {
    method: 'POST', headers: { 'content-type': 'application/json', origin: server.origin },
    body: JSON.stringify({ ...specification, attemptId }), signal: AbortSignal.timeout(65_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Resource creation failed (${response.status}).`);
  return result;
}

function requestEnvironment(url, options) {
  const transport = url.protocol === 'https:' ? https : http;
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  return new Promise((resolve, reject) => {
    const request = transport.request(url, { ...options, rejectUnauthorized: !loopback }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 1_000_000) request.destroy(new Error('Resource response exceeds 1 MB.'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const status = response.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      });
    });
    request.on('error', reject);
    request.end(options.body);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 5) throw new Error('Usage: forge-container.mjs WORKER_ID ATTEMPT_ID JSON_SPECIFICATION');
    const [workerId, attemptId, specification] = process.argv.slice(2);
    const result = await createForgeContainer({ serverUrl: process.env.CLOUDX_SERVER_URL, workerId, attemptId, specification: JSON.parse(specification) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
