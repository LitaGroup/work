import { Injectable, Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SettingsService } from '../../settings/settings.service';
import { createProgressEmitter } from '../mcp-progress';
import { executeTool, markdownResult } from '../work-tools/work-tools.util';
import type {
  McpWorkPrincipal,
  WorkToolRegistrar,
} from '../work-tools/work-tools.types';

/** 平台设置与脚本仓库维护（运维管理能力，仅 lita-work-admin） */
@Injectable()
export class AdminRunTools implements WorkToolRegistrar {
  private readonly logger = new Logger(AdminRunTools.name);

  constructor(private readonly settings: SettingsService) {}

  register(server: McpServer, principal: McpWorkPrincipal): void {
    server.registerTool(
      'get_settings',
      {
        title: '平台设置',
        description:
          '读取平台设置：运行环境、脚本/图片目录、访问域名、飞书 token 来源、GitHub 与 appium-agent 状态。',
        inputSchema: {},
      },
      () =>
        executeTool(this.logger, 'get_settings', principal, async () =>
          markdownResult(await this.settings.renderMarkdown()),
        ),
    );

    server.registerTool(
      'pull_scripts',
      {
        title: '更新脚本仓库',
        description:
          '在脚本根目录更新脚本仓库（git 拉取），git 输出经 progress 实时推送，终态返回结果 Markdown。',
        inputSchema: {},
      },
      async (_args, extra) =>
        executeTool(this.logger, 'pull_scripts', principal, async () => {
          const notify = createProgressEmitter(extra);
          const output: string[] = [];
          let status: 'success' | 'error' = 'success';
          let message = '脚本仓库已更新';
          try {
            await this.settings.spawnPull((line) => {
              output.push(line);
              if (notify) void notify(output.length, line).catch(() => {});
            });
          } catch (error) {
            status = 'error';
            message = error instanceof Error ? error.message : String(error);
          }
          const settings = await this.settings.getSettings();
          return markdownResult(
            [
              '# 更新脚本仓库',
              '',
              `- 脚本根目录：\`${settings.scriptsDir}\``,
              '',
              '## 输出',
              '',
              ...(output.length > 0 ? output : ['（无输出）']),
              '',
              '## 结果',
              '',
              `- 状态：${status}`,
              `- 消息：${message}`,
              '',
            ].join('\n'),
          );
        }),
    );
  }
}
