import { BadRequestException } from '@nestjs/common';
import { normalizeWorkflowDefinition } from './workflow-validation';
import type {
  WorkflowDefinitionJson,
  WorkflowNodeDefinition,
  WorkflowNodeKind,
} from './workflow.types';

const node = (
  key: string,
  kind: WorkflowNodeKind = 'operation',
): WorkflowNodeDefinition => ({
  key,
  name: key,
  kind,
  taskTemplateId: kind === 'operation' || kind === 'approval' ? 1001 : null,
  responsibleWorkerId: kind === 'approval' ? 1002 : null,
  inputFields:
    kind === 'start'
      ? [
          {
            key: 'title',
            label: '标题',
            type: 'text',
            required: true,
            placeholder: null,
            defaultValue: null,
          },
        ]
      : null,
  autoAccept: false,
  description: null,
});

const validDefinition = (): WorkflowDefinitionJson => ({
  startNode: 'start',
  nodes: [
    node('start', 'start'),
    node('submit', 'operation'),
    node('approval', 'approval'),
    node('acceptance', 'acceptance'),
  ],
  edges: [
    { from: 'start', to: 'submit', outcome: null, label: null },
    { from: 'submit', to: 'approval', outcome: 'succeeded', label: null },
    { from: 'submit', to: 'acceptance', outcome: 'failed', label: null },
    { from: 'approval', to: 'acceptance', outcome: 'approved', label: null },
    { from: 'approval', to: 'submit', outcome: 'rejected', label: null },
    { from: 'acceptance', to: '$end', outcome: 'approved', label: null },
    { from: 'acceptance', to: 'submit', outcome: 'rejected', label: null },
  ],
});

const conditionDefinition = (): WorkflowDefinitionJson => ({
  startNode: 'start',
  nodes: [
    node('start', 'start'),
    node('condition', 'condition'),
    node('submit', 'operation'),
    node('acceptance', 'acceptance'),
  ],
  edges: [
    { from: 'start', to: 'condition', outcome: null, label: null },
    {
      from: 'condition',
      to: 'submit',
      outcome: null,
      conditions: [{ field: 'title', operator: 'contains', value: '紧急' }],
      label: null,
    },
    { from: 'condition', to: 'acceptance', outcome: null, label: null },
    { from: 'submit', to: 'acceptance', outcome: 'succeeded', label: null },
    { from: 'acceptance', to: '$end', outcome: 'approved', label: null },
    { from: 'acceptance', to: 'submit', outcome: 'rejected', label: null },
  ],
});

