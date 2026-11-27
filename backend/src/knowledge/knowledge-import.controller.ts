import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { assertSystemKnowledgeWritable } from './system-knowledge.guard';
import { KnowledgeImportService } from './knowledge-import.service';
import { KnowledgeService } from './knowledge.service';

class ImportKnowledgeDocumentDto {
  parentPath?: string;
  url: string;
  /** 自定义标题；留空使用来源文档标题 */
  title?: string;
}

@Controller('docs')
export class KnowledgeImportController {
  constructor(
    private readonly imports: KnowledgeImportService,
    private readonly knowledge: KnowledgeService,
  ) {}

  /** 从飞书 / APIPOST 导入知识文章，按链接自动识别来源 */
  @Post('nodes/import')
  @HttpCode(200)
  importDocument(@Body() dto: ImportKnowledgeDocumentDto) {
    assertSystemKnowledgeWritable(dto.parentPath);
    return this.imports.import(dto);
  }

  /** 从保存的原始链接更新同步外部知识文章 */
  @Post('nodes/:id/sync')
  @HttpCode(200)
  async syncDocument(@Param('id') id: string) {
    const current = await this.knowledge.getNodeById(id);
    assertSystemKnowledgeWritable(current.path);
    return this.imports.sync(id);
  }
}
