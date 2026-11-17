import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { TaskStatus, TaskSubStatus } from '../common/enums';
import type { User } from '../auth/user.entity';
import { Task } from '../tasks/task.entity';
import type { Worker } from '../workers/worker.entity';
import { Wakeup } from './wakeup.entity';
import {
  parseWakeAt,
  resolveAgentScope,
  resolveWakeAt,
  WakeupsService,
} from './wakeups.service';

describe('WakeupsService 机器人定时唤醒', () => {
  const baseTask = (over: Partial<Task> = {}): Task =>
    ({
      id: 42,
      code: 'TK-0042',
      title: '长任务等待确认',
      status: TaskStatus.RUNNING,
      subStatus: TaskSubStatus.EXECUTING,
      agentId: 1001,
      resumePrompt: null,
      remindCount: 1,
      firstRemindedAt: new Date(),
      lastRemindedAt: new Date(),
      ...over,
    }) as Task;

  const baseWakeup = (over: Partial<Wakeup> = {}): Wakeup => ({
    id: 7,
    kind: 'task',
    taskId: 42,
    userId: null,
    scope: null,
    workerId: 1001,
    note: '检查工单是否完成',
    wakeAt: new Date('2026-11-17T03:00:00Z'),
    status: 'scheduled',
    attempts: 0,
    lastAttemptAt: null,
    nextRetryAt: null,
    lastError: null,
    deliveredAt: null,
    canceledAt: null,
    canceledReason: null,
    processedAt: null,
    createdAt: new Date('2026-11-17T02:00:00Z'),
    updatedAt: new Date('2026-11-17T02:00:00Z'),
    ...over,
  });

  const worker = { id: 1001, name: 'AI-执行' } as Worker;
  const user = { id: 9, name: '张三' } as User;

  let wakeupsRepo: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };
  let tasksRepo: { findOne: jest.Mock; update: jest.Mock };
  let usersRepo: { findOne: jest.Mock };
  let dispatch: {
    taskChatRunning: jest.Mock;
    continueConversation: jest.Mock;
  };
  let tasksService: { addEvent: jest.Mock };
  let personalAgents: { findForUser: jest.Mock; send: jest.Mock };
  let service: WakeupsService;

  beforeEach(() => {
    wakeupsRepo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((value: unknown) => value),
      save: jest.fn((value: Record<string, unknown>) => ({ ...value, id: 7 })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    tasksRepo = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    usersRepo = { findOne: jest.fn().mockResolvedValue(user) };
    dispatch = {
      taskChatRunning: jest.fn().mockReturnValue(false),
      continueConversation: jest.fn().mockResolvedValue(undefined),
    };
    tasksService = { addEvent: jest.fn().mockResolvedValue(undefined) };
    personalAgents = {
      findForUser: jest.fn().mockResolvedValue({ id: 2001 }),
      send: jest.fn().mockResolvedValue(undefined),
    };
    service = new WakeupsService(
      wakeupsRepo as never,
      tasksRepo as never,
      usersRepo as never,
      dispatch as never,
      tasksService as never,
      personalAgents as never,
    );
  });

  describe('时间与范围解析', () => {
    it('delayMinutes 与 wakeAt 必须二选一', () => {
      expect(() => resolveWakeAt({})).toThrow(BadRequestException);
      expect(() =>
        resolveWakeAt({
          delayMinutes: 10,
          wakeAt: '2026-11-18T09:00:00+08:00',
        }),
      ).toThrow(BadRequestException);
    });

    it('delayMinutes 需在 30 秒 ~ 30 天之间', () => {
      expect(() => resolveWakeAt({ delayMinutes: 0.1 })).toThrow(
        BadRequestException,
      );
      expect(() => resolveWakeAt({ delayMinutes: 43_201 })).toThrow(
        BadRequestException,
      );
      const now = new Date('2026-11-17T02:00:00Z');
      expect(resolveWakeAt({ delayMinutes: 30 }, now).toISOString()).toBe(
        '2026-11-17T02:30:00.000Z',
      );
    });

    it('不带时区的 wakeAt 按北京时间解释', () => {
      expect(parseWakeAt('2026-11-18 09:00').toISOString()).toBe(
        '2026-11-18T01:00:00.000Z',
      );
      expect(parseWakeAt('2026-11-18T09:00:00+08:00').toISOString()).toBe(
        '2026-11-18T01:00:00.000Z',
      );
      expect(() => parseWakeAt('明天上午')).toThrow(BadRequestException);
    });

    it('过去的唤醒时间被拒绝', () => {
      const now = new Date('2026-11-17T02:00:00Z');
      expect(() =>
        resolveWakeAt({ wakeAt: '2026-11-17T09:00:00' }, now),
      ).toThrow(BadRequestException);
    });

    it('我的 AI 会话范围推导', () => {
      expect(resolveAgentScope({})).toBe('agent:global');
      expect(resolveAgentScope({ taskId: 42 })).toBe('agent:task:42');
      expect(resolveAgentScope({ pageType: 'backlog', pageId: '5' })).toMatch(
        /^agent:page:backlog:[0-9a-f]{20}$/,
      );
      expect(() =>
        resolveAgentScope({ pageType: 'unknown', pageId: '5' }),
      ).toThrow(BadRequestException);
      expect(() => resolveAgentScope({ pageType: 'backlog' })).toThrow(
        BadRequestException,
      );
    });
  });

  describe('设置与取消', () => {
    it('仅任务当前执行机器人可设置', async () => {
      tasksRepo.findOne.mockResolvedValue(baseTask());
      await expect(
        service.scheduleTask({ id: 2002, name: '其它' } as Worker, {
          taskId: 42,
          delayMinutes: 10,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(wakeupsRepo.save).not.toHaveBeenCalled();
    });

    it('任务已结束不能设置', async () => {
      tasksRepo.findOne.mockResolvedValue(
        baseTask({
          status: TaskStatus.FINISHED,
          subStatus: TaskSubStatus.COMPLETED,
        }),
      );
      await expect(
        service.scheduleTask(worker, { taskId: 42, delayMinutes: 10 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('任务不存在时报错', async () => {
      tasksRepo.findOne.mockResolvedValue(null);
      await expect(
        service.scheduleTask(worker, { taskId: 42, delayMinutes: 10 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('覆盖旧的唤醒并落库 + 写任务事件', async () => {
      tasksRepo.findOne.mockResolvedValue(baseTask());
      wakeupsRepo.update.mockResolvedValue({ affected: 1 });
      const result = await service.scheduleTask(worker, {
        taskId: 42,
        delayMinutes: 30,
        note: '  检查脚本进度  ',
      });
      expect(wakeupsRepo.update).toHaveBeenCalledWith(
        { kind: 'task', taskId: 42, status: 'scheduled' },
        expect.objectContaining({
          status: 'canceled',
          canceledReason: 'replaced',
        }),
      );
      expect(wakeupsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'task',
          taskId: 42,
          workerId: 1001,
          note: '检查脚本进度',
          status: 'scheduled',
        }),
      );
      expect(result.replaced).toBe(true);
      expect(result.wakeup.id).toBe(7);
      expect(tasksService.addEvent).toHaveBeenCalledWith(
        42,
        '系统',
        expect.stringContaining('检查脚本进度') as string,
        null,
        expect.objectContaining({ wakeupId: 7 }) as unknown,
      );
    });

    it('备注超长时拒绝', async () => {
      tasksRepo.findOne.mockResolvedValue(baseTask());
      await expect(
        service.scheduleTask(worker, {
          taskId: 42,
          delayMinutes: 5,
          note: 'x'.repeat(2001),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('我的 AI 唤醒需要登录用户与个人 AGENT', async () => {
      await expect(
        service.scheduleAgent(undefined, { delayMinutes: 10 }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      personalAgents.findForUser.mockResolvedValue(null);
      await expect(
        service.scheduleAgent(user, { delayMinutes: 10 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('我的 AI 唤醒按会话范围落库', async () => {
      await service.scheduleAgent(user, {
        delayMinutes: 10,
        taskId: 42,
        note: '跟进验收',
      });
      expect(wakeupsRepo.update).toHaveBeenCalledWith(
        {
          kind: 'agent',
          userId: 9,
          scope: 'agent:task:42',
          status: 'scheduled',
        },
        expect.objectContaining({ status: 'canceled' }),
      );
      expect(wakeupsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'agent',
          taskId: 42,
          userId: 9,
          scope: 'agent:task:42',
          workerId: 2001,
        }),
      );
    });

    it('取消唤醒返回受影响条数', async () => {
      tasksRepo.findOne.mockResolvedValue(baseTask());
      wakeupsRepo.update.mockResolvedValue({ affected: 1 });
      await expect(service.cancelTask(worker, 42)).resolves.toBe(1);
      await expect(
        service.cancelTask({ id: 2002, name: '其它' } as Worker, 42),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.cancelAgent(user, { taskId: 42 })).resolves.toBe(1);
    });
  });

  describe('到期投递', () => {
    it('任务已结束只记录不唤醒', async () => {
      wakeupsRepo.findOne.mockResolvedValue(baseWakeup());
      tasksRepo.findOne.mockResolvedValue(
        baseTask({
          status: TaskStatus.FINISHED,
          subStatus: TaskSubStatus.COMPLETED,
        }),
      );
      await service.deliver(7);
      expect(wakeupsRepo.update).toHaveBeenCalledWith(
        { id: 7, status: expect.anything() as unknown },
        expect.objectContaining({ status: 'recorded' }),
      );
      expect(dispatch.continueConversation).not.toHaveBeenCalled();
      expect(tasksRepo.update).not.toHaveBeenCalled();
    });

    it('任务不存在时标记 dead', async () => {
      wakeupsRepo.findOne.mockResolvedValue(baseWakeup());
      tasksRepo.findOne.mockResolvedValue(null);
      await service.deliver(7);
      expect(wakeupsRepo.update).toHaveBeenCalledWith(
        { id: 7, status: expect.anything() as unknown },
        expect.objectContaining({ status: 'dead' }),
      );
    });

    it('回合仍在执行时直投当前会话并写事件', async () => {
      wakeupsRepo.findOne.mockResolvedValue(baseWakeup());
      tasksRepo.findOne.mockResolvedValue(baseTask());
      dispatch.taskChatRunning.mockReturnValue(true);
      await service.deliver(7);
      expect(dispatch.continueConversation).toHaveBeenCalledWith(
        42,
        expect.stringContaining('检查工单是否完成'),
        '定时唤醒',
      );
      expect(tasksService.addEvent).toHaveBeenCalledWith(
        42,
        '系统',
        expect.stringContaining('定时唤醒触发') as string,
        null,
        expect.objectContaining({ wakeupId: 7 }) as unknown,
      );
      expect(tasksRepo.update).not.toHaveBeenCalled();
    });

    it('执行中但回合已结束时转待继续', async () => {
      wakeupsRepo.findOne.mockResolvedValue(baseWakeup());
      tasksRepo.findOne.mockResolvedValue(baseTask());
      dispatch.taskChatRunning.mockReturnValue(false);
      await service.deliver(7);
      expect(tasksRepo.update).toHaveBeenCalledWith(
        {
          id: 42,
          status: TaskStatus.RUNNING,
          subStatus: TaskSubStatus.EXECUTING,
        },
        expect.objectContaining({
          status: TaskStatus.WAITING,
          subStatus: TaskSubStatus.PENDING_RESUME,
          resumePrompt: expect.stringContaining('定时唤醒') as string,
        }),
      );
    });

    it('待申请验收 / 待验收到期转待继续', async () => {
      wakeupsRepo.findOne.mockResolvedValue(baseWakeup());
      tasksRepo.findOne.mockResolvedValue(
        baseTask({
          status: TaskStatus.WAITING,
          subStatus: TaskSubStatus.PENDING_ACCEPT,
        }),
      );
      await service.deliver(7);
      expect(tasksRepo.update).toHaveBeenCalledWith(
        {
          id: 42,
          status: TaskStatus.WAITING,
          subStatus: TaskSubStatus.PENDING_ACCEPT,
        },
        expect.objectContaining({
          subStatus: TaskSubStatus.PENDING_RESUME,
          remindCount: 0,
        }),
      );
    });

    it('待反馈时暂不投递并按退避重试', async () => {
      wakeupsRepo.findOne.mockResolvedValue(baseWakeup());
      tasksRepo.findOne.mockResolvedValue(
        baseTask({
          status: TaskStatus.WAITING,
          subStatus: TaskSubStatus.PENDING_FEEDBACK,
        }),
      );
      await service.deliver(7);
      const [, patch] = wakeupsRepo.update.mock.calls[0] as [
        unknown,
        { status: string; attempts: number; nextRetryAt: Date },
      ];
      expect(patch.status).toBe('scheduled');
      expect(patch.attempts).toBe(1);
      expect(patch.nextRetryAt.getTime()).toBeGreaterThan(Date.now());
      expect(dispatch.continueConversation).not.toHaveBeenCalled();
    });

    it('已在待继续时合并上下文且同一唤醒不重复写入', async () => {
      const task = baseTask({
        status: TaskStatus.WAITING,
        subStatus: TaskSubStatus.PENDING_RESUME,
        resumePrompt: '之前的上下文',
      });
      wakeupsRepo.findOne.mockResolvedValue(baseWakeup());
      tasksRepo.findOne.mockResolvedValue(task);
      await service.deliver(7);
      expect(tasksRepo.update).toHaveBeenCalledWith(
        {
          id: 42,
          status: TaskStatus.WAITING,
          subStatus: TaskSubStatus.PENDING_RESUME,
        },
        { resumePrompt: expect.stringContaining('之前的上下文') as string },
      );

      tasksRepo.update.mockClear();
      tasksRepo.findOne.mockResolvedValue({
        ...task,
        resumePrompt: '之前的上下文\n\n> 唤醒记录 ID：7',
      });
      await service.deliver(7);
      expect(tasksRepo.update).not.toHaveBeenCalled();
    });

    it('我的 AI 唤醒经个人 AGENT 会话投递', async () => {
      wakeupsRepo.findOne.mockResolvedValue(
        baseWakeup({
          kind: 'agent',
          taskId: null,
          userId: 9,
          scope: 'agent:global',
          workerId: 2001,
        }),
      );
      await service.deliver(7);
      expect(personalAgents.send).toHaveBeenCalledWith(
        user,
        expect.stringContaining('定时唤醒'),
        { scope: 'agent:global' },
      );
      expect(wakeupsRepo.update).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ processedAt: expect.any(Date) as Date }),
      );
    });

    it('会话正忙时我的 AI 唤醒退避重试', async () => {
      wakeupsRepo.findOne.mockResolvedValue(
        baseWakeup({
          kind: 'agent',
          taskId: null,
          userId: 9,
          scope: 'agent:global',
          workerId: 2001,
        }),
      );
      personalAgents.send.mockRejectedValue(new Error('机器人正在回复'));
      await service.deliver(7);
      expect(wakeupsRepo.update).toHaveBeenCalledWith(
        { id: 7, status: expect.anything() as unknown },
        expect.objectContaining({
          status: 'scheduled',
          attempts: 1,
          lastError: '机器人正在回复',
        }),
      );
    });

    it('用户或个人 AGENT 缺失时标记 dead', async () => {
      const agentWakeup = baseWakeup({
        kind: 'agent',
        taskId: null,
        userId: 9,
        scope: 'agent:global',
        workerId: 2001,
      });
      wakeupsRepo.findOne.mockResolvedValue(agentWakeup);
      usersRepo.findOne.mockResolvedValue(null);
      await service.deliver(7);
      expect(wakeupsRepo.update).toHaveBeenCalledWith(
        { id: 7, status: expect.anything() as unknown },
        expect.objectContaining({ status: 'dead' }),
      );
      expect(personalAgents.send).not.toHaveBeenCalled();
    });

    it('扫描到期唤醒并逐条投递', async () => {
      wakeupsRepo.find.mockResolvedValue([baseWakeup()]);
      const deliver = jest.spyOn(service, 'deliver').mockResolvedValue();
      await service.processDue();
      expect(deliver).toHaveBeenCalledWith(7);
    });
  });
});
