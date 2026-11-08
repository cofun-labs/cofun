# Notion Kit

一个 Chrome 扩展：在 Notion 页面旁边打开侧边栏，用 AI 读取和修改当前页面。

```
┌───────────── Chrome ─────────────┐
│ Notion 页面 │ 侧边栏 (React)      │──Bearer <Clerk 会话 JWT>──▶ Worker ──▶ AI Gateway ──▶ Workers AI
│             │  对话                │                           (验证 JWT)
├─────────────┴────────────────────┤      ▲ 读取会话 cookie (Sync Host)
│ 登录标签页 notion-kit.kitfun.cc/login │──────┘  这个页面也由 Worker 提供
└──────────────────────────────────┘
```

## 当前状态

- [x] 在 Notion 标签页上点工具栏图标打开侧边栏
- [x] Clerk 登录：在网页上登录（支持 Google），会话自动同步到扩展
- [x] 对话，流式返回
- [ ] 读取当前 Notion 页面
- [ ] 修改 Notion 页面

## 技术选型

| 部分 | 选型 | 原因 |
|---|---|---|
| 扩展形态 | Chrome MV3 + [Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) | 侧边栏和页面并排显示，不遮挡 Notion；只在 Notion 标签页上启用 |
| 扩展构建 | Vite + React + TypeScript | Clerk 的扩展 SDK 基于 React；Vite 配置少，不引入 Plasmo 这类扩展框架 |
| 登录 | [Clerk](https://clerk.com) (`@clerk/chrome-extension`) + [Sync Host](https://clerk.com/docs/references/chrome-extension/sync-host) | 现成的登录 UI 和会话管理；后端只需用公钥验证 JWT。Google 等第三方登录需要跳转回来，Chrome 侧边栏不支持，所以改在普通网页上登录，再同步到扩展 |
| 后端 | Cloudflare Worker + Hono | 模型密钥只放在服务端；Worker 用 AI binding 调模型，不需要 API token |
| 模型 | Workers AI（经 AI Gateway） | 无需第三方 API key；Gateway 提供日志、缓存、按用户统计 |
| 接口格式 | OpenAI 兼容的 `/v1/chat/completions` | 流式格式通用，以后换模型或换后端时扩展不用改 |
| 读写 Notion（计划） | 在页面里调用 Notion 自己的内部接口：`/api/v3/loadPageChunk` 读、`/api/v3/saveTransactionsFanout` 写 | 已在真实页面验证可读写，并且刷新后改动仍在。不需要 Notion 官方 integration token，也不需要 `chrome.debugger`（它会一直显示「正在调试」的提示条）。缺点是这些不是公开接口，Notion 改版后可能要跟着改 |

### 认证流程

1. 用户在侧边栏点「登录」，扩展在新标签页打开 `https://notion-kit.kitfun.cc/login`（由 Worker 提供，页面里是 Clerk 的登录组件）。
2. 登录后，Clerk 的会话 cookie 写在这个域名下。扩展配置了 `syncHost`，通过 `cookies` 权限读到它，和这个会话保持同步。Clerk 不会自动刷新已打开的侧边栏，所以扩展监听这些 cookie，一变化就重新加载侧边栏。
3. 每次请求前，扩展用 `getToken()` 取一个短时效的会话 JWT，放在 `Authorization: Bearer` 里发给 Worker。
4. Worker 用 Clerk 的 JWT 公钥在本地验证签名、有效期，并检查 `azp` 是否在允许的 origin 列表里（扩展的 `chrome-extension://<id>` 和登录页域名），不需要访问 Clerk 的网络接口。
5. 请求经 AI Gateway 发往 Workers AI，并在 metadata 里带上 Clerk user id，用于按用户统计。

扩展 ID 用 manifest 里的 `key` 固定下来，这样 Clerk 和 Worker 才能信任它。

## 目录

```
extension/                Chrome 扩展
  vite.config.ts          构建配置；manifest.json 在这里根据 .env 生成
  sidepanel.html
  src/background.ts       点击图标打开侧边栏，只在 Notion 标签页上启用
  src/llm.ts              调用 Worker 的流式对话接口
  src/sidepanel/          React 界面（main.tsx 负责登录，Chat.tsx 是对话）
worker/                   Cloudflare Worker
  src/app.ts              Hono 应用：Clerk JWT 验证 + /v1/chat/completions
  src/login.ts            登录页（Clerk Sync Host）
  test/                   REST 集成测试（真实签名的 JWT，假的 AI binding）
```

## 开发

### Worker

```bash
cd worker
npm install
npm test            # 集成测试
npx wrangler login  # 登录到部署 Worker 的 Cloudflare 账号
# 账号下有多个 Cloudflare account 时，用环境变量指定（不要写进仓库）
CLOUDFLARE_ACCOUNT_ID=<account id> npm run deploy
```

Worker 绑定在自定义域名 `notion-kit.kitfun.cc`（见 `wrangler.jsonc` 的 `routes`），这个域名所在的 zone 必须属于部署用的 Cloudflare 账号。

`wrangler.jsonc` 里的配置项：

| 变量 | 说明 |
|---|---|
| `AI_GATEWAY_ID` | AI Gateway 的 id；留空则直接调用 Workers AI |
| `MODEL` | 客户端唯一可用的模型 |
| `CLERK_JWT_KEY` | Clerk JWT 公钥（PEM）。公开信息，也可以从 `https://<frontend-api>/.well-known/jwks.json` 获取 |
| `CLERK_PUBLISHABLE_KEY` | Clerk publishable key，登录页用 |
| `CLERK_AUTHORIZED_PARTIES` | 允许调用的 origin，逗号分隔：`chrome-extension://<扩展 ID>` 和登录页域名 |

### 扩展

```bash
cd extension
npm install
npm run build       # 输出到 dist/
```

在 `chrome://extensions` 打开开发者模式，点「加载已解压的扩展程序」，选择 `extension/dist`。

`.env` 里是公开的构建配置。要连接你自己的部署，在 `.env.local` 里覆盖：

| 变量 | 说明 |
|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk publishable key |
| `VITE_CLERK_SYNC_HOST` | 登录页所在的网址（Worker 的域名） |
| `VITE_API_URL` | Worker 地址，包含 `/v1` |
| `CRX_PUBLIC_KEY` | 扩展签名公钥，用来固定扩展 ID |

生成你自己的扩展密钥和扩展 ID：

```bash
mkdir -p keys
openssl genrsa -out keys/crx-private.pem 2048
openssl rsa -in keys/crx-private.pem -pubout -outform DER > keys/pub.der
base64 -i keys/pub.der | tr -d '\n'                              # 填到 CRX_PUBLIC_KEY
shasum -a 256 keys/pub.der | cut -c1-32 | tr '0-9a-f' 'a-p'      # 扩展 ID
```

Clerk Dashboard 里需要打开 **Native applications** 页面上的 Native API，Chrome 扩展才能登录。
