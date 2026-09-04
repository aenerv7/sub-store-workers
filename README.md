# Sub-Store Workers

将 [Sub-Store](https://github.com/sub-store-org/Sub-Store) 后端运行在 Cloudflare Workers 上的独立适配项目。

本仓库面向已经使用 Cloudflare 的部署方式：Worker 名称固定为 `sub-store-backend`，现有 KV 作为迁移源和镜像备份，Durable Object 负责强一致状态，鉴权使用已有的 Worker Secret，Custom Domain 在 Cloudflare Dashboard 中手动绑定。

本项目以 **Workers Free 可部署** 为硬约束：Durable Object 必须使用免费计划支持的 SQLite 后端，不引入 Workers Paid 专属资源；CI 会在上传包超过 Free 计划的 3 MiB 压缩大小限制时停止部署。Cloudflare 免费额度耗尽时请求会失败而不是自动计费，只有主动将账号升级到 Workers Paid 才会产生 Workers 月费。

## 这是什么

上游 [Sub-Store](https://github.com/sub-store-org/Sub-Store) 是完整的 Node.js 后端，通常通过 Node.js、pnpm、Docker 或 VPS 运行。本项目不复制上游业务代码，也不是 Pages 项目，而是提供 Cloudflare Workers 运行所需的平台适配层。

| 项目 | 上游 Sub-Store | 本项目 |
| --- | --- | --- |
| 运行时 | Node.js / Express | Cloudflare Workers / Fetch |
| 持久化 | 本地文件系统 | Durable Object 强一致存储，KV `SUB_STORE_DATA` 用于迁移和镜像 |
| 动态脚本 | Node.js `eval` / `new Function` | QuickJS WASM 沙箱，默认启用 |
| 构建 | 上游自己的 pnpm 构建流程 | `esbuild.js` 将 Workers 适配层与上游源码打包 |
| 部署 | 手动部署 Node.js 服务 | GitHub Actions 部署 Worker `sub-store-backend` |
| 前端静态文件 | 可由 Node.js 服务托管 | 不托管前端，不部署 Pages |
| 域名 | 由部署环境决定 | 不由本仓库配置，手动绑定 Custom Domain |

上游的订阅管理、格式转换、组合订阅、分享链接等核心业务逻辑继续复用。差异主要集中在运行时、存储、鉴权和构建方式。

## 目录和同步边界

```text
src/                         Cloudflare Workers 适配层，本项目维护
esbuild.js                   Workers + 上游源码的构建桥接
wrangler.toml.example        本地部署配置示例
.github/workflows/            自动同步上游并部署 Worker
scripts/rotate-secret.*      Worker Secret 密码轮换脚本
```

构建时需要将上游仓库放在本仓库的同级目录：

```text
parent/
├── Sub-Store/               上游仓库，仅用于构建时引入
└── sub-store-workers/       本项目
```

GitHub Actions 会临时 checkout 上游 `sub-store-org/Sub-Store`，不会把上游源码复制进本项目。上游更新后，Actions 会重新测试、构建并部署；Workers 适配问题只在本项目的 `src/` 和 `esbuild.js` 中维护。

## 实际落地架构

```text
Sub-Store 前端
      │  https://你的域名/你的路径密码
      ▼
Cloudflare Worker: sub-store-backend
      ├── Durable Object binding: SUB_STORE_COORDINATOR
      ├── KV binding: SUB_STORE_DATA（迁移/镜像）
      ├── Worker Secret: SUB_STORE_FRONTEND_BACKEND_PATH
      └── Cron Trigger: 每天 05:00（北京时间）同步 artifacts
```

GitHub Actions 的实际流程：

```text
拉取上游 → 上游测试 → 构建 Worker → Workers 运行时测试
       → 读取现有 KV 绑定 → 部署 Worker/ Durable Object
       → 健康检查和绑定校验 → 回写上游版本标记
```

Actions 只部署 Worker。它不会创建 Pages、部署 Pages、读取 Secret 明文或配置 Custom Domain。

## 推荐部署方式：GitHub Actions

### 1. Cloudflare 资源

首次迁移前，请确认 Cloudflare 账号中已经存在：

- Worker：`sub-store-backend`
- KV 绑定：Worker 绑定名为 `SUB_STORE_DATA`，指向需要复用的现有 KV namespace
- Durable Object：由首次部署的 `SubStoreCoordinator` 类和 `v1` migration 创建
- Worker Secret：`SUB_STORE_FRONTEND_BACKEND_PATH`

工作流会从 `sub-store-backend` 的 Worker settings 读取 `SUB_STORE_DATA` 的 namespace ID，并用 `keep_vars = true` 保留 Dashboard 中已有的变量。Worker Secret 不会被覆盖，工作流只校验它存在。

如果 Worker 或上述绑定尚不存在，工作流会停止，不会替你创建新的 KV 或猜测 Secret 值。可选地添加 `WORKER_HEALTH_URL` Actions Secret（值为 Custom Domain，例如 `https://sub.example.com`），工作流会在发布后请求 `/_health`；未配置时只执行 Cloudflare API 层面的绑定校验。

### 2. GitHub Actions Secrets

在仓库的 `Settings → Secrets and variables → Actions` 中添加：

| Secret | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 部署 Worker、读取 Worker settings |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |

API Token 至少需要当前账号的：

- Account → Workers Scripts：Edit
- Account → Workers KV Storage：Edit

不要添加或配置 Pages 权限。Worker Secret 的值不需要、也不应该复制到 GitHub Secrets。

### 3. 手动触发第一次部署

打开仓库的 **Actions → Sync Upstream Sub-Store → Run workflow**，将 `force` 设为 `true` 后运行。

工作流每天 UTC 16:00（北京时间 00:00）自动检查上游更新。只有上游有新提交，或手动指定 `force = true` 时才会构建和部署。

### 4. 手动绑定域名

在 Cloudflare Dashboard 中将自己的 Custom Domain 绑定到 `sub-store-backend`。本项目不创建、不修改、不验证 Custom Domain。

### 5. 连接前端

先确认 Worker Secret 的值带有开头的 `/`，例如 `/aBc123XyZ`。然后在 [Sub-Store 前端](https://sub-store.vercel.app) 中填写：

```text
https://你的自定义域名/aBc123XyZ
```

路径密码不能省略。部署后可访问以下接口确认 KV 和鉴权状态：

```text
https://你的自定义域名/aBc123XyZ/api/utils/worker-status
```

正常结果应包含：

```json
{ "kv": { "bound": true }, "auth": { "backendPathConfigured": true } }
```

## Secret 密码轮换

生产环境不要把密码写入 `wrangler.toml [vars]`。推荐使用仓库脚本生成随机路径并写入 Worker Secret：

```bash
# Windows
npm run rotate-secret

# Linux / macOS
npm run rotate-secret:sh
```

脚本默认目标为 `sub-store-backend`，会生成带 `/` 前缀的 URL-safe 密码，并尝试复制到剪贴板。密码更新后，需要同步更新前端中的后端地址。

也可以手动设置：

```bash
npx wrangler secret put SUB_STORE_FRONTEND_BACKEND_PATH --name sub-store-backend
```

## 本地构建和部署

仅在需要调试 Workers 适配层时使用本地流程。准备同级的上游仓库后：

```bash
git clone https://github.com/aenerv7/sub-store-workers.git
cd sub-store-workers
git clone https://github.com/sub-store-org/Sub-Store.git ../Sub-Store
npm ci
npm run build
```

本地部署需要登录 Wrangler，并在被 `.gitignore` 忽略的 `wrangler.toml` 中填写真实 KV ID。可以复制 [`wrangler.toml.example`](wrangler.toml.example) 后修改：

```bash
npx wrangler login
npm run deploy
```

PowerShell 使用 `Copy-Item wrangler.toml.example wrangler.toml`，macOS/Linux 使用 `cp wrangler.toml.example wrangler.toml`。

本地 `npm run deploy` 只部署 Worker，不部署 Pages。生产环境仍建议使用 GitHub Actions，以保证上游测试和 KV 绑定检查都执行。

## Workers 运行时限制

这是运行时迁移，不是功能完全等价的 Node.js 环境。以下能力不适用于 Workers 或需要替代方案：

- 不提供前端静态文件托管，不部署 Pages
- 不支持依赖本地文件系统的 MMDB、文件恢复和 Node.js 代理中间件
- Workers 出站请求使用 Cloudflare 网络，部分限制国内 IP 的订阅源可能不可用
- 单次请求有 Cloudflare 的时间和 CPU 限制，慢速订阅源可能超时
- 推送使用 HTTP URL（如 Bark、Pushover），不支持 `shoutrrr`

需要完整 Node.js 能力时，请使用上游项目的 Node.js / Docker 部署方式。

## 维护和更新

- 上游业务逻辑：由 [sub-store-org/Sub-Store](https://github.com/sub-store-org/Sub-Store) 维护
- Workers 适配、Durable Object/KV 存储、QuickJS 沙箱和 CI：由本项目维护
- Cloudflare 资源约束：必须兼容 Workers Free；涉及付费资源的改动不得自动合入或部署
- 上游更新：由 `.github/workflows/sync-upstream.yml` 自动同步
- 本项目修改：提交 `src/`、`esbuild.js` 或 workflow 后，按正常 GitHub Actions 流程验证

详细的模块职责和请求流程见 [`mydocs/codemap/project-overview.md`](mydocs/codemap/project-overview.md)。

## 许可证

本项目包含上游 Sub-Store 的衍生代码，按上游仓库中的 GNU AGPLv3 许可证发布。Workers 适配层与构建脚本也按同一许可证发布；来源、修改边界和构建方式见 [`NOTICE`](NOTICE)。
