# deno-proxy-logger

一层**透明反向代理**：把 OpenAI 兼容 / Gemini 请求转发到上游，同时**不破坏流式输出**，并把“对话相关 body（脱敏后）”持久化保存到 **Deno KV**，提供简易日志查看页面。

## 功能

- 透明转发到上游：默认 `https://wolfholo-gcli.zeabur.app`
- 流式透传：SSE/Chunk 原样返回（不会为了记录把流式干没）
- 只记录 body：不记录任何请求头（含 Authorization / key）
- 脱敏：递归遮罩 `key/token/authorization` 等字段
- 持久化：Deno KV
- 日志页面：
  - `GET /logs` 列表
  - `GET /logs/:id` 详情
  - `GET /api/logs` / `GET /api/logs/:id`

## 环境变量

参考示例文件：`env.example`

- `UPSTREAM_BASE_URL`：上游 base URL（默认 `https://wolfholo-gcli.zeabur.app`）
- `UPSTREAM_KEY`：上游 key（仅服务端环境变量）
- `PROXY_TOKEN`：访问你这层代理/日志的 token
- `LOG_RESPONSE`：`1` 记录响应片段；`0` 只记录请求
- `MAX_LOG_BYTES`：请求/响应最多记录多少字节（防止单条 KV 太大）

## 本地运行

1) 设置环境变量（PowerShell 示例）：

```powershell
$env:UPSTREAM_BASE_URL="https://wolfholo-gcli.zeabur.app"
$env:UPSTREAM_KEY="xxxxx"
$env:PROXY_TOKEN="your_proxy_token"
$env:LOG_RESPONSE="1"
$env:MAX_LOG_BYTES="32768"
```

2) 启动：

```powershell
cd E:\Download\Monitor\deno-proxy-logger
deno task dev
```

## 部署到 Deno Deploy

在 Deno Deploy 创建项目，入口选择 `main.ts`，然后在项目设置里配置上述环境变量即可。

## 使用

- 代理请求：客户端带 `Authorization: Bearer <PROXY_TOKEN>`，其余按 OpenAI/Gemini 兼容格式照常请求本服务的路径即可。
- 查看日志：先访问 `GET /login?t=<PROXY_TOKEN>` 写入 cookie，然后打开 `GET /logs`。