describe('normalizeWorkflowDefinition', () => {
  it('接受完整的四类节点流程', () => {
    expect(normalizeWorkflowDefinition(validDefinition(), true)).toEqual(
      validDefinition(),
    );
  });

  it('草稿允许暂未选择任务定义与机器人', () => {
    const definition = validDefinition();
    definition.nodes = definition.nodes.map((item) =>
      item.kind === 'operation' || item.kind === 'approval'
        ? { ...item, taskTemplateId: null, responsibleWorkerId: null }
        : item,
    );
    const draft = normalizeWorkflowDefinition(definition, false);
    expect(draft.nodes.find((node) => node.kind === 'start')?.key).toBe(
      'start',
    );
    expect(() => normalizeWorkflowDefinition(draft, true)).toThrow(
      '未选择任务定义',
    );
  });

  it('发布要求起始与验收节点有且只有一个', () => {
    const definition = validDefinition();
    definition.nodes = definition.nodes.filter(
      (node) => node.kind !== 'acceptance',
    );
    expect(() => normalizeWorkflowDefinition(definition, true)).toThrow(
      '至少有一个验收节点',
    );
  });

  it('允许多个验收节点', () => {
    const definition = validDefinition();
    const second = node('acceptance-2', 'acceptance');
    definition.nodes.push(second);
    definition.edges.push(
      {
        from: 'approval',
        to: 'acceptance-2',
        outcome: 'rejected',
        label: null,
      },
      {
        from: 'acceptance-2',
        to: '$end',
        outcome: 'approved',
        label: null,
      },
    );
    definition.edges = definition.edges.filter(
      (edge) =>
        !(
          edge.from === 'approval' &&
          edge.outcome === 'rejected' &&
          edge.to === 'submit'
        ),
    );
    const normalized = normalizeWorkflowDefinition(definition, true);
    expect(
      normalized.nodes.filter((node) => node.kind === 'acceptance'),
    ).toHaveLength(2);
  });

  it('验收驳回不能直接流转到流程结束', () => {
    const definition = validDefinition();
    definition.edges = definition.edges.map((edge) =>
      edge.from === 'acceptance' && edge.to === '$end'
        ? { ...edge, outcome: 'rejected' }
        : edge,
    );
    expect(() => normalizeWorkflowDefinition(definition, true)).toThrow(
      '只有验收通过、审批通过/驳回、操作节点的成功/失败结果、判断节点的流转或飞书群消息节点',
    );
  });

  it.each(['approved', 'rejected'] as const)(
    '允许审批节点结果 %s 后直接结束流程',
    (outcome) => {
      const otherOutcome = outcome === 'approved' ? 'rejected' : 'approved';
      const definition: WorkflowDefinitionJson = {
        startNode: 'start',
        nodes: [
          node('start', 'start'),
          node('approval', 'approval'),
          node('acceptance', 'acceptance'),
        ],
        edges: [
          { from: 'start', to: 'approval', outcome: null, label: null },
          {
            from: 'approval',
            to: '$end',
            outcome,
            label: null,
          },
          {
            from: 'approval',
            to: 'acceptance',
            outcome: otherOutcome,
            label: null,
          },
          { from: 'acceptance', to: '$end', outcome: 'approved', label: null },
        ],
      };
      const normalized = normalizeWorkflowDefinition(definition, true);
      expect(
        normalized.edges.filter(
          (edge) => edge.from === 'approval' && edge.to === '$end',
        ),
      ).toHaveLength(1);
    },
  );

  it('允许操作节点成功或失败后直接结束流程', () => {
    const definition: WorkflowDefinitionJson = {
      startNode: 'start',
      nodes: [
        node('start', 'start'),
        node('submit', 'operation'),
        node('acceptance', 'acceptance'),
      ],
      edges: [
        { from: 'start', to: 'submit', outcome: null, label: null },
        { from: 'submit', to: 'acceptance', outcome: 'succeeded', label: null },
        { from: 'submit', to: '$end', outcome: 'failed', label: null },
        { from: 'acceptance', to: '$end', outcome: 'approved', label: null },
      ],
    };
    const normalized = normalizeWorkflowDefinition(definition, true);
    expect(
      normalized.edges.filter(
        (edge) => edge.from === 'submit' && edge.to === '$end',
      ),
    ).toHaveLength(1);
  });

  it('发布时拒绝从起始节点不可达的节点', () => {
    const definition = validDefinition();
    definition.nodes.push(node('unreachable'));
    definition.edges.push({
      from: 'unreachable',
      to: 'acceptance',
      outcome: 'succeeded',
      label: null,
    });
    expect(() => normalizeWorkflowDefinition(definition, true)).toThrow(
      '无法从起始节点到达',
    );
  });

  it('发布时拒绝没有到达结束路径的节点', () => {
    const definition = validDefinition();
    definition.nodes.push(node('trapped-1'), node('trapped-2'));
    definition.edges = definition.edges.filter(
      (edge) => !(edge.from === 'submit' && edge.outcome === 'failed'),
    );
    definition.edges.push(
      {
        from: 'submit',
        to: 'trapped-1',
        outcome: 'failed',
        label: null,
      },
      {
        from: 'trapped-1',
        to: 'trapped-2',
        outcome: 'succeeded',
        label: null,
      },
      {
        from: 'trapped-2',
        to: 'trapped-1',
        outcome: 'failed',
        label: null,
      },
    );
    expect(() => normalizeWorkflowDefinition(definition, true)).toThrow(
      '没有可到达流程结束的路径',
    );
  });

  it('拒绝重复节点标识', () => {
    const definition = validDefinition();
    definition.nodes.push(node('submit'));
    expect(() => normalizeWorkflowDefinition(definition, false)).toThrow(
      BadRequestException,
    );
  });

  it('拒绝不存在的目标节点', () => {
    const definition = validDefinition();
    definition.edges[0].to = 'missing';
    expect(() => normalizeWorkflowDefinition(definition, false)).toThrow(
      '目标节点「missing」不存在',
    );
  });

  it('发布要求审批节点配置负责机器人', () => {
    const definition = validDefinition();
    const approval = definition.nodes.find((node) => node.kind === 'approval');
    if (!approval) throw new Error('审批节点不存在');
    approval.responsibleWorkerId = null;
    expect(() => normalizeWorkflowDefinition(definition, true)).toThrow(
      '未选择负责机器人',
    );
  });

  it('自动验收节点不允许驳回流转', () => {
    const definition = validDefinition();
    const acceptance = definition.nodes.find(
      (node) => node.kind === 'acceptance',
    );
    if (!acceptance) throw new Error('验收节点不存在');
    acceptance.autoAccept = true;
    expect(() => normalizeWorkflowDefinition(definition, true)).toThrow(
      '自动验收',
    );
  });

  it('拒绝同一节点相同结果的重复流转', () => {
    const definition = validDefinition();
    definition.edges.push({
      from: 'acceptance',
      to: '$end',
      outcome: 'approved',
      label: null,
    });
    expect(() => normalizeWorkflowDefinition(definition, false)).toThrow(
      '存在重复流转',
    );
  });

  it('接受带判断节点的流程', () => {
    expect(normalizeWorkflowDefinition(conditionDefinition(), true)).toEqual(
      conditionDefinition(),
    );
  });

  it('判断节点必须恰好一条默认分支', () => {
    const definition = conditionDefinition();
    definition.edges = definition.edges.filter(
      (edge) => !(edge.from === 'condition' && !edge.conditions?.length),
    );
    definition.edges.push({
      from: 'condition',
      to: 'acceptance',
      outcome: null,
      conditions: [{ field: 'title', operator: 'contains', value: '普通' }],
      label: null,
    });
    expect(() => normalizeWorkflowDefinition(definition, true)).toThrow(
      '必须且只能配置一条默认（无条件）流转',
    );
  });

  it('判断节点默认分支不能重复', () => {
    const definition = conditionDefinition();
    definition.nodes.push(node('submit-2'));
    definition.edges = definition.edges.filter(
      (edge) => edge.from !== 'condition',
    );
    definition.edges.push(
      {
        from: 'condition',
        to: 'submit',
        outcome: null,
        label: null,
      },
      {
        from: 'condition',
        to: 'submit-2',
        outcome: null,
        conditions: [{ field: 'title', operator: 'eq', value: 'x' }],
        label: null,
      },
      {
        from: 'condition',
        to: 'acceptance',
        outcome: null,
        label: null,
      },
      { from: 'submit-2', to: 'acceptance', outcome: 'succeeded', label: null },
    );
    expect(() => normalizeWorkflowDefinition(definition, true)).toThrow(
      '必须且只能配置一条默认（无条件）流转',
    );
  });

  it('判断节点的流转不能指定结果', () => {
    const definition = conditionDefinition();
    const edge = definition.edges.find(
      (item) => item.from === 'condition' && item.conditions?.length,
    );
    if (!edge) throw new Error('判断流转不存在');
    edge.outcome = 'succeeded';
    expect(() => normalizeWorkflowDefinition(definition, true)).toThrow(
      '判断节点的流转不能指定结果',
    );
  });

  it('非判断节点不能配置流转条件', () => {
    const definition = conditionDefinition();
    const edge = definition.edges.find((item) => item.from === 'submit');
    if (!edge) throw new Error('操作流转不存在');
    edge.conditions = [{ field: 'title', operator: 'eq', value: 'x' }];
    expect(() => normalizeWorkflowDefinition(definition, true)).toThrow(
      '不是判断节点，不能配置流转条件',
    );
  });

  it('判断条件字段必须存在于起始节点输入', () => {
    const definition = conditionDefinition();
    const edge = definition.edges.find(
      (item) => item.from === 'condition' && item.conditions?.length,
    );
    if (!edge) throw new Error('判断流转不存在');
    edge.conditions = [{ field: 'missing', operator: 'eq', value: 'x' }];
    expect(() => normalizeWorkflowDefinition(definition, true)).toThrow(
      '不在起始节点输入字段中',
    );
  });

  it('判断条件运算符必须匹配字段类型', () => {
    const definition = conditionDefinition();
    const start = definition.nodes.find((item) => item.kind === 'start');
    if (!start) throw new Error('起始节点不存在');
    start.inputFields = [
      {
        key: 'priority',
        label: '优先级',
        type: 'select',
        required: false,
        options: ['高', '低'],
        placeholder: null,
        defaultValue: null,
      },
    ];
    const edge = definition.edges.find(
      (item) => item.from === 'condition' && item.conditions?.length,
    );
    if (!edge) throw new Error('判断流转不存在');
    edge.conditions = [
      { field: 'priority', operator: 'contains', value: '高' },
    ];
    expect(() => normalizeWorkflowDefinition(definition, true)).toThrow(
      '不支持运算符',
    );
  });

  it('数字条件的比较值必须是数字', () => {
    const definition = conditionDefinition();
    const start = definition.nodes.find((item) => item.kind === 'start');
    if (!start) throw new Error('起始节点不存在');
    start.inputFields = [
      {
        key: 'amount',
        label: '金额',
        type: 'number',
        required: false,
        placeholder: null,
        defaultValue: null,
      },
    ];
    const edge = definition.edges.find(
      (item) => item.from === 'condition' && item.conditions?.length,
    );
    if (!edge) throw new Error('判断流转不存在');
    edge.conditions = [{ field: 'amount', operator: 'gt', value: '很多' }];
    expect(() => normalizeWorkflowDefinition(definition, true)).toThrow(
      '比较值必须是数字',
    );
  });

  it('单选条件的比较值必须在选项内', () => {
    const definition = conditionDefinition();
    const start = definition.nodes.find((item) => item.kind === 'start');
    if (!start) throw new Error('起始节点不存在');
    start.inputFields = [
      {
        key: 'priority',
        label: '优先级',
        type: 'select',
        required: false,
        options: ['高', '低'],
        placeholder: null,
        defaultValue: null,
      },
    ];
    const edge = definition.edges.find(
      (item) => item.from === 'condition' && item.conditions?.length,
    );
    if (!edge) throw new Error('判断流转不存在');
    edge.conditions = [{ field: 'priority', operator: 'eq', value: '中' }];
    expect(() => normalizeWorkflowDefinition(definition, true)).toThrow(
      '比较值必须是可选选项之一',
    );
  });

  it('多选字段至少需要一个选项', () => {
    const definition = conditionDefinition();
    const start = definition.nodes.find((item) => item.kind === 'start');
    if (!start) throw new Error('起始节点不存在');
    start.inputFields = [
      {
        key: 'tags',
        label: '标签',
        type: 'multiselect',
        required: false,
        options: [],
        placeholder: null,
        defaultValue: null,
      },
    ];
    expect(() => normalizeWorkflowDefinition(definition, true)).toThrow(
      '多选字段「tags」至少需要一个选项',
    );
  });

  it('多选字段选项去重并允许包含判断', () => {
    const definition = conditionDefinition();
    const start = definition.nodes.find((item) => item.kind === 'start');
    if (!start) throw new Error('起始节点不存在');
    start.inputFields = [
      {
        key: 'tags',
        label: '标签',
        type: 'multiselect',
        required: false,
        options: ['A', 'A', 'B'],
        placeholder: null,
        defaultValue: 'A,B',
      },
    ];
    const edge = definition.edges.find(
      (item) => item.from === 'condition' && item.conditions?.length,
    );
    if (!edge) throw new Error('判断流转不存在');
    edge.conditions = [{ field: 'tags', operator: 'contains', value: 'A' }];
    const normalized = normalizeWorkflowDefinition(definition, true);
    const field = normalized.nodes.find((item) => item.kind === 'start')
      ?.inputFields?.[0];
    expect(field?.options).toEqual(['A', 'B']);
  });

  it('多选条件的比较值必须在选项内', () => {
    const definition = conditionDefinition();
    const start = definition.nodes.find((item) => item.kind === 'start');
    if (!start) throw new Error('起始节点不存在');
    start.inputFields = [
      {
        key: 'tags',
        label: '标签',
        type: 'multiselect',
        required: false,
        options: ['高', '低'],
        placeholder: null,
        defaultValue: null,
      },
    ];
    const edge = definition.edges.find(
      (item) => item.from === 'condition' && item.conditions?.length,
    );
    if (!edge) throw new Error('判断流转不存在');
    edge.conditions = [{ field: 'tags', operator: 'contains', value: '中' }];
    expect(() => normalizeWorkflowDefinition(definition, true)).toThrow(
      '比较值必须是可选选项之一',
    );
  });

  it('多选字段的默认值必须都在选项内', () => {
    const definition = conditionDefinition();
    const start = definition.nodes.find((item) => item.kind === 'start');
    if (!start) throw new Error('起始节点不存在');
    start.inputFields = [
      {
        key: 'tags',
        label: '标签',
        type: 'multiselect',
        required: false,
        options: ['高', '低'],
        placeholder: null,
        defaultValue: '高,中',
      },
    ];
    expect(() => normalizeWorkflowDefinition(definition, true)).toThrow(
      '默认值「中」不在选项中',
    );
  });

  it('单选字段的默认值必须在选项内', () => {
    const definition = conditionDefinition();
    const start = definition.nodes.find((item) => item.kind === 'start');
    if (!start) throw new Error('起始节点不存在');
    start.inputFields = [
      {
        key: 'priority',
        label: '优先级',
        type: 'select',
        required: false,
        options: ['高', '低'],
        placeholder: null,
        defaultValue: '中',
      },
    ];
    expect(() => normalizeWorkflowDefinition(definition, true)).toThrow(
      '默认值「中」不在选项中',
    );
  });

  it('判断节点可以流转到流程结束', () => {
    const definition: WorkflowDefinitionJson = {
      startNode: 'start',
      nodes: [
        node('start', 'start'),
        node('condition', 'condition'),
        node('acceptance', 'acceptance'),
      ],
      edges: [
        { from: 'start', to: 'condition', outcome: null, label: null },
        {
          from: 'condition',
          to: 'acceptance',
          outcome: null,
          conditions: [{ field: 'title', operator: 'contains', value: '验收' }],
          label: null,
        },
        { from: 'condition', to: '$end', outcome: null, label: null },
        { from: 'acceptance', to: '$end', outcome: 'approved', label: null },
      ],
    };
    expect(
      normalizeWorkflowDefinition(definition, true).edges.filter(
        (edge) => edge.from === 'condition' && edge.to === '$end',
      ),
    ).toHaveLength(1);
  });

  it('判断节点不能配置任务定义或机器人', () => {
    const definition = conditionDefinition();
    const condition = definition.nodes.find(
      (item) => item.kind === 'condition',
    );
    if (!condition) throw new Error('判断节点不存在');
    condition.taskTemplateId = 1001;
    expect(() => normalizeWorkflowDefinition(definition, true)).toThrow(
      '判断节点不能配置任务定义或机器人',
    );
  });

  it('判断节点允许不同条件流转到同一目标', () => {
    const definition = conditionDefinition();
    definition.edges.push({
      from: 'condition',
      to: 'submit',
      outcome: null,
      conditions: [{ field: 'title', operator: 'eq', value: '重要' }],
      label: null,
    });
    expect(() => normalizeWorkflowDefinition(definition, true)).not.toThrow();
  });

  it('判断节点相同条件不能重复流转', () => {
    const definition = conditionDefinition();
    definition.edges.push({
      from: 'condition',
      to: 'submit',
      outcome: null,
      conditions: [{ field: 'title', operator: 'contains', value: '紧急' }],
      label: null,
    });
    expect(() => normalizeWorkflowDefinition(definition, true)).toThrow(
      '存在重复的流转条件',
    );
  });
});

