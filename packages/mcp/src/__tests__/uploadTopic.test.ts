import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Commands } from '@masselabs/openstoa-commands';
import { registerTools, type ToolResult } from '../tools';

it('upload_image schema and dispatch preserve the optional topicId', async () => {
  const uploadImage = vi.fn().mockResolvedValue({ publicUrl: '/api/media/topics/t1/posts/id/image.png' });
  let schema!: Record<string, z.ZodTypeAny>;
  let handler!: (args: Record<string, unknown>) => Promise<ToolResult>;
  registerTools({ tool(name, _description, fields, run) {
    if (name === 'openstoa_upload_image') { schema = fields; handler = run; }
  } }, { uploadImage } as unknown as Commands);
  const input = { base64: 'AQID', filename: 'image.png', contentType: 'image/png', purpose: 'post', topicId: 't1' };
  const response = await handler(z.object(schema).strict().parse(input));
  expect(response.isError).toBeUndefined();
  expect(uploadImage).toHaveBeenCalledExactlyOnceWith({ data: new Uint8Array([1, 2, 3]), filename: 'image.png', contentType: 'image/png', purpose: 'post', topicId: 't1' });
});
