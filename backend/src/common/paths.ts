import * as path from 'path';

/**
 * 图片上传后的本地根目录：环境变量 DIR_IMAGE_WEBROOT，默认 <项目根>/images。
 * 目录经 main.ts 静态挂载，通过 http://{host}/images/{image-path} 对外访问。
 * 注意：需在 ConfigModule 加载 .env 之后调用（bootstrap / Nest 服务内均可）。
 */
export function imageWebroot(): string {
  return path.resolve(
    process.env.DIR_IMAGE_WEBROOT ?? path.resolve(process.cwd(), '../images'),
  );
}

/**
 * 导出产物的本地根目录：环境变量 DIR_EXPORT_WEBROOT，默认 <项目根>/export-files。
 * 每次运行的输出目录为 {exportId}/{runId}/（经脚本参数 --output-dir 传入），
 * 目录经 main.ts 静态挂载，通过 http://{host}/export-files/{exportId}/{runId}/{file} 对外访问。
 * 注意：需在 ConfigModule 加载 .env 之后调用（bootstrap / Nest 服务内均可）。
 */
export function exportWebroot(): string {
  return path.resolve(
    process.env.DIR_EXPORT_WEBROOT ??
      path.resolve(process.cwd(), '../export-files'),
  );
}

/**
 * 通用文件上传后的本地根目录：环境变量 DIR_FILE_WEBROOT，默认 <项目根>/files。
 * 目录经 main.ts 静态挂载，通过 http://{host}/files/{file-path} 公开访问。
 * 注意：需在 ConfigModule 加载 .env 之后调用（bootstrap / Nest 服务内均可）。
 */
export function fileWebroot(): string {
  return path.resolve(
    process.env.DIR_FILE_WEBROOT ?? path.resolve(process.cwd(), '../files'),
  );
}

/**
 * 执行记录（Trace）与评估快照包的私有根目录：环境变量 DIR_TRACE_WEBROOT，默认 <项目根>/traces。
 * 不挂载公开静态路由：JSONL 步骤流与快照包含业务数据，一律经鉴权 API 读取（12.6/12.8）。
 */
export function traceWebroot(): string {
  return path.resolve(
    process.env.DIR_TRACE_WEBROOT ?? path.resolve(process.cwd(), '../traces'),
  );
}
