/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  imageReferencesFromAttachments,
  imageReferencesFromContent,
  imageReferencesFromVariables,
  imageReferencesFromXcode,
  loadImageReferences,
  MAX_IMAGE_BYTES,
} from './image-data';
import { assertTrustedPath } from './parser-shared';

const bytes = [137, 80, 78, 71, 13, 10, 26, 10];
const base64 = Buffer.from(bytes).toString('base64');
const image = `data:image/png;base64,${base64}`;
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-image-data-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('local image representations', () => {
  it.each([
    { kind: 'image', value: Object.fromEntries(bytes.map((value, i) => [String(i), value])) },
    { kind: 'image', data: bytes },
    { kind: 'image', value: { data: base64, mimeType: 'image/png' } },
    { kind: 'image', value: image },
  ])('loads VS Code image variables: %j', variable => {
    expect(loadImageReferences(imageReferencesFromVariables([variable]), root)).toEqual([image]);
  });

  it.each([
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
    { type: 'input_image', image_url: image },
    { type: 'input_image', image_url: { url: image } },
    { type: 'file', mime: 'image/png', url: image },
  ])('loads inline content images: %j', block => {
    expect(loadImageReferences(imageReferencesFromContent([block]), root)).toEqual([image]);
  });

  it('loads local files, file URLs, relative attachments, and Xcode image data', () => {
    const file = path.join(root, 'screen shot.png');
    fs.writeFileSync(file, Buffer.from(bytes));
    const references = [
      ...imageReferencesFromAttachments([{ type: 'image', path: file }]),
      ...imageReferencesFromAttachments([{ type: 'file', path: pathToFileURL(file).href }]),
      ...imageReferencesFromContent([{ type: 'local_image', path: 'screen shot.png' }]),
      ...imageReferencesFromXcode([{ data: base64, fileUrl: 'file:///deleted-image.png' }]),
    ];
    expect(loadImageReferences(references, root)).toEqual([image, image, image, image]);
  });

  it('does not classify ordinary file or tool-result content as user images', () => {
    expect(imageReferencesFromAttachments([{ type: 'file', path: 'notes.txt' }])).toEqual([]);
    expect(imageReferencesFromContent([{ type: 'tool_result', content: [{ type: 'image' }] }])).toEqual([]);
    expect(imageReferencesFromVariables([null, { kind: 'file', value: 'test.png' }])).toEqual([]);
  });

  it('loads at most four images and skips invalid references without losing valid ones', () => {
    const references = [{ data: '<svg></svg>' }, ...Array.from({ length: 6 }, () => ({ data: base64 }))];
    expect(loadImageReferences(references, root)).toEqual(Array<string>(4).fill(image));
    expect(console.warn).toHaveBeenCalled();
  });

  it('rejects oversized inline and file images before decoding or reading them', () => {
    const file = path.join(root, 'oversized.png');
    const fd = fs.openSync(file, 'w');
    fs.ftruncateSync(fd, MAX_IMAGE_BYTES + 1);
    fs.closeSync(fd);
    expect(loadImageReferences([
      { data: 'A'.repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) },
      { data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') },
      { path: file },
      { data: base64 },
    ], root)).toEqual([image]);
    expect(console.warn).toHaveBeenCalledTimes(3);
  });

  it('accepts the exact image size limit', () => {
    const data = Buffer.alloc(MAX_IMAGE_BYTES);
    data.set(bytes);
    const file = path.join(root, 'limit.png');
    fs.writeFileSync(file, data);
    const result = loadImageReferences([{ path: file }], root);
    expect(result).toHaveLength(1);
    expect(Buffer.from(result[0].split(',')[1], 'base64')).toHaveLength(MAX_IMAGE_BYTES);
  });

  it('rejects missing files, traversal, remote URLs, remote shares, and executable image data', () => {
    expect(loadImageReferences([
      { path: path.join(root, 'missing.png') },
      { path: '..\\escape.png' },
      { path: 'https://example.com/screen.png' },
      { path: 'file://remote-host/share/screen.png' },
      { path: '\\\\remote-host\\share\\screen.png' },
      { data: `data:image/svg+xml;base64,${Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64')}` },
      { data: [137, 80, 78, 71, -1, 0, 0, 0] },
    ], root)).toEqual([]);
    expect(console.warn).toHaveBeenCalledTimes(7);
  });

  it('only extends attachment trust to the explicitly supplied workspace root', () => {
    const workspace = path.join(path.parse(root).root, 'coach-image-workspace');
    const file = path.join(workspace, 'screen.png');
    expect(() => assertTrustedPath(file)).toThrow('outside trusted directories');
    expect(() => assertTrustedPath(file, [workspace])).not.toThrow();
    expect(() => assertTrustedPath(path.join(path.dirname(workspace), 'other-workspace', 'screen.png'), [workspace]))
      .toThrow('outside trusted directories');
  });

  it.skipIf(process.platform !== 'win32')('loads Windows attachment paths with different drive and directory casing', () => {
    const file = path.join(root, 'Screenshot.PNG');
    fs.writeFileSync(file, Buffer.from(bytes));
    expect(loadImageReferences([{ path: file.toLowerCase() }], root)).toEqual([image]);
  });
});
