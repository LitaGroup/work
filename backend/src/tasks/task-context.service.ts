import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { BacklogStatus } from '../common/enums';
import { Backlog } from '../iterations/backlog.entity';
import { Iteration } from '../iterations/iteration.entity';
import { Ticket } from '../tickets/ticket.entity';
import { TicketWorkflowRun } from '../tickets/ticket-workflow-run.entity';
import { Task } from './task.entity';

/** 任务树渲染上限：超出后截断并标注，避免上下文过长 */
const TASK_TREE_LIMIT = 200;
/** 相关工单渲染上限 */
const TICKET_LIMIT = 50;

/** 任务树节点渲染所需的轻量字段 */
interface TaskTreeRow {
  id: number;
  code: string;
  title: string;
  status: string;
  subStatus: string;
  parentId: number | null;
  handoffPath: string | null;
  handoffVersion: number;
}

/** 相关工单渲染所需的轻量字段 */
interface TicketRow {
  id: number;
  code: string;
  title: string;
  workflowStatus: string | null;
  currentNodeName: string | null;
  updatedAt: Date;
}

/**
 * 子任务上下文构建：任务树 + 迭代 + 相关工单 + 交付文档 + MCP 读取指引。
 *
 * 只注入 Repository（不依赖其它业务服务），供任务协同与迭代项两条
 * 「任务下创建子任务」入口共用，避免服务之间循环依赖。
 */
@Injectable()
export class TaskContextService {
  constructor(
    @InjectRepository(Task)
    private readonly taskRows: Repository<Task>,
    @InjectRepository(Ticket)
    private readonly ticketRows: Repository<Ticket>,
    @InjectRepository(TicketWorkflowRun)
    private readonly ticketRunRows: Repository<TicketWorkflowRun>,
    @InjectRepository(Backlog)
    private readonly backlogs: Repository<Backlog>,
    @InjectRepository(Iteration)
    private readonly iterations: Repository<Iteration>,
  ) {}

  /**
   * 生成「## 上下文（系统附加）」块：
   * - 任务树：根任务起的全部任务，缩进层级、标题、ID、状态与交付文档版本；
   * - 迭代：交付任务关联的迭代项与所属迭代（含描述）；
   * - 相关工单：任务树上的工单与迭代项工单（去重，最近更新在前）；
   * - 交付文档：树内已创建 HANDOFF 的任务清单；
   * - 读取指引：lita-work MCP 工具入口，便于机器人按需获取详情。
   */
  async buildSubtaskContext(parentTaskId: number): Promise<string> {
    const parent = await this.taskRows.findOne({
      where: { id: parentTaskId },
      select: { id: true, rootId: true, projectId: true },
    });
    const rootId = parent?.rootId ?? parent?.id ?? parentTaskId;

    const rows = await this.taskRows.find({
      where: [{ id: rootId }, { rootId }],
      select: {
        id: true,
        code: true,
        title: true,
        status: true,
        subStatus: true,
        parentId: true,
        handoffPath: true,
        handoffVersion: true,
      },
      order: { id: 'ASC' },
      take: TASK_TREE_LIMIT + 1,
    });
    const truncated = rows.length > TASK_TREE_LIMIT;
    const tree = truncated ? rows.slice(0, TASK_TREE_LIMIT) : rows;
    const taskIds = tree.map((row) => row.id);

    const backlog = await this.findBacklog(taskIds, parent?.projectId ?? null);
    const [iteration, tickets] = await Promise.all([
      backlog
        ? this.iterations.findOne({ where: { id: backlog.iterationId } })
        : Promise.resolve(null),
      this.findTickets(taskIds, backlog?.id ?? null),
    ]);

    const lines = ['## 上下文（系统附加）', '', '### 任务树'];
    const treeLines = this.renderTree(tree, parentTaskId);
    if (treeLines.length === 0) {
      lines.push('（无任务树数据）');
    } else {
      lines.push(...treeLines);
      if (truncated) {
        lines.push('', `（任务树超过 ${TASK_TREE_LIMIT} 个节点，已截断）`);
      }
    }

    lines.push('', '### 迭代');
    if (backlog) {
      lines.push(
        `- 迭代项：#${backlog.id} ${backlog.code} ${backlog.title}（${backlog.status}）`,
      );
    }
    if (iteration) {
      const description = iteration.description?.trim();
      lines.push(
        `- 迭代：#${iteration.id} ${iteration.code}（${iteration.type}）${
          description ? `——${description}` : ''
        }`,
      );
    }
    if (!backlog && !iteration) {
      lines.push('（无关联迭代）');
    }

    lines.push('', '### 相关工单');
    if (tickets.length === 0) {
      lines.push('（无相关工单）');
    } else {
      for (const ticket of tickets) {
        lines.push(
          `- #${ticket.id} ${ticket.code} ${ticket.title}（${this.ticketStatusText(
            ticket,
          )}）`,
        );
      }
      if (tickets.length >= TICKET_LIMIT) {
        lines.push('', `（仅列最近更新的 ${TICKET_LIMIT} 条工单）`);
      }
    }

    lines.push('', '### 交付文档');
    const handoffTasks = tree.filter((row) => row.handoffPath);
    if (handoffTasks.length === 0) {
      lines.push('（暂无交付文档）');
    } else {
      for (const row of handoffTasks) {
        lines.push(
          `- #${row.id} ${row.code} ${row.title}：HANDOFF v${row.handoffVersion}`,
        );
      }
    }

    lines.push(
      '',
      '### 读取详情（lita-work MCP）',
      '- 任务：`get_task`（taskId）',
      '- 工单：`get_ticket`（ticketId）/ `get_task_ticket`（taskId）',
      '- 迭代项：`get_backlog`（backlogId）；迭代：`get_iteration`（iterationId）',
      '- 交付文档：`read_task_handoff`（taskId）；任务文档：`list_task_documents`（taskId）',
      '- 工单文档：`list_ticket_documents`（taskId）',
    );

    return lines.join('\n');
  }

