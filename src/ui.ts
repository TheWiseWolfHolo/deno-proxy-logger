import type { LogEntry } from "./log_store.ts";

export function renderLoginPage(params: {
  next: string;
  message?: string;
}): string {
  const { next, message } = params;
  const safeNext = escapeHtml(next);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Proxy Logger Login</title>
    ${baseStyle()}
  </head>
  <body>
    <main class="container">
      <h1>Proxy Logger</h1>
      <p class="muted">请输入 PROXY_TOKEN（只会写入本域名 cookie）。</p>
      ${message ? `<p class="error">${escapeHtml(message)}</p>` : ""}
      <form method="GET" action="/login">
        <input type="hidden" name="next" value="${safeNext}" />
        <label>PROXY_TOKEN</label>
        <input name="t" type="password" autocomplete="current-password" />
        <button type="submit">登录</button>
      </form>
    </main>
  </body>
</html>`;
}

export function renderLogsPage(params: { logs: LogEntry[]; nextBefore?: number }): string {
  const { logs, nextBefore } = params;
  const rows = logs.map((l) => {
    const time = new Date(l.ts).toLocaleString();
    const summary = l.request.summary ?? "";
    const statusClass = l.status >= 200 && l.status < 400 ? "ok" : "bad";
    return `<tr>
      <td class="mono">${escapeHtml(time)}</td>
      <td class="mono">${escapeHtml(l.method)}</td>
      <td class="mono ${statusClass}">${escapeHtml(String(l.status))}</td>
      <td class="mono">${escapeHtml(String(l.durationMs))}ms</td>
      <td class="mono">${escapeHtml(l.path)}</td>
      <td>${escapeHtml(summary)}</td>
      <td class="mono"><a href="/logs/${encodeURIComponent(l.id)}">查看</a></td>
    </tr>`;
  }).join("\n");

  const nextLink = nextBefore ? `<a class="btn" href="/logs?before=${encodeURIComponent(String(nextBefore))}">下一页</a>` : "";

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Proxy Logger - Logs</title>
    ${baseStyle()}
  </head>
  <body>
    <main class="container">
      <div class="row">
        <h1>Logs</h1>
        <div class="spacer"></div>
        <a class="btn" href="/logout">退出</a>
      </div>
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>方法</th>
            <th>状态</th>
            <th>耗时</th>
            <th>路径</th>
            <th>摘要</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows || `<tr><td colspan="7" class="muted">暂无日志</td></tr>`}
        </tbody>
      </table>
      <div class="row" style="margin-top: 16px;">
        ${nextLink}
      </div>
    </main>
  </body>
</html>`;
}

export function renderLogDetailPage(params: { log: LogEntry }): string {
  const { log } = params;
  const time = new Date(log.ts).toLocaleString();
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Proxy Logger - ${escapeHtml(log.id)}</title>
    ${baseStyle()}
  </head>
  <body>
    <main class="container">
      <div class="row">
        <h1>Log 详情</h1>
        <div class="spacer"></div>
        <a class="btn" href="/logs">返回</a>
      </div>

      <div class="card">
        <div><span class="muted">时间：</span><span class="mono">${escapeHtml(time)}</span></div>
        <div><span class="muted">方法：</span><span class="mono">${escapeHtml(log.method)}</span></div>
        <div><span class="muted">路径：</span><span class="mono">${escapeHtml(log.path)}</span></div>
        <div><span class="muted">状态：</span><span class="mono">${escapeHtml(String(log.status))}</span></div>
        <div><span class="muted">耗时：</span><span class="mono">${escapeHtml(String(log.durationMs))}ms</span></div>
        ${log.error ? `<div><span class="muted">错误：</span><span class="mono error">${escapeHtml(log.error)}</span></div>` : ""}
      </div>

      <h2>Request（脱敏后）</h2>
      <div class="card">
        ${log.request.model ? `<div><span class="muted">model：</span><span class="mono">${escapeHtml(log.request.model)}</span></div>` : ""}
        ${typeof log.request.isStream === "boolean"
    ? `<div><span class="muted">stream：</span><span class="mono">${escapeHtml(String(log.request.isStream))}</span></div>`
    : ""}
        ${log.request.truncated ? `<div class="muted">（请求日志已截断）</div>` : ""}
        ${renderJsonOrText(log.request.bodyJson, log.request.bodyText)}
      </div>

      <h2>Response（脱敏后，片段）</h2>
      <div class="card">
        <div><span class="muted">stream：</span><span class="mono">${escapeHtml(String(log.response.stream))}</span></div>
        ${log.response.aborted ? `<div class="muted">（客户端中途断开，响应片段为已捕获部分）</div>` : ""}
        ${log.response.truncated ? `<div class="muted">（响应片段已截断）</div>` : ""}
        <pre class="mono">${escapeHtml(log.response.snippetText ?? "")}</pre>
      </div>
    </main>
  </body>
</html>`;
}

function renderJsonOrText(json: unknown, text: string | undefined): string {
  if (json !== undefined) {
    return `<pre class="mono">${escapeHtml(JSON.stringify(json, null, 2))}</pre>`;
  }
  return `<pre class="mono">${escapeHtml(text ?? "")}</pre>`;
}

function baseStyle(): string {
  return `<style>
    :root { color-scheme: light dark; }
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 0; }
    .container { max-width: 1100px; margin: 0 auto; padding: 24px; }
    .row { display: flex; align-items: center; gap: 12px; }
    .spacer { flex: 1; }
    .muted { opacity: .7; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .card { border: 1px solid rgba(127,127,127,.25); border-radius: 12px; padding: 12px; margin: 12px 0; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px 8px; border-bottom: 1px solid rgba(127,127,127,.15); vertical-align: top; }
    th { text-align: left; }
    a { color: inherit; }
    .btn { display: inline-block; padding: 8px 12px; border: 1px solid rgba(127,127,127,.35); border-radius: 10px; text-decoration: none; }
    input { width: 100%; padding: 10px 12px; margin: 8px 0 12px; border-radius: 10px; border: 1px solid rgba(127,127,127,.35); }
    button { padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(127,127,127,.35); background: transparent; cursor: pointer; }
    pre { white-space: pre-wrap; word-break: break-word; margin: 0; }
    .ok { color: #1a7f37; }
    .bad { color: #cf222e; }
    .error { color: #cf222e; }
  </style>`;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}


