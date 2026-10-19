/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { build } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionImageLoader } from './session-image-loader';
import type { SessionImagesRequest } from './session-images';
import type { SessionSource } from './cache';

class FakeWorker extends EventEmitter {
  requests: SessionImagesRequest[] = [];
  terminate = vi.fn(() => Promise.resolve(0));
  unref(): void {}
  postMessage(request: SessionImagesRequest): void {
    this.requests.push(request);
  }
}

const source: SessionSource = {
  kind: 'cli-events', filePath: 'events.jsonl', workspaceId: 'ws', workspaceName: 'Workspace', harness: 'Copilot',
};
const loaders: SessionImageLoader[] = [];

afterEach(() => {
  for (const loader of loaders.splice(0)) loader.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('image worker lifecycle', () => {
  it('serializes image jobs and reuses one worker across requests', async () => {
    const worker = new FakeWorker();
    const create = vi.fn(() => worker);
    const loader = new SessionImageLoader(create);
    loaders.push(loader);
    const first = loader.load(source, 'session', 'first');
    const second = loader.load(source, 'session', 'second');
    await Promise.resolve();
    expect(worker.requests.map(request => request.requestId)).toEqual(['first']);
    worker.emit('message', { type: 'session-images', images: ['data:image/png;base64,first'] });
    expect(await first).toEqual(['data:image/png;base64,first']);
    await Promise.resolve();
    expect(worker.requests.map(request => request.requestId)).toEqual(['first', 'second']);
    worker.emit('message', { type: 'session-images', images: [] });
    expect(await second).toEqual([]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('surfaces worker failures and allows the next request to restart the worker', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const workers: FakeWorker[] = [];
    const loader = new SessionImageLoader(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    loaders.push(loader);
    const first = loader.load(source, 'session', 'first');
    const rejected = expect(first).rejects.toThrow('read failed');
    await Promise.resolve();
    workers[0].emit('message', { type: 'error', message: 'read failed' });
    await rejected;
    const next = loader.load(source, 'session', 'next');
    await Promise.resolve();
    workers[1].emit('message', { type: 'session-images', images: [] });
    expect(await next).toEqual([]);
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it('terminates idle workers and timed-out jobs', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const worker = new FakeWorker();
    const loader = new SessionImageLoader(() => worker);
    loaders.push(loader);
    const result = loader.load(source, 'session', 'first');
    await Promise.resolve();
    worker.emit('message', { type: 'session-images', images: [] });
    await result;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    const pending = loader.load(source, 'session', 'next');
    const rejected = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(120_000);
    await rejected;
    expect(worker.terminate).toHaveBeenCalledTimes(2);
  });

  it('extracts images through the real bundled parse-worker protocol', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-image-worker-'));
    try {
      const workerPath = path.join(directory, 'parse-worker.cjs');
      await build({
        entryPoints: [path.resolve('src', 'core', 'parse-worker.ts')],
        outfile: workerPath, bundle: true, platform: 'node', format: 'cjs',
      });
      const base64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
      const events = path.join(directory, 'events.jsonl');
      fs.writeFileSync(events, [
        { type: 'session.start', data: { sessionId: 'session' } },
        { type: 'user.message', id: 'user', data: { content: 'Screenshot', variables: [{ kind: 'image', data: [...Buffer.from(base64, 'base64')] }] } },
        { type: 'assistant.message', id: 'answer', data: { content: 'Done' } },
      ].map(event => JSON.stringify(event)).join('\n'));
      const loader = new SessionImageLoader(() => new Worker(workerPath, { execArgv: [] }));
      loaders.push(loader);
      expect(await loader.load({ ...source, filePath: events }, 'session', 'answer')).toEqual([`data:image/png;base64,${base64}`]);
      expect(await loader.load({ ...source, filePath: events }, 'session', 'unknown')).toEqual([]);
      loader.dispose();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
