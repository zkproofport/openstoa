import { expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Commands } from '@masselabs/openstoa-commands';
import { buildProgram } from '../cli';

it('upload --topic-id preserves topic ownership through the command boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openstoa-upload-unit-'));
  try {
    const file = join(root, 'image.png');
    writeFileSync(file, new Uint8Array([1, 2, 3]));
    const uploadImage = vi.fn().mockResolvedValue({ publicUrl: '/api/media/topics/t1/posts/id/image.png' });
    const program = buildProgram(async () => ({ uploadImage } as unknown as Commands), () => {}).exitOverride();
    await program.parseAsync(['node', 'openstoa', '--json', 'upload', file, '--purpose', 'post', '--topic-id', 't1']);
    expect(uploadImage).toHaveBeenCalledExactlyOnceWith({ data: new Uint8Array([1, 2, 3]), filename: 'image.png', contentType: 'image/png', purpose: 'post', topicId: 't1' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
