import { Injectable, Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DocumentType } from '../../common/enums';
import { DocumentsService } from '../../documents/documents.service';
import { ProjectsService } from '../../projects/projects.service';
import { executeTool, jsonResult, markdownResult } from './work-tools.util';
import type { McpWorkPrincipal, WorkToolRegistrar } from './work-tools.types';

const DocumentTypeArg = z.enum(
  Object.values(DocumentType) as [DocumentType, ...DocumentType[]],
);

/** 需求（项目实体）/ 文档：搜索、详情、配置写入与文档读写 */
@Injectable()
export class WorkProjectTools implements WorkToolRegistrar {
  private readonly logger = new Logger(WorkProjectTools.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly documents: DocumentsService,
  ) {}

  register(server: McpServer, principal: McpWorkPrincipal): void {
    server.registerTool(
      'search_projects',
      {
        title: '搜索项目',
        description:
          '按项目名称模糊搜索，返回匹配度排序的前 5 个项目（名称/类型/状态/id/更新时间与详情入口）。不知道项目 id 时先搜索。',
        inputSchema: {
          query: z.string().min(1).describe('项目名称关键词'),
        },
      },
      async (args) =>
        executeTool(this.logger, 'search_projects', principal, async () =>
          markdownResult(await this.projects.searchMarkdown(args.query)),
        ),
    );

    server.registerTool(
      'get_project',
      {
        title: '需求详情',
        description:
          '获取需求基本详情：元信息、描述、对应的迭代（含已取消历史迭代项）与文档资料清单，末尾附需求级 AI 操作端点。研发操作请使用脚本运行、缺陷、提测等对应工具。',
        inputSchema: {
          projectId: z.number().int().positive().describe('项目 ID'),
        },
      },
      async (args) =>
        executeTool(this.logger, 'get_project', principal, async () =>
          markdownResult(
            await this.projects.findOneRequirementMarkdown(args.projectId),
          ),
        ),
    );

    server.registerTool(
      'update_project',
      {
        title: '更新项目配置',
        description:
          '仅更新本地字段：脚本目录、Markdown 描述、需求方、涉及方、备注。只更新提供的字段，空串清除；类型/状态/优先级等来自飞书同步，不要通过本工具修改。',
        inputSchema: {
          projectId: z.number().int().positive().describe('项目 ID'),
          scriptsPath: z
            .string()
            .optional()
            .describe('脚本目录（相对脚本根目录的子目录），空串清除'),
          description: z
            .string()
            .optional()
            .describe('项目描述（Markdown），空串清除'),
          owner: z
            .string()
            .optional()
            .describe('需求方（姓名，多个顿号连接，须在用户系统内），空串清除'),
          involvedParties: z
            .string()
            .optional()
            .describe(
              '涉及方（如 Android、iOS、Backend，顿号或逗号分隔；飞书多选字段同步，平台内可编辑，下次同步覆盖），空串清除',
            ),
          remark: z
            .string()
            .optional()
            .describe(
              '备注（飞书排期优先级/排期备注同步合成；平台内可编辑，下次同步覆盖），空串清除',
            ),
        },
      },
      async ({ projectId, ...dto }) =>
        executeTool(this.logger, 'update_project', principal, async () =>
          markdownResult(await this.projects.updateMarkdown(projectId, dto)),
        ),
    );

    server.registerTool(
      'read_document',
      {
        title: '读取项目文档',
        description:
          '读取文档元信息与 Markdown 正文全文（飞书/APIPOST 导入文档正文只读）。',
        inputSchema: {
          documentId: z.number().int().positive().describe('文档 ID'),
        },
      },
      async (args) =>
        executeTool(this.logger, 'read_document', principal, async () =>
          markdownResult(await this.documents.findOneMarkdown(args.documentId)),
        ),
    );

    server.registerTool(
      'upsert_document',
      {
        title: '写入项目文档',
        description:
          '按 (projectId, fileName) upsert 项目文档：已存在覆盖正文，不存在新建。fileName 是稳定唯一标识（如 deploy-guide.md）。命中飞书/APIPOST 导入的文档会被拒绝。',
        inputSchema: {
          projectId: z.number().int().positive().describe('项目 ID'),
          fileName: z
            .string()
            .min(1)
            .describe('文档文件名（项目内唯一，如 TECHNICAL_DESIGN.md）'),
          content: z.string().describe('Markdown 正文'),
          title: z
            .string()
            .optional()
            .describe('展示标题（新建缺省取 fileName）'),
          type: DocumentTypeArg.optional().describe(
            '文档类型：需求/功能/测试/技术/接口/配置（新建缺省技术）',
          ),
          description: z.string().optional().describe('文档描述'),
        },
      },
      async (args) =>
        executeTool(this.logger, 'upsert_document', principal, async () =>
          markdownResult(await this.documents.upsertMarkdown(args)),
        ),
    );

    server.registerTool(
      'sync_apipost_document',
      {
        title: '导入 APIPOST 接口文档',
        description:
          '从 docs.apipost.net 文档页或 openapi.apipost.net swagger 链接单向导入接口文档（同项目按链接判重更新）。',
        inputSchema: {
          projectId: z.number().int().positive().describe('项目 ID'),
          url: z.string().min(1).describe('APIPOST 文档或 swagger 链接'),
          type: DocumentTypeArg.optional().describe('文档类型，缺省接口'),
          description: z.string().optional().describe('文档描述'),
        },
      },
      async (args) =>
        executeTool(this.logger, 'sync_apipost_document', principal, async () =>
          jsonResult(await this.documents.syncFromApipost(args)),
        ),
    );
  }
}