  /**
   * 迭代项定位：优先按交付任务匹配（backlogs.taskId），
   * 其次按任务所属项目找未取消迭代项（同一需求同时只允许一个未取消迭代项）。
   */
  private async findBacklog(
    taskIds: number[],
    projectId: number | null,
  ): Promise<Backlog | null> {
    if (taskIds.length > 0) {
      const byTask = await this.backlogs.findOne({
        where: { taskId: In(taskIds) },
        order: { id: 'ASC' },
      });
      if (byTask) return byTask;
    }
    if (projectId !== null) {
      return this.backlogs.findOne({
        where: { projectId, status: Not(BacklogStatus.CANCELED) },
        order: { id: 'DESC' },
      });
    }
    return null;
  }

  /** 相关工单：任务树上的工单 + 节点运行任务 + 迭代项直接关联工单，去重后按更新时间倒序。 */
  private async findTickets(
    taskIds: number[],
    backlogId: number | null,
  ): Promise<TicketRow[]> {
    const select = {
      id: true,
      code: true,
      title: true,
      workflowStatus: true,
      currentNodeName: true,
      updatedAt: true,
    } as const;
    const [taskTickets, runs, backlogTickets] = await Promise.all([
      taskIds.length > 0
        ? this.ticketRows.find({
            where: { taskId: In(taskIds) },
            select,
          })
        : Promise.resolve([]),
      taskIds.length > 0
        ? this.ticketRunRows.find({
            where: { taskId: In(taskIds) },
            select: { ticketId: true },
          })
        : Promise.resolve([]),
      backlogId !== null
        ? this.ticketRows.find({ where: { backlogId }, select })
        : Promise.resolve([]),
    ]);
    const runTicketIds = [...new Set(runs.map((run) => run.ticketId))];
    const runTickets =
      runTicketIds.length > 0
        ? await this.ticketRows.find({
            where: { id: In(runTicketIds) },
            select,
          })
        : [];
    const unique = new Map<number, TicketRow>();
    for (const ticket of [...taskTickets, ...runTickets, ...backlogTickets]) {
      unique.set(ticket.id, ticket);
    }
    return [...unique.values()]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, TICKET_LIMIT);
  }

  /** 缩进层级渲染任务树；父节点缺失的孤儿节点挂到根层级，防御历史脏数据。 */
  private renderTree(rows: TaskTreeRow[], parentTaskId: number): string[] {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const children = new Map<number | null, TaskTreeRow[]>();
    for (const row of rows) {
      const parentKey =
        row.parentId !== null && byId.has(row.parentId) ? row.parentId : null;
      const list = children.get(parentKey) ?? [];
      list.push(row);
      children.set(parentKey, list);
    }
    const lines: string[] = [];
    const visited = new Set<number>();
    const walk = (parentKey: number | null, depth: number) => {
      for (const row of children.get(parentKey) ?? []) {
        if (visited.has(row.id)) continue;
        visited.add(row.id);
        const handoff = row.handoffPath
          ? `｜HANDOFF v${row.handoffVersion}`
          : '';
        const current = row.id === parentTaskId ? ' ← 在此任务下创建' : '';
        lines.push(
          `${'  '.repeat(depth)}- #${row.id} ${row.code} ${row.title}（${row.status}-${row.subStatus}）${handoff}${current}`,
        );
        walk(row.id, depth + 1);
      }
    };
    walk(null, 0);
    return lines;
  }

  private ticketStatusText(ticket: TicketRow): string {
    const status = ticket.workflowStatus?.trim() || '未知状态';
    return ticket.currentNodeName
      ? `${status}/${ticket.currentNodeName}`
      : status;
  }
}
