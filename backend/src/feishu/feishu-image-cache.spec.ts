import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  FeishuImageCache,
  imageCacheRelPath,
  imageTokenFromFile,
} from './feishu-image-cache';

describe('图片缓存路径', () => {
  it('文件名去扩展名得到 token，无扩展名返回 null', () => {
    expect(imageTokenFromFile('AbCdEf.png')).toBe('AbCdEf');
    expect(imageTokenFromFile('AbCd.ef.jpg')).toBe('AbCd.ef');
    expect(imageTokenFromFile('noext')).toBe(null);
    expect(imageTokenFromFile('.gitkeep')).toBe(null);
  });

  it('稳定两级路径：按 token 前两位分桶，非法前缀归 xx', () => {
    expect(imageCacheRelPath('AbCdEf', '.png')).toBe('feishu/Ab/AbCdEf.png');
    expect(imageCacheRelPath('中文token', '.jpg')).toBe(
      'feishu/xx/中文token.jpg',
    );
  });
});

describe('FeishuImageCache', () => {
  it('复用历史按日期目录落盘的素材，避免重复下载', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-cache-'));
    try {
      await fs.mkdir(path.join(root, 'feishu', '20261124'), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(root, 'feishu', '20261124', 'Tok1.png'),
        'x',
      );

      const cache = new FeishuImageCache(() => root);
      await cache.load();

      expect(cache.get('Tok1')).toBe('/images/feishu/20261124/Tok1.png');
      expect(cache.get('Tok2')).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('未命中时原子落盘到稳定路径并登记索引', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-cache-'));
    try {
      const cache = new FeishuImageCache(() => root);
      await cache.load();

      const url = await cache.save('Tok2', '.jpg', Buffer.from('y'));

      expect(url).toBe('/images/feishu/To/Tok2.jpg');
      expect(cache.get('Tok2')).toBe(url);
      const stat = await fs.stat(path.join(root, 'feishu', 'To', 'Tok2.jpg'));
      expect(stat.isFile()).toBe(true);
      expect(
        await fs.readFile(path.join(root, 'feishu', 'To', 'Tok2.jpg'), 'utf8'),
      ).toBe('y');
      // 临时文件不残留
      const entries = await fs.readdir(path.join(root, 'feishu', 'To'));
      expect(entries).toEqual(['Tok2.jpg']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('重复落盘同一 token 覆盖为最新内容', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-cache-'));
    try {
      const cache = new FeishuImageCache(() => root);
      await cache.load();
      await cache.save('Tok3', '.png', Buffer.from('old'));
      const url = await cache.save('Tok3', '.png', Buffer.from('new'));
      expect(url).toBe('/images/feishu/To/Tok3.png');
      expect(
        await fs.readFile(path.join(root, 'feishu', 'To', 'Tok3.png'), 'utf8'),
      ).toBe('new');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
