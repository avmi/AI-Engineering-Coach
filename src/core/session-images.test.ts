/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAllLogs } from './parser';
import { collectExternalHarnessesAsync } from './parser-harnesses';
import { parseCLIEventsFile, parseCLIEventsFileAsync } from './parser-vscode-cli';
import { parseClaudeSessions } from './parser-claude';
import { parseCodexSessions } from './parser-codex';
import { parseOpenCodeSessions } from './parser-opencode';
import { parseSessionFile, processWorkspaceEntryAsync } from './parser-vscode';
import { extractSourceImages, loadSourceSession } from './session-images';
import { Analyzer } from './analyzer';
import type { SessionSource } from './cache';
import { loadSessionFromDisk, setMemoryCache } from './cache';
import type { ParseContext } from './parser-shared';

const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const image = `data:image/png;base64,${base64}`;
const timestamp = '2026-10-19T10:00:00Z';
let root: string;
let sources: Map<string, SessionSource>;

function write(file: string, value: unknown): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function jsonl(file: string, lines: unknown[]): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n'));
  return file;
}

function claudeUser(id: string, content: unknown[], sessionId = 'claude-session'): object {
  return { type: 'user', uuid: id, sessionId, timestamp, cwd: root, message: { role: 'user', content } };
}

function claudeImage(): object {
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } };
}

function makeClaude(): string {
  return jsonl(path.join(root, '.claude', 'projects', 'project', 'claude-session.jsonl'), [
    claudeUser('claude-image', [claudeImage()]),
  ]);
}

function makeCodex(): string {
  return jsonl(path.join(root, '.codex', 'sessions', 'rollout.jsonl'), [
    { type: 'session_meta', payload: { id: 'codex-session', cwd: root } },
    { type: 'event_msg', timestamp, payload: { type: 'user_message', message: 'Screenshot', images: [image] } },
    { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'Screenshot' }, { type: 'input_image', image_url: image },
    ] } },
    { type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'First answer' }] } },
    { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: image }] } },
  ]);
}

