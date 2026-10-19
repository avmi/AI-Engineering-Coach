/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import type { SessionSource } from './cache';
import type { Session } from './types';
import { parseCLIEventsFile } from './parser-vscode-cli';
import { parseClaudeSessionFile } from './parser-claude';
import { parseCodexSessionFile } from './parser-codex';
import { parseOpenCodeSessions, readOpenCodeImageReferences } from './parser-opencode';
import { loadXcodeSession, readXcodeImageReferences } from './parser-xcode';
import { parseSessionFile } from './parser-vscode';
import { extractSessionImages } from './parser-vscode-files';
import { loadImageReferences, type ImageCollector, type ImageReference } from './image-data';

export interface SessionImagesRequest {
  type: 'session-images';
  source: SessionSource;
  sessionId: string;
  requestId: string;
}

export function loadSourceSession(source: SessionSource, sessionId: string): Session | null {
  switch (source.kind) {
    case 'vscode-session-file':
      return parseSessionFile(source.filePath, source.workspaceId, source.workspaceName, source.harness);
    case 'cli-events':
      return parseCLIEventsFile(source.filePath, source.workspaceId, source.workspaceName);
    case 'codex-jsonl':
      return parseCodexSessionFile(source.filePath);
    case 'claude-jsonl': {
      const sessions = [source.filePath, ...source.additionalFilePaths ?? []]
        .map(file => parseClaudeSessionFile(file, source.workspaceId, source.workspaceName))
        .filter((session): session is Session => session !== null);
      if (!sessions[0]) return null;
      const requests = sessions.flatMap(session => session.requests)
        .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
      const creationDates = sessions.map(session => session.creationDate).filter((date): date is number => date !== null);
      return {
        ...sessions[0],
        sessionId,
        creationDate: creationDates.length > 0 ? Math.min(...creationDates) : null,
        requests,
        requestCount: requests.length,
        lastMessageDate: Math.max(...sessions.map(session => session.lastMessageDate ?? 0)) || null,
      };
    }
    case 'opencode-storage':
    case 'opencode-db':
      return parseOpenCodeSessions(source.filePath).find(session => session.sessionId === sessionId) ?? null;
    case 'xcode-db':
      return loadXcodeSession(source.filePath, sessionId);
  }
}

/** Runs in the parse worker; raw payloads never enter the analytics cache. */
export function extractSourceImages(source: SessionSource, sessionId: string, requestId: string): string[] {
  let references: ImageReference[] = [];
  let session: Session | null = null;
  const collect: ImageCollector = (id, images) => {
    if (id === requestId) references = images;
  };
  switch (source.kind) {
    case 'vscode-session-file':
      return extractSessionImages(source.filePath, requestId, source.workspaceRootPath);
    case 'cli-events':
      session = parseCLIEventsFile(source.filePath, source.workspaceId, source.workspaceName, undefined, undefined, collect);
      break;
    case 'codex-jsonl':
      session = parseCodexSessionFile(source.filePath, undefined, collect);
      break;
    case 'claude-jsonl':
      for (const file of [source.filePath, ...source.additionalFilePaths ?? []]) {
        session = parseClaudeSessionFile(file, source.workspaceId, source.workspaceName, undefined, collect);
        if (references.length > 0) return loadImageReferences(references, path.dirname(file), session?.workspaceRootPath);
      }
      return [];
    case 'opencode-storage':
    case 'opencode-db':
      references = readOpenCodeImageReferences(source.filePath, sessionId, requestId);
      break;
    case 'xcode-db':
      references = readXcodeImageReferences(source.filePath, sessionId, requestId);
      break;
  }
  return loadImageReferences(references, path.dirname(source.filePath), session?.workspaceRootPath ?? source.workspaceRootPath);
}
