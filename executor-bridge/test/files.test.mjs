/**
 * bridge 结构化文件端点核心用例：读回、按受管清单删除、路径越界拒绝。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileOps } from '../dist/core/files.js';

test('工位文件可写、读回并按受管清单删除', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-files-'));
  const files = new FileOps(root);
  const workdir = join(root, 'worker', '1001');
  try {
    await files.writeFile({
      directory: workdir,
      path: 'AGENTS.md',
      contentBase64: Buffer.from('robot').toString('base64'),
    });
    await files.writeFile({
      directory: workdir,
      path: '.agents/rules/old.md',
      contentBase64: Buffer.from('old').toString('base64'),
    });

    const read = await files.readFile({
      directory: workdir,
      path: 'AGENTS.md',
    });
    assert.equal(Buffer.from(read.contentBase64, 'base64').toString(), 'robot');
    assert.equal(
      await files.readFile({ directory: workdir, path: 'missing.md' }),
      null,
    );

    await files.removeFiles({
      directory: workdir,
      paths: ['.agents/rules/old.md'],
    });
    assert.equal(
      await files.readFile({
        directory: workdir,
        path: '.agents/rules/old.md',
      }),
      null,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('并发 upsert env 串行化，去重同名 key 且保留其他内容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-files-'));
  const files = new FileOps(root);
  const workdir = join(root, 'worker', '1001');
  const env = '.agents/.env';
  try {
    await files.writeFile({
      directory: workdir,
      path: env,
      contentBase64: Buffer.from(
        [
          'LITA_WORK_TOKEN=old-a',
          'LITA_WORK_TOKEN=old-b',
          'LITA_APP_URL=http://old',
          'KEEP_ME=1',
          '',
        ].join('\n'),
      ).toString('base64'),
    });

    await Promise.all([
      files.upsertEnv({
        directory: workdir,
        path: env,
        entries: { LITA_WORK_TOKEN: 'new-token' },
      }),
      files.upsertEnv({
        directory: workdir,
        path: env,
        entries: { LITA_APP_URL: 'http://new' },
      }),
    ]);

    const written = await files.readFile({ directory: workdir, path: env });
    const content = Buffer.from(written.contentBase64, 'base64').toString();
    const lines = content.split('\n').filter(Boolean);
    assert.equal(
      lines.filter((line) => line.startsWith('LITA_WORK_TOKEN=')).length,
      1,
    );
    assert.equal(
      lines.filter((line) => line.startsWith('LITA_APP_URL=')).length,
      1,
    );
    assert.ok(lines.includes('LITA_WORK_TOKEN=new-token'));
    assert.ok(lines.includes('LITA_APP_URL=http://new'));
    assert.ok(lines.includes('KEEP_ME=1'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('文件读写与删除拒绝越出 BRIDGE_ROOT', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-files-'));
  const files = new FileOps(root);
  try {
    await assert.rejects(
      files.readFile({ directory: root, path: '../secret' }),
      /路径越界/,
    );
    await assert.rejects(
      files.removeFiles({ directory: root, paths: ['../secret'] }),
      /非法文件路径|路径越界/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});