function makeOpenCodeStorage(): string {
  const storage = path.join(root, '.local', 'share', 'opencode', 'storage');
  write(path.join(storage, 'session', 'global', 'oc-session.json'), { id: 'oc-session', directory: root });
  write(path.join(storage, 'message', 'oc-session', 'oc-user.json'), {
    id: 'oc-user', sessionID: 'oc-session', role: 'user', time: { created: Date.parse(timestamp) },
  });
  write(path.join(storage, 'part', 'oc-user', 'part-image.json'), {
    id: 'part-image', messageID: 'oc-user', type: 'file', mime: 'image/png', url: image,
  });
  return storage;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-session-images-'));
  sources = new Map();
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.stubEnv('XDG_DATA_HOME', path.join(root, '.local', 'share'));
  vi.stubEnv('LOCALAPPDATA', path.join(root, 'local-appdata'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('harness-aware image loading', () => {
  it.each([
    ['Code', 'Local Agent'],
    ['Code - Insiders', 'Local Agent (Insiders)'],
    ['.vscode-server', 'Local Agent (Server)'],
    ['.vscode-server-insiders', 'Local Agent (Server Insiders)'],
  ])('registers VS Code image sources in synchronous and asynchronous parsing: %s', async (edition, harness) => {
    const logsDir = path.join(root, edition, 'workspaceStorage');
    write(path.join(logsDir, 'ws', 'workspace.json'), { folder: pathToFileURL(root).href });
    write(path.join(logsDir, 'ws', 'chatSessions', 'session.json'), {
      sessionId: 'vscode', creationDate: Date.parse(timestamp), requests: [{
        requestId: 'vscode-user', timestamp: Date.parse(timestamp), message: { text: 'Screenshot' },
        variableData: { variables: [{ kind: 'image', data: [...Buffer.from(base64, 'base64')] }] },
      }],
    });
    const parsed = parseAllLogs([logsDir]);
    expect(parsed.sessions[0].harness).toBe(harness);
    expect(parsed.sessionSourceIndex.get('vscode')?.workspaceRootPath).toBe(root);
    expect(extractSourceImages(parsed.sessionSourceIndex.get('vscode')!, 'vscode', 'vscode-user')).toEqual([image]);
    const context: ParseContext = { sessions: [], workspaces: new Map(), editLocIndex: new Map(), sessionSourceIndex: sources, aiLoc: 0 };
    await processWorkspaceEntryAsync(logsDir, 'ws', harness, context);
    expect(extractSourceImages(sources.get('vscode')!, 'vscode', 'vscode-user')).toEqual([image]);
  });

  it.each([false, true])('matches Copilot user attachments to normalized assistant IDs (App=%s)', async app => {
    const file = path.join(root, 'screen.png');
    fs.writeFileSync(file, Buffer.from(base64, 'base64'));
    const events = jsonl(path.join(root, 'events.jsonl'), [
      { type: 'session.start', timestamp, data: { sessionId: 'copilot-session', ...(app ? { remoteSteerable: true } : {}) } },
      { type: 'user.message', id: 'user-event', timestamp, data: { content: 'Screenshot', attachments: [{ type: 'file', path: file }] } },
      { type: 'assistant.message', id: 'first-answer', timestamp, data: { content: 'Working' } },
      { type: 'assistant.message', id: 'last-answer', timestamp, data: { content: 'Done', phase: 'final' } },
      { type: 'user.message', id: 'plain-user', timestamp, data: { content: 'No image' } },
      { type: 'assistant.message', id: 'plain-answer', timestamp, data: { content: 'Text' } },
    ]);
    const source: SessionSource = { kind: 'cli-events', filePath: events, workspaceId: 'ws', workspaceName: 'Workspace', harness: 'Copilot' };
    for (const session of [parseCLIEventsFile(events, 'ws', 'Workspace'), await parseCLIEventsFileAsync(events, 'ws', 'Workspace')]) {
      expect(session?.requests.map(request => request.variableKinds.image ?? 0)).toEqual([1, 0]);
      expect(session?.requests[0]).toMatchObject({ requestId: 'last-answer', userEventId: 'user-event' });
    }
    expect(extractSourceImages(source, 'copilot-session', 'last-answer')).toEqual([image]);
    expect(extractSourceImages(source, 'copilot-session', 'plain-answer')).toEqual([]);
    expect(extractSourceImages(source, 'copilot-session', 'user-event')).toEqual([]);
  });

  it('supports Copilot image variables and generated IDs when no assistant event exists', () => {
    const file = jsonl(path.join(root, 'events.jsonl'), [
      { type: 'session.start', data: { sessionId: 'pending' } },
      { type: 'user.message', data: { content: '', variables: [{ kind: 'image', data: [...Buffer.from(base64, 'base64')] }] } },
    ]);
    const source: SessionSource = { kind: 'cli-events', filePath: file, workspaceId: 'ws', workspaceName: 'WS', harness: 'Copilot' };
    const session = loadSourceSession(source, 'pending');
    expect(session?.requests[0].variableKinds.image).toBe(1);
    expect(extractSourceImages(source, 'pending', 'pending:cli:0')).toEqual([image]);
  });

  it('loads VS Code JSON and applies JSONL image patches before extraction', () => {
    const request = { requestId: 'vscode-user', message: { text: 'Screenshot' }, variableData: { variables: [] } };
    const variable = { kind: 'image', data: [...Buffer.from(base64, 'base64')] };
    const json = write(path.join(root, 'session.json'), { sessionId: 'vs-session', requests: [{ ...request, variableData: { variables: [variable] } }] });
    const patched = jsonl(path.join(root, 'session.jsonl'), [
      { kind: 0, v: { sessionId: 'vs-session', requests: [request] } },
      { kind: 1, k: ['requests', 0, 'variableData', 'variables'], v: [variable] },
    ]);
    fs.appendFileSync(patched, '\nmalformed line\n');
    for (const file of [json, patched]) {
      const source: SessionSource = { kind: 'vscode-session-file', filePath: file, workspaceId: 'ws', workspaceName: 'WS', harness: 'Local Agent' };
      expect(parseSessionFile(file, 'ws', 'WS', 'Local Agent')?.requests[0].variableKinds.image).toBe(1);
      expect(extractSourceImages(source, 'vs-session', 'vscode-user')).toEqual([image]);
      expect(extractSourceImages(source, 'vs-session', 'unknown')).toEqual([]);
    }
  });

  it('loads Claude image-only requests, merged subagents, and orphan subagent sources', () => {
    makeClaude();
    const project = path.join(root, '.claude', 'projects', 'project');
    jsonl(path.join(project, 'claude-session', 'subagents', 'agent-child.jsonl'), [
      claudeUser('child-image', [claudeImage()]),
    ]);
    jsonl(path.join(project, 'orphan', 'subagents', 'agent-orphan.jsonl'), [
      claudeUser('orphan-image', [claudeImage()], 'orphan'),
    ]);
    const results = parseClaudeSessions(path.dirname(project), undefined, sources);
    const sessions = results.flatMap(result => result.sessions);
    expect(sessions.find(session => session.sessionId === 'claude-session')?.requests).toHaveLength(2);
    expect(sources.get('claude-session')?.additionalFilePaths).toHaveLength(1);
    for (const [sessionId, requestId] of [['claude-session', 'claude-image'], ['claude-session', 'child-image'], ['orphan', 'orphan-image']]) {
      const source = sources.get(sessionId)!;
      expect(extractSourceImages(source, sessionId, requestId)).toEqual([image]);
      expect(loadSourceSession(source, sessionId)?.requests.some(request => request.requestId === requestId)).toBe(true);
      expect(extractSourceImages(source, sessionId, 'unknown')).toEqual([]);
    }
  });

  it('counts Codex mirrors once and matches successive image-only response items', () => {
    makeCodex();
    const session = parseCodexSessions(path.join(root, '.codex', 'sessions'), undefined, sources)[0];
    expect(session.requests.map(request => request.variableKinds.image)).toEqual([1, 1]);
    const source = sources.get(session.sessionId)!;
    for (const request of session.requests) expect(extractSourceImages(source, session.sessionId, request.requestId)).toEqual([image]);
    expect(extractSourceImages(source, session.sessionId, 'unknown')).toEqual([]);
  });

  it('does not merge consecutive Codex image-only requests without an intervening assistant', () => {
    jsonl(path.join(root, 'codex', 'rollout.jsonl'), [
      { type: 'session_meta', payload: { id: 'image-only', cwd: root } },
      { type: 'response_item', timestamp, payload: { role: 'user', content: [{ type: 'input_image', image_url: image }] } },
      { type: 'response_item', timestamp, payload: { role: 'user', content: [{ type: 'input_image', image_url: image }, { type: 'input_image', image_url: image }] } },
    ]);
    const session = parseCodexSessions(path.join(root, 'codex'), undefined, sources)[0];
    expect(session.requests.map(request => request.variableKinds.image)).toEqual([1, 2]);
    const source = sources.get(session.sessionId)!;
    expect(extractSourceImages(source, session.sessionId, session.requests[1].requestId)).toEqual([image, image]);
  });

  it('counts Codex local files and unavailable file IDs without treating remote IDs as paths', () => {
    const file = path.join(root, 'screen.png');
    fs.writeFileSync(file, Buffer.from(base64, 'base64'));
    const events = jsonl(path.join(root, 'codex', 'rollout.jsonl'), [
      { type: 'session_meta', payload: { id: 'local-images', cwd: root } },
      { type: 'event_msg', timestamp, payload: { type: 'user_message', message: 'Screenshot', local_images: ['screen.png'], file_ids: ['file-remote-only'] } },
    ]);
    const session = parseCodexSessions(path.dirname(events), undefined, sources)[0];
    expect(session.requests[0].variableKinds.image).toBe(2);
    expect(extractSourceImages(sources.get(session.sessionId)!, session.sessionId, session.requests[0].requestId)).toEqual([image]);
  });

  it('counts and loads OpenCode image parts from legacy JSON storage', () => {
    const storage = makeOpenCodeStorage();
    const session = parseOpenCodeSessions(storage, undefined, sources)[0];
    expect(session.requests[0].variableKinds.image).toBe(1);
    const source = sources.get(session.sessionId)!;
    expect(extractSourceImages(source, session.sessionId, 'oc-user')).toEqual([image]);
    expect(extractSourceImages(source, session.sessionId, 'unknown')).toEqual([]);
    expect(loadSourceSession(source, session.sessionId)?.requests[0].variableKinds.image).toBe(1);
  });

  it('counts and loads OpenCode SQLite image parts using both session and user-message IDs', () => {
    const file = path.join(root, 'opencode.db');
    const database = new DatabaseSync(file);
    database.exec(`
      CREATE TABLE session (id TEXT, project_id TEXT, directory TEXT, title TEXT, slug TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT, session_id TEXT, message_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      INSERT INTO session VALUES ('oc-db', 'project', '', 'Project', 'project', 1, 2);
      INSERT INTO message VALUES ('user', 'oc-db', 1, 1, '{"role":"user"}');
      INSERT INTO message VALUES ('assistant', 'oc-db', 2, 2, '{"role":"assistant"}');
    `);
    const insert = database.prepare('INSERT INTO part VALUES (?, ?, ?, 1, 1, ?)');
    const data = JSON.stringify({ type: 'file', mime: 'image/png', url: image });
    insert.run('part-user', 'oc-db', 'user', data);
    insert.run('part-assistant', 'oc-db', 'assistant', data);
    insert.run('part-other-session', 'other-session', 'user', data);
    database.close();
    const session = parseOpenCodeSessions(file, undefined, sources)[0];
    expect(session.requests[0].variableKinds.image).toBe(1);
    const source = sources.get('oc-db')!;
    expect(extractSourceImages(source, 'oc-db', 'user')).toEqual([image]);
    expect(extractSourceImages(source, 'oc-db', 'assistant')).toEqual([]);
    expect(extractSourceImages(source, 'wrong-session', 'user')).toEqual([]);
    expect(extractSourceImages(source, 'oc-db', "' OR 1=1 --")).toEqual([]);
    expect(loadSourceSession(source, 'oc-db')?.requests[0].variableKinds.image).toBe(1);
  });

  it('registers loadable external sources during cold parsing and asynchronous refresh', async () => {
    makeClaude();
    makeCodex();
    makeOpenCodeStorage();
    const result = parseAllLogs([]);
    setMemoryCache(result, {});
    const gallery = new Analyzer(result.sessions, result.editLocIndex).getImageGallery();
    expect(gallery.moments).toHaveLength(4);
    for (const moment of gallery.moments) {
      expect(extractSourceImages(result.sessionSourceIndex.get(moment.sessionId)!, moment.sessionId, moment.id)).toEqual([image]);
      expect((await loadSessionFromDisk(moment.sessionId))?.requests.some(request => request.requestId === moment.id)).toBe(true);
    }
    sources.set('deleted-session', { kind: 'claude-jsonl', filePath: 'deleted.jsonl', workspaceId: 'ws', workspaceName: 'WS', harness: 'Claude' });
    await collectExternalHarnessesAsync(new Map(), [], new Map(), {}, sources);
    expect(sources.has('deleted-session')).toBe(false);
    expect([...sources.values()].map(source => source.kind).sort()).toEqual(['claude-jsonl', 'codex-jsonl', 'opencode-storage']);
    expect(JSON.stringify([...sources])).not.toContain(base64);
  });
});
