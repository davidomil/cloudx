#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { requestEnvironment } from './forge-container.mjs';

export async function createForgeDiagnosticSnapshot({ serverUrl, workerId, attemptId, specification }, request = requestEnvironment) {
  const server = new URL(serverUrl);
  if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password || server.search || server.hash) throw new Error('Use the configured CloudX server URL.');
  if (![workerId, attemptId].every(id => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id))) throw new Error('Current worker and attempt IDs are required.');
  const response = await request(new URL(`/api/forge/workers/${workerId}/snapshots`, server), {
    method: 'POST', headers: { 'content-type': 'application/json', origin: server.origin },
    body: JSON.stringify({ ...specification, attemptId }), signal: AbortSignal.timeout(65_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Diagnostic snapshot creation failed (${response.status}).`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 5) throw new Error('Usage: forge-snapshot.mjs WORKER_ID ATTEMPT_ID JSON_SPECIFICATION');
    const [workerId, attemptId, specification] = process.argv.slice(2);
    const result = await createForgeDiagnosticSnapshot({ serverUrl: process.env.CLOUDX_SERVER_URL, workerId, attemptId, specification: JSON.parse(specification) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
