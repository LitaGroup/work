import { Injectable, Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DocumentType, ProjectType } from '../../common/enums';
import { DocumentsService } from '../../documents/documents.service';
import { ProjectsService } from '../../projects/projects.service';
import { executeTool, jsonResult, markdownResult } from './work-tools.util';
import type { McpWorkPrincipal, WorkToolRegistrar } from './work-tools.types';

const DocumentTypeArg = z.enum(
  Object.values(DocumentType) as [DocumentType, ...DocumentType[]],
);

const ProjectTypeArg = z
  .enum(Object.values(ProjectType) as [ProjectType, ...ProjectType[]])
  .describe('项目类型：活动/功能/游戏/数据/后台/技术/其它');

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
      'create_project',
      {
        title: '创建需求',
        description:
          '在需求池新建需求（项目实体）。名称必填；类型缺省「其它」。创建后平台会在摘要/描述为空时后台自动生成（不阻塞返回）。返回需求 .md 详情。',
        inputSchema: {
          name: z.string().min(1).max(200).describe('需求名称'),
          type: ProjectTypeArg.optional().describe('项目类型（缺省其它）'),
          expectedReleaseAt: z
            .string()
            .optional()
            .describe('预期发布时间（YYYY-MM-DD，可空）'),
          description: z
            .string()
            .optional()
            .describe('需求描述（Markdown，可空）'),
        },
      },
      async (args) =>
        executeTool(this.logger, 'create_project', principal, async () => {
          const project = await this.projects.create({
            name: args.name,
            type: args.type,
            expectedReleaseAt: args.expectedReleaseAt,
            description: args.description,
          });
          return markdownResult(
            await this.projects.findOneRequirementMarkdown(project.id),
          );
        }),
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

    server.registerTool(
      'create_document',
      {
        title: '新建项目文档',
        description:
          '在需求下新建文档（与 upsert_document 的区别：不按 fileName 判重，每次显式新建）。传 url 时创建链接型文档（不存正文，通常用于「设计」类型）；正文型文档写入知识库并自动关联原始需求的未取消迭代项。',
        inputSchema: {
          projectId: z.number().int().positive().describe('需求 ID'),
          title: z.string().min(1).describe('文档标题'),
          type: DocumentTypeArg.describe('文档类型'),
          content: z
            .string()
            .optional()
            .describe('Markdown 正文（链接型设计文档不传）'),
          url: z
            .string()
            .optional()
            .describe(
              '外部链接（type=设计 时创建链接型文档，须为 http(s) 完整链接）',
            ),
        },
      },
      async (args) =>
        executeTool(this.logger, 'create_document', principal, async () => {
          const doc = await this.documents.createMarkdown({
            projectId: args.projectId,
            title: args.title,
            type: args.type,
            content: args.content,
            url: args.url,
          });
          return markdownResult(await this.documents.findOneMarkdown(doc.id));
        }),
    );

    server.registerTool(
      'sync_feishu_document',
      {
        title: '导入飞书文档',
        description:
          '从飞书文档 / 多维表格链接单向导入为需求文档（同一项目相同来源文档重复导入覆盖更新，正文只读）。',
        inputSchema: {
          projectId: z.number().int().positive().describe('需求 ID'),
          type: DocumentTypeArg.describe('文档类型'),
          url: z.string().min(1).describe('飞书文档或多维表格链接'),
          description: z.string().optional().describe('文档描述'),
        },
      },
      async (args) =>
        executeTool(
          this.logger,
          'sync_feishu_document',
          principal,
          async () => {
            const doc = await this.documents.syncFromFeishu({
              projectId: args.projectId,
              type: args.type,
              url: args.url,
              description: args.description,
            });
            return markdownResult(await this.documents.findOneMarkdown(doc.id));
          },
        ),
    );

    server.registerTool(
      'update_document_remark',
      {
        title: '更新文档备注',
        description:
          '更新文档备注（任何来源都可编辑，空串清除）。备注供 AI 阅读与检索参考。',
        inputSchema: {
          documentId: z.number().int().positive().describe('文档 ID'),
          remark: z.string().describe('备注内容（空串清除）'),
        },
      },
      async (args) =>
        executeTool(
          this.logger,
          'update_document_remark',
          principal,
          async () => {
            await this.documents.updateRemark(args.documentId, args.remark);
            return markdownResult(
              await this.documents.findOneMarkdown(args.documentId),
            );
          },
        ),
    );

    server.registerTool(
      'delete_document',
      {
        title: '删除项目文档',
        description:
          '删除文档（应用层清理知识库镜像与迭代项关联），删除后不可恢复。',
        inputSchema: {
          documentId: z.number().int().positive().describe('文档 ID'),
        },
      },
      async (args) =>
        executeTool(this.logger, 'delete_document', principal, async () => {
          await this.documents.remove(args.documentId);
          return markdownResult(
            `# 文档已删除\n\n- 文档 ID：${args.documentId}`,
          );
        }),
    );
  }
}
