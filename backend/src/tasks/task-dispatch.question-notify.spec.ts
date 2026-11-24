import { TaskDispatchService } from './task-dispatch.service';

// 固定「任务待反馈」推送暂停（避免依赖运维开关当前取值）
jest.mock('./task-loop.rules', () => ({
  ...jest.requireActual<Record<string, unknown>>('./task-loop.rules'),
  TASK_PENDING_FEEDBACK_NOTIFY_PAUSED: true,
}));

describe('TaskDispatchService 提问提醒', () => {
  it('「任务待反馈」推送暂停时不私聊通知需求方', async () => {
    const taskNotify = {
      notifyTaskRequester: jest.fn().mockResolvedValue({ sent: true }),
    };
    const service = new TaskDispatchService(
      { findOne: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      taskNotify as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        recordTurnStart: jest.fn().mockResolvedValue(undefined),
        recordMessageIn: jest.fn().mockResolvedValue(undefined),
        recordTaskEvent: jest.fn().mockResolvedValue(undefined),
        finalize: jest.fn().mockResolvedValue(undefined),
      } as never,
      {} as never,
      { get: jest.fn() } as never,
    );

    await service['notifyQuestion'](1, {
      id: 'q-1',
      sessionID: 'oc-1',
      questions: [{ header: '需求澄清', question: '请确认活动时间' }],
    });

    expect(taskNotify.notifyTaskRequester).not.toHaveBeenCalled();
  });
});
