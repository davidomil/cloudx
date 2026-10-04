import { describe, expect, it, vi } from 'vitest';
import { createForgeContainer } from './forge-container.mjs';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { promisify } from 'node:util';

describe('Forge container creation client', () => {
  const input = { serverUrl: 'http://127.0.0.1:3001', workerId: 'a'.repeat(36), attemptId: 'b'.repeat(36), specification: { image: 'ubuntu:24.04', name: 'test', command: ['true'] } };
  it('submits the pinned worker attempt with the configured trusted origin', async () => {
    const request = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'resource' }) }));
    expect(await createForgeContainer(input, request)).toEqual({ id: 'resource' });
    expect(String(request.mock.calls[0][0])).toBe(`http://127.0.0.1:3001/api/forge/workers/${input.workerId}/resources`);
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ ...input.specification, attemptId: input.attemptId });
    expect(request.mock.calls[0][1].headers.origin).toBe(input.serverUrl);
  });
  it('reports rejected ownership and invalid server/attempt input without host actions', async () => {
    const request = vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'Current attempt required' }) }));
    await expect(createForgeContainer(input, request)).rejects.toThrow('Current attempt required');
    await expect(createForgeContainer({ ...input, serverUrl: 'http://user:password@localhost' }, request)).rejects.toThrow('configured CloudX');
    await expect(createForgeContainer({ ...input, attemptId: 'old' }, request)).rejects.toThrow('attempt IDs');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('forwards specifically named evidence and its tested commit to the lifecycle owner', async () => {
    const specification = { ...input.specification, retentionReason: 'Regression log', evidencePaths: ['/work/evidence/test.log'], commitSha: 'c'.repeat(40) };
    const request = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'resource' }) }));
    await createForgeContainer({ ...input, specification }, request);
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ ...specification, attemptId: input.attemptId });
  });
  it('uses the configured loopback HTTPS installation and its self-signed certificate', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudx-container-https-'));
    const key = path.join(directory, 'key.pem'), certificate = path.join(directory, 'certificate.pem');
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate, '-subj', '/CN=localhost', '-days', '1']);
    let received;
    const server = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(certificate) }, (request, response) => {
      const chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => { received = JSON.parse(Buffer.concat(chunks).toString()); response.writeHead(201, { 'content-type': 'application/json' }); response.end('{"id":"owned"}'); });
    });
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      expect(await createForgeContainer({ ...input, serverUrl: `https://127.0.0.1:${server.address().port}` })).toEqual({ id: 'owned' });
      expect(received).toEqual({ ...input.specification, attemptId: input.attemptId });
    } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); }
  });
});
