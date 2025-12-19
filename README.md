# deno-proxy-logger

一层**透明反向代理**：把 OpenAI 兼容 / Gemini
请求转发到上游，同时**不破坏流式输出**，并把“对话相关
body（脱敏后）”持久化保存到 **Deno KV**，提供简易日志查看页面。

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

1. 设置环境变量（PowerShell 示例）：

```powershell
$env:UPSTREAM_BASE_URL="https://wolfholo-gcli.zeabur.app"
$env:UPSTREAM_KEY="xxxxx"
$env:PROXY_TOKEN="your_proxy_token"
$env:LOG_RESPONSE="1"
$env:MAX_LOG_BYTES="32768"
```

2. 启动：

```powershell
cd E:\Download\Monitor\deno-proxy-logger
deno task dev
```

## 部署到 Deno Deploy

通过 Deno Deploy 控制台（`dash.deno.com`）从 GitHub 导入并部署。

1. 打开 Deno Deploy 控制台并登录：`https://dash.deno.com`

2. 创建项目

- 选择 “New Project / Import from GitHub”
- 选择仓库：`TheWiseWolfHolo/deno-proxy-logger`
- 分支：`main`
- 入口文件（Main module / Entrypoint）：`main.ts`

3. 配置环境变量（Project Settings → Environment Variables）

- `UPSTREAM_BASE_URL`（可选，不配则默认 `https://wolfholo-gcli.zeabur.app`）
- `UPSTREAM_KEY`（必填：上游 key，只放服务端）
- `PROXY_TOKEN`（必填：访问你这层代理/日志的 token）
- `LOG_RESPONSE`（可选：`1` 记录响应片段，`0` 只记录请求）
- `MAX_LOG_BYTES`（可选：默认 `32768`）

4. 创建并绑定 Deno KV（Project → Databases / KV）

- 创建一个 KV Database，并绑定到这个项目
- 本项目代码使用 `const kv = await Deno.openKv();`，在 Deploy
  上会自动连接到已绑定的 KV

5. 点击 Deploy 发布

6. 验证

- `GET /health` 返回 `{"ok":true}`
- 浏览器访问 `GET /login?t=<PROXY_TOKEN>` 后再打开 `GET /logs` 查看日志

后续你只要 push 到 GitHub，Deno Deploy 会自动重新部署。

## 使用

- 代理请求：客户端带 `Authorization: Bearer <PROXY_TOKEN>`，其余按 OpenAI/Gemini
  兼容格式照常请求本服务的路径即可。
- 查看日志：先访问 `GET /login?t=<PROXY_TOKEN>` 写入 cookie，然后打开
  `GET /logs`。
