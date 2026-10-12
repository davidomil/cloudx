import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { createForgeDiagnosticSnapshot } from './forge-snapshot.mjs';

describe('Forge diagnostic snapshot client', () => {
  const input = { serverUrl: 'http://127.0.0.1:3001', workerId: randomUUID(), attemptId: randomUUID(), specification: { kind: 'source-only', commitSha: 'a'.repeat(40) } };

  it('submits the source commit and active attempt to the trusted snapshot owner', async () => {
    const result = { path: '.cloudx/forge-snapshots/owned/source', kind: 'source-only', retentionPolicy: 'disposable' };
    const request = vi.fn(async () => ({ ok: true, json: async () => result }));
    expect(await createForgeDiagnosticSnapshot(input, request)).toEqual(result);
    expect(String(request.mock.calls[0][0])).toBe(`${input.serverUrl}/api/forge/workers/${input.workerId}/snapshots`);
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ ...input.specification, attemptId: input.attemptId });
    expect(request.mock.calls[0][1].headers.origin).toBe(input.serverUrl);
  });

  it('reports rejected ownership and validates connection identity before any request', async () => {
    const request = vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'Current attempt required' }) }));
    await expect(createForgeDiagnosticSnapshot(input, request)).rejects.toThrow('Current attempt required');
    for (const serverUrl of ['file:///tmp/server', 'http://user:password@localhost', 'http://localhost?token=value', 'http://localhost#fragment'])
      await expect(createForgeDiagnosticSnapshot({ ...input, serverUrl }, request)).rejects.toThrow('configured CloudX');
    for (const change of [{ attemptId: 'old' }, { workerId: 'a'.repeat(36) }])
      await expect(createForgeDiagnosticSnapshot({ ...input, ...change }, request)).rejects.toThrow('attempt IDs');
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    await expect(createForgeDiagnosticSnapshot(input, request)).rejects.toThrow('creation failed (503)');
  });

  it('prints the allocated snapshot result when invoked through the installed helper', async () => {
    let received;
    const result = { path: '.cloudx/forge-snapshots/owned/source', kind: 'repository', retentionPolicy: 'recover' };
    const server = http.createServer((request, response) => {
      const chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        received = { url: request.url, origin: request.headers.origin, body: JSON.parse(Buffer.concat(chunks).toString()) };
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result));
      });
    });
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const serverUrl = `http://127.0.0.1:${server.address().port}`;
      const specification = { ...input.specification, kind: 'repository' };
      const output = await promisify(execFile)(process.execPath, ['scripts/forge-snapshot.mjs', input.workerId, input.attemptId, JSON.stringify(specification)], { env: { ...process.env, CLOUDX_SERVER_URL: serverUrl } });
      expect(JSON.parse(output.stdout)).toEqual(result);
      expect(received).toEqual({ url: `/api/forge/workers/${input.workerId}/snapshots`, origin: serverUrl, body: { ...specification, attemptId: input.attemptId } });
      await expect(promisify(execFile)(process.execPath, ['scripts/forge-snapshot.mjs'])).rejects.toMatchObject({ stderr: expect.stringContaining('Usage: forge-snapshot.mjs') });
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});
