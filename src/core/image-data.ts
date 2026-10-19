/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { assertTrustedPath } from './parser-shared';
import { warnCore } from './log';

export interface ImageReference {
  data?: unknown;
  path?: string;
}

export type ImageCollector = (requestId: string, images: ImageReference[]) => void;

export const MAX_IMAGES_PER_REQUEST = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function imagePath(value: unknown): boolean {
  return typeof value === 'string' && /\.(?:png|jpe?g|gif|webp|bmp|avif)(?:[?#].*)?$/i.test(value);
}

function imageLocation(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return undefined;
  if (typeof value.external === 'string') return value.external;
  if (typeof value.fsPath === 'string') return value.fsPath;
  if (typeof value.path !== 'string') return undefined;
  if (typeof value.scheme === 'string' && value.scheme !== 'file') return `${value.scheme}:${value.path}`;
  if (typeof value.authority === 'string' && value.authority) return `//${value.authority}${value.path}`;
  return value.path;
}

function reference(value: Record<string, unknown>): ImageReference {
  const source = isRecord(value.source) ? value.source : {};
  const url = isRecord(value.image_url) ? value.image_url.url : value.image_url;
  const location = imageLocation(typeof value.scheme === 'string' ? value
    : value.path ?? value.fileUrl ?? value.uri ?? value.url ?? value.external ?? url ?? source.url);
  const data = source.data ?? value.data ?? value.value;
  if (typeof location === 'string' && location.startsWith('data:')) return { data: location };
  if (typeof data === 'string' && !data.startsWith('data:') && imagePath(data)) return { path: data };
  return data === undefined ? { path: location } : { data };
}

export function imageReferencesFromVariables(value: unknown): ImageReference[] {
  return records(value).filter(v => v.kind === 'image').map(v => {
    const data = v.value;
    if (isRecord(data) && ['data', 'uri', 'path', 'external', 'fsPath'].some(key => key in data)) {
      return reference(data);
    }
    return reference(v);
  });
}

export function imageReferencesFromAttachments(value: unknown): ImageReference[] {
  return records(value)
    .filter(v => v.type === 'image'
      || (typeof v.mimeType === 'string' && v.mimeType.startsWith('image/'))
      || imagePath(v.path ?? v.url ?? v.uri))
    .map(reference);
}

export function imageReferencesFromContent(value: unknown): ImageReference[] {
  return records(value)
    .filter(v => v.type === 'image' || v.type === 'input_image' || v.type === 'local_image'
      || (v.type === 'file' && ((typeof v.mime === 'string' && v.mime.startsWith('image/')) || imagePath(v.url))))
    .map(reference);
}

export function imageReferencesFromXcode(value: unknown): ImageReference[] {
  return records(value).map(reference);
}

export function imageReferencesFromCodex(payload: Record<string, unknown>): ImageReference[] {
  const images = imageReferencesFromContent(payload.content);
  for (const value of Array.isArray(payload.images) ? payload.images : []) {
    if (typeof value === 'string') images.push({ data: value });
  }
  for (const value of Array.isArray(payload.file_ids) ? payload.file_ids : []) {
    if (typeof value === 'string') images.push({});
  }
  for (const value of Array.isArray(payload.local_images) ? payload.local_images : []) {
    if (typeof value === 'string') images.push({ path: value });
    else if (isRecord(value)) images.push(reference(value));
  }
  return images;
}

function imageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 8) return null;
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70) return 'image/gif';
  if (bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70
    && Buffer.from(bytes.subarray(8, 12)).toString() === 'WEBP') return 'image/webp';
  if (bytes[0] === 66 && bytes[1] === 77) return 'image/bmp';
  if (Buffer.from(bytes.subarray(4, 8)).toString() === 'ftyp'
    && ['avif', 'avis'].includes(Buffer.from(bytes.subarray(8, 12)).toString())) return 'image/avif';
  return null;
}

function imageBytes(data: unknown): Uint8Array | null {
  if (typeof data === 'string') {
    const match = /^data:image\/[a-z0-9.+-]+;base64,([\s\S]*)$/i.exec(data);
    const base64 = (match ? match[1] : data).replaceAll(/\s/g, '');
    if (base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('Image exceeds the 10 MB limit');
    if (!/^[a-z0-9+/]*={0,2}$/i.test(base64) || base64.length % 4 === 1) {
      throw new Error('Invalid base64 image data');
    }
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Image exceeds the 10 MB limit');
    return bytes;
  }
  if (!Array.isArray(data) && !isRecord(data)) return null;
  const length = Array.isArray(data) ? data.length : Object.keys(data).length;
  if (length > MAX_IMAGE_BYTES) throw new Error('Image exceeds the 10 MB limit');
  if (length < 8) return null;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    const value: unknown = Array.isArray(data) ? data[i] : data[String(i)];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
      throw new Error('Invalid image byte array');
    }
    bytes[i] = value;
  }
  return bytes;
}

function readImageFile(location: string, baseDir: string, workspaceRootPath?: string): Uint8Array {
  let filePath = location;
  if (/^file:/i.test(location)) {
    const url = new URL(location);
    if (url.hostname && url.hostname !== 'localhost') throw new Error('Remote image files are not supported');
    filePath = fileURLToPath(url);
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(location) && !/^[a-z]:[\\/]/i.test(location)) {
    throw new Error('Remote image URLs are not supported');
  }
  if (filePath.startsWith('\\\\') || filePath.startsWith('//')) throw new Error('Remote image files are not supported');
  if (filePath.replaceAll('\\', '/').split('/').includes('..')) throw new Error('Image path traversal detected');
  filePath = path.resolve(workspaceRootPath || baseDir, filePath);
  const roots = workspaceRootPath ? [workspaceRootPath] : [];
  assertTrustedPath(filePath, roots);
  const resolved = fs.realpathSync(filePath);
  assertTrustedPath(resolved, roots);
  const fd = fs.openSync(resolved, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error('Image is not a file or exceeds the 10 MB limit');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (read === 0) throw new Error('Image changed while reading');
      offset += read;
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

export function loadImageReferences(images: ImageReference[], baseDir: string, workspaceRootPath?: string): string[] {
  const result: string[] = [];
  for (const image of images) {
    if (result.length >= MAX_IMAGES_PER_REQUEST) break;
    try {
      const bytes = image.path
        ? readImageFile(image.path, baseDir, workspaceRootPath)
        : imageBytes(image.data);
      if (!bytes) {
        warnCore('image-extract', 'Image reference has no recorded data or local file');
        continue;
      }
      const mime = imageMime(bytes);
      if (!mime) throw new Error('Unsupported image data');
      result.push(`data:${mime};base64,${Buffer.from(bytes).toString('base64')}`);
    } catch (error) {
      warnCore('image-extract', 'Could not load a local image', error);
    }
  }
  return result;
}