describe('迭代字段与飞书群消息节点', () => {
  /** 起始节点带迭代字段、飞书群消息节点直连验收的最小流程 */
  const iterationDefinition = (): WorkflowDefinitionJson => ({
    startNode: 'start',
    nodes: [
      {
        key: 'start',
        name: '发起工单',
        kind: 'start',
        taskTemplateId: null,
        responsibleWorkerId: null,
        inputFields: [
          {
            key: 'iteration',
            label: '迭代',
            type: 'iteration',
            required: true,
            defaultValue: '12',
          },
          {
            key: 'iterations',
            label: '多个迭代',
            type: 'iteration_multi',
            required: false,
            defaultValue: '12,13',
          },
        ],
        autoAccept: false,
        description: null,
      },
      {
        key: 'notify',
        name: '通知群',
        kind: 'feishu-message',
        taskTemplateId: null,
        responsibleWorkerId: null,
        inputFields: null,
        autoAccept: false,
        feishuChatId: 'oc_test',
        feishuChatName: '测试群',
        messageTemplate: '【{{ ticket.code }}】发起迭代 {{ values.iteration }}',
        description: null,
      },
      {
        key: 'acceptance',
        name: '验收',
        kind: 'acceptance',
        taskTemplateId: null,
        responsibleWorkerId: null,
        inputFields: null,
        autoAccept: false,
        description: null,
      },
    ],
    edges: [
      { from: 'start', to: 'notify', outcome: null, label: null },
      { from: 'notify', to: 'acceptance', outcome: null, label: null },
      { from: 'acceptance', to: '$end', outcome: 'approved', label: null },
    ],
  });

  it('接受迭代单选/多选字段并按 ID 归一化默认值', () => {
    const normalized = normalizeWorkflowDefinition(iterationDefinition(), true);
    const fields =
      normalized.nodes.find((node) => node.kind === 'start')?.inputFields ?? [];
    expect(fields.map((field) => [field.type, field.defaultValue])).toEqual([
      ['iteration', '12'],
      ['iteration_multi', '12,13'],
    ]);
  });

  it('接受迭代项单选/多选字段并按 ID 归一化默认值', () => {
    const definition = iterationDefinition();
    const start = definition.nodes.find((item) => item.kind === 'start');
    if (!start) throw new Error('起始节点缺失');
    start.inputFields = [
      {
        key: 'backlog',
        label: '迭代项',
        type: 'backlog',
        required: true,
        defaultValue: '21',
      },
      {
        key: 'backlogs',
        label: '迭代项多选',
        type: 'backlog_multi',
        required: false,
        defaultValue: '21,22',
      },
    ];
    const normalized = normalizeWorkflowDefinition(definition, true);
    const fields =
      normalized.nodes.find((node) => node.kind === 'start')?.inputFields ?? [];
    expect(fields.map((field) => [field.type, field.defaultValue])).toEqual([
      ['backlog', '21'],
      ['backlog_multi', '21,22'],
    ]);
  });

  it('迭代项字段默认值必须是迭代项 ID', () => {
    const definition = iterationDefinition();
    const start = definition.nodes.find((item) => item.kind === 'start');
    if (!start?.inputFields) throw new Error('起始节点缺失');
    start.inputFields[0] = {
      key: 'backlog',
      label: '迭代项',
      type: 'backlog',
      required: true,
      defaultValue: 'BL-0001',
    };
    expect(() => normalizeWorkflowDefinition(definition, true)).toThrow(
      '迭代项字段「backlog」的默认值「BL-0001」必须是迭代项 ID',
    );
  });

  it('迭代字段默认值必须是迭代 ID', () => {
    const definition = iterationDefinition();
    const start = definition.nodes.find((item) => item.kind === 'start');
    if (!start?.inputFields) throw new Error('起始节点缺失');
    start.inputFields[0].defaultValue = 'abc';
    expect(() => normalizeWorkflowDefinition(definition, true)).toThrow(
      '必须是迭代 ID',
    );
  });

  it('迭代字段参与判断条件时比较值必须是迭代 ID', () => {
    const definition = iterationDefinition();
    definition.nodes.push({
      key: 'condition',
      name: '判断迭代',
      kind: 'condition',
      taskTemplateId: null,
      responsibleWorkerId: null,
      inputFields: null,
      autoAccept: false,
      description: null,
    });
    definition.edges = [
      { from: 'start', to: 'condition', outcome: null, label: null },
      {
        from: 'condition',
        to: 'notify',
        outcome: null,
        conditions: [{ field: 'iteration', operator: 'eq', value: 'not-id' }],
        label: null,
      },
      { from: 'condition', to: 'acceptance', outcome: null, label: null },
      { from: 'notify', to: 'acceptance', outcome: null, label: null },
      { from: 'acceptance', to: '$end', outcome: 'approved', label: null },
    ];
    expect(() => normalizeWorkflowDefinition(definition, true)).toThrow(
      '比较值必须是迭代 ID',
    );
    definition.edges[1].conditions = [
      { field: 'iteration', operator: 'eq', value: '12' },
    ];
    expect(() => normalizeWorkflowDefinition(definition, true)).not.toThrow();
  });

  it('飞书群消息节点发布时必须选择群并填写模板', () => {
    const missingChat = iterationDefinition();
    const chatNode = missingChat.nodes.find(
      (item) => item.kind === 'feishu-message',
    );
    if (!chatNode) throw new Error('飞书群消息节点缺失');
    chatNode.feishuChatId = null;
    expect(() => normalizeWorkflowDefinition(missingChat, true)).toThrow(
      '未选择目标飞书群',
    );

    const missingTemplate = iterationDefinition();
    const templateNode = missingTemplate.nodes.find(
      (item) => item.kind === 'feishu-message',
    );
    if (!templateNode) throw new Error('飞书群消息节点缺失');
    templateNode.messageTemplate = '  ';
    expect(() => normalizeWorkflowDefinition(missingTemplate, true)).toThrow(
      '未配置消息模板',
    );
  });

  it('飞书群消息节点只能无条件流转且不能配置任务/机器人', () => {
    const withOutcome = iterationDefinition();
    const outcomeEdge = withOutcome.edges.find(
      (edge) => edge.from === 'notify',
    );
    if (!outcomeEdge) throw new Error('飞书群消息流转缺失');
    outcomeEdge.outcome = 'succeeded';
    expect(() => normalizeWorkflowDefinition(withOutcome, true)).toThrow(
      '飞书群消息节点的流转不能指定结果',
    );

    const withTemplate = iterationDefinition();
    const notifyNode = withTemplate.nodes.find(
      (item) => item.kind === 'feishu-message',
    );
    if (!notifyNode) throw new Error('飞书群消息节点缺失');
    notifyNode.taskTemplateId = 1001;
    expect(() => normalizeWorkflowDefinition(withTemplate, true)).toThrow(
      '飞书群消息节点不能配置任务定义或机器人',
    );
  });

  it('飞书群消息节点可以直接流转到流程结束', () => {
    const definition = iterationDefinition();
    definition.nodes.push({
      key: 'condition',
      name: '判断是否只通知',
      kind: 'condition',
      taskTemplateId: null,
      responsibleWorkerId: null,
      inputFields: null,
      autoAccept: false,
      description: null,
    });
    definition.edges = [
      { from: 'start', to: 'condition', outcome: null, label: null },
      {
        from: 'condition',
        to: 'notify',
        outcome: null,
        conditions: [{ field: 'iteration', operator: 'eq', value: '12' }],
        label: null,
      },
      { from: 'condition', to: 'acceptance', outcome: null, label: null },
      { from: 'notify', to: '$end', outcome: null, label: null },
      { from: 'acceptance', to: '$end', outcome: 'approved', label: null },
    ];
    expect(() => normalizeWorkflowDefinition(definition, true)).not.toThrow();
  });
});
