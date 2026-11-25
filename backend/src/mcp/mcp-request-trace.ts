import type { Response } from 'express';
import type { TraceService } from '../trace/trace.service';
import type { McpWorkPrincipal } from './work-tools/work-tools.types';

/**
 * 执行记录（TECH_DESIGN 12.4）：解析 JSON-RPC tools/call，采集平台调用
 * （工具名/参数/返回/耗时/状态）。响应为 SSE 流，这里透传写入并顺手截取
 * （≤128KB）用于记录。lita-work 与 lita-work-admin 共用。
 */
export function beginMcpTrace(
  trace: TraceService,
  principal: McpWorkPrincipal,
  res: Response,
  body: unknown,
): (() => void) | null {
  const worker = principal.worker;
  if (!worker) return null;
  const calls = extractToolCalls(body);
  if (calls.length === 0) return null;
  const startedAt = Date.now();
  const chunks: string[] = [];
  let captured = 0;
  const originalWrite = (
    typeof res.write === 'function' ? res.write.bind(res) : () => true
  ) as (chunk: unknown, ...args: unknown[]) => boolean;
  res.write = ((chunk: unknown, ...args: unknown[]) => {
    try {
      if (chunk && captured < 128 * 1024) {
        const text =
          typeof chunk === 'string'
            ? chunk
            : Buffer.isBuffer(chunk)
              ? chunk.toString('utf8')
              : '';
        if (text) {
          chunks.push(text);
          captured += text.length;
        }
      }
    } catch {
      /* 忽略捕获失败 */
    }
    return originalWrite(chunk, ...args);
  }) as typeof res.write;

  return () => {
    const responses = parseSseResponses(chunks.join(''));
    for (const call of calls) {
      const response = responses.get(call.id);
      const status = response?.error || response?.isError ? 'error' : 'ok';
      const text = response?.text ?? response?.error ?? '';
      void trace
        .recordPlatformCall({
          workerId: worker.id,
          channel: 'mcp',
          tool: call.name,
          args: call.args,
          status,
          content: text,
          durationMs: Date.now() - startedAt,
          evalItemId: principal.evalContext?.evalItemId ?? null,
          evalTaskId: principal.evalContext?.taskId ?? null,
          taskId:
            numberField(call.args, 'taskId') ??
            numberField(call.args, 'parentTaskId'),
        })
        .catch(() => {});
    }
  };
}

/** 从 JSON-RPC 请求体中提取 tools/call（支持批量） */
function extractToolCalls(body: unknown): Array<{
  id: string | number | null;
  name: string;
  args: Record<string, unknown>;
}> {
  const messages = Array.isArray(body) ? body : [body];
  const calls: Array<{
    id: string | number | null;
    name: string;
    args: Record<string, unknown>;
  }> = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const row = message as {
      id?: string | number | null;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    if (row.method !== 'tools/call' || !row.params?.name) continue;
    calls.push({
      id: row.id ?? null,
      name: row.params.name,
      args: row.params.arguments ?? {},
    });
  }
  return calls;
}

/** 解析 SSE 响应中 JSON-RPC result（按 id 归并文本/错误） */
function parseSseResponses(
  raw: string,
): Map<
  string | number | null,
  { text: string; error?: string; isError?: boolean }
> {
  const map = new Map<
    string | number | null,
    { text: string; error?: string; isError?: boolean }
  >();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const jsonText = trimmed.slice(5).trim();
    if (!jsonText) continue;
    try {
      const payload = JSON.parse(jsonText) as {
        id?: string | number | null;
        result?: {
          isError?: boolean;
          content?: Array<{ type?: string; text?: string }>;
        };
        error?: { message?: string };
      };
      if (payload.error) {
        map.set(payload.id ?? null, {
          text: '',
          error: payload.error.message ?? '调用失败',
          isError: true,
        });
        continue;
      }
      const text = (payload.result?.content ?? [])
        .filter((item) => item.type === 'text' && item.text)
        .map((item) => item.text!)
        .join('\n');
      map.set(payload.id ?? null, {
        text,
        isError: payload.result?.isError === true,
        ...(payload.result?.isError ? { error: text } : {}),
      });
    } catch {
      /* 忽略非 JSON 行 */
    }
  }
  return map;
}

/** 数字字段读取 */
function numberField(
  args: Record<string, unknown>,
  key: string,
): number | null {
  const value = args[key];
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}
