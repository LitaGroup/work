import { BadRequestException, Injectable } from '@nestjs/common';
import { DocumentType } from '../common/enums';
import { ApipostService } from '../apipost/apipost.service';
import {
  swaggerToMarkdown,
  type SwaggerSpec,
} from '../apipost/apipost-markdown';
import { FeishuService } from '../feishu/feishu.service';
import { KnowledgeService } from './knowledge.service';
import type { ExternalKnowledgeSource, KnowledgeNode } from './knowledge.types';

interface ExternalKnowledgeContent {
  source: ExternalKnowledgeSource;
  sourceKey: string;
  sourceUrl: string;
  title: string;
  content: string;
}

function detectSource(url: string): ExternalKnowledgeSource {
  return /apipost\.net/i.test(url) ? 'apipost' : 'feishu';
}

function assertDocumentType(type: DocumentType): void {
  if (!Object.values(DocumentType).includes(type)) {
    throw new BadRequestException(
      `非法文档类型：${type}（可选：${Object.values(DocumentType).join('/')}）`,
    );
  }
}

@Injectable()
export class KnowledgeImportService {
  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly feishu: FeishuService,
    private readonly apipost: ApipostService,
  ) {}

  async import(input: {
    parentPath?: string;
    url: string;
    title?: string;
  }): Promise<KnowledgeNode> {
    const url = input.url?.trim();
    if (!url) throw new BadRequestException('文档链接不能为空');
    if (!/^https?:\/\//i.test(url)) {
      throw new BadRequestException('文档链接须为 http(s) 完整链接');
    }
    const source = detectSource(url);
    const documentType =
      source === 'apipost' ? DocumentType.API : DocumentType.REQUIREMENT;
    assertDocumentType(documentType);
    const content = await this.readSource(source, url);
    const customTitle = input.title?.trim();
    return this.knowledge.importExternal({
      parentPath: input.parentPath || '/',
      source,
      sourceKey: content.sourceKey,
      sourceUrl: content.sourceUrl,
      title: customTitle || content.title,
      content: content.content,
      documentType,
      titleCustomized: Boolean(customTitle),
    });
  }

  async sync(id: string): Promise<KnowledgeNode> {
    const node = await this.knowledge.getNodeById(id);
    if (node.source !== 'feishu' && node.source !== 'apipost') {
      throw new BadRequestException('当前知识节点不是外部导入文档');
    }
    if (!node.sourceUrl) {
      throw new BadRequestException('知识节点缺少原始链接，无法更新同步');
    }
    const content = await this.readSource(node.source, node.sourceUrl);
    return this.knowledge.syncExternal(id, {
      title: node.titleCustomized ? node.title : content.title,
      content: content.content,
    });
  }

  private async readSource(
    source: ExternalKnowledgeSource,
    url: string,
  ): Promise<ExternalKnowledgeContent> {
    if (source === 'apipost') {
      const result = await this.apipost.readByUrl(url);
      return {
        source,
        sourceKey: result.docsUrl,
        sourceUrl: result.docsUrl,
        title: result.title,
        content: this.apipostMarkdown(result.rawJson),
      };
    }
    const result = await this.feishu.readByUrl(url);
    return {
      source,
      sourceKey: result.feishuKey,
      sourceUrl: url,
      title: result.title,
      content: result.content,
    };
  }

  private apipostMarkdown(rawJson: string): string {
    try {
      return swaggerToMarkdown(JSON.parse(rawJson) as SwaggerSpec);
    } catch (error) {
      throw new BadRequestException(
        `APIPOST 文档解析失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
