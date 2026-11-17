import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ProjectsService } from './projects.service';

/** AI 用更新（.md 端点）：仅本地字段，刻意不含飞书同步覆盖的字段 */
class UpdateRequirementMarkdownDto {
  /** 脚本目录：相对脚本根目录的子目录，空串清除 */
  scriptsPath?: string;
  /** 需求描述（Markdown），空串清除 */
  description?: string;
  /** 需求方（姓名，多个顿号连接；须在用户系统内），空串清除 */
  owner?: string;
  /** 涉及方（飞书「涉及方」多选同步；平台内可编辑，下次同步覆盖；顿号/逗号分隔），空串清除 */
  involvedParties?: string;
  /** 备注（飞书「排期优先级」+「排期备注」同步合成；平台内可编辑，下次同步覆盖），空串清除 */
  remark?: string;
}

/**
 * 需求视图（需求池复用项目实体）：Markdown 搜索、详情与 AI 更新。
 * JSON 接口仍挂在 /api/projects，实体与表结构不变。
 */
@Controller('requirements')
export class RequirementsController {
  constructor(private readonly projectsService: ProjectsService) {}

  /** 需求 Markdown 模糊搜索（须声明在 :id 之前）：按名称匹配 + 创建时间倒序，返回前 5 */
  @Get('search.md')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  searchMarkdown(@Query('q') q?: string): Promise<string> {
    return this.projectsService.searchMarkdown(q ?? '');
  }

  /** 需求 Markdown 视图（须声明在 :id 之前，避免 :id 匹配到带 .md 后缀的路径） */
  @Get(':id.md')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  findOneMarkdown(@Param('id', ParseIntPipe) id: number): Promise<string> {
    return this.projectsService.findOneRequirementMarkdown(id);
  }

  /**
   * AI 用：仅本地字段更新并以 Markdown 返回结果（text/markdown）。
   * 可改 脚本目录 / 描述 / 需求方 / 涉及方 / 备注，空串清除；用法见需求 .md 视图。
   */
  @Post(':id/update.md')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  updateMarkdown(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRequirementMarkdownDto,
  ): Promise<string> {
    return this.projectsService.updateMarkdown(id, dto);
  }
}
