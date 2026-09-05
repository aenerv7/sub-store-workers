# Sub-Store Workers 项目总图

> 生成时间: 2026-04-23 15:11（最近更新: 2026-09-04）
> 项目: sub-store-workers
> 类型: project-level codemap

## 1. 项目定位

将 [Sub-Store](https://github.com/sub-store-org/Sub-Store) 后端从 Node.js 移植到 Cloudflare Workers 运行时。**仅替换平台相关层，核心业务逻辑零修改**（构建时从 `../Sub-Store/backend/src/` 引入）。

## 2. 架构总览

```
┌─────────────────────────────────────────────────────┐
│              Cloudflare Workers Runtime              │
│                                                      │
│  ┌──────────┐   ┌──────────────┐   ┌──────────────┐ │
│  │ index.js │──▶│ Coordinator  │──▶│ 上游 restful │ │
│  │  入口     │   │ SQLite DO    │   │ 路由处理器    │ │
│  └──────────┘   └──────┬───────┘   └──────────────┘ │
│                        │                             │
│  ┌──────────┐   ┌──────▼───────┐   ┌──────────────┐ │
│  │open-api  │◀─▶│ DO Storage   │──▶│ KV 镜像/迁移 │ │
│  │存储适配层 │   │ (权威状态)    │   │ SUB_STORE_DATA│ │
│  └──────────┘   └──────────────┘   └──────────────┘ │
└─────────────────────────────────────────────────────┘
```

## 3. 文件清单与职责

### 3.1 平台适配层（`src/`，本项目自有）

| 文件 | 职责 |
|---|---|
| `src/index.js` | **Workers 入口**：绑定校验、路径鉴权、CORS、请求路由、单实例 Durable Object 串行协调、Cron 定时同步 |
| `src/worker/storage.js` | **存储适配**：首次从旧 KV 导入，SQLite Durable Object 保存权威状态，KV 异步镜像 |
| `src/worker/security.js` | **安全边界**：路径鉴权、公开 CORS、预检和统一 JSON 错误响应 |
| `src/vendor/express.js` | **Express 适配**：将 Workers fetch handler 适配为类 Express 的 req/res 路由 |
| `src/vendor/open-api.js` | **OpenAPI 适配**：DO Storage 替代 fs 存储、fetch 替代 undici、日志/通知/推送 |
| `src/core/app.js` | 单例 `$` 导出（`new OpenAPI('sub-store')`） |
| `src/utils/env.js` | 环境检测变量，`backend = 'Workers'`，`isWorker = true`；只向前端公开显示用途的环境变量 |
| `src/restful/miscs.js` | 工具 API：运行环境和状态诊断、Gist 备份/还原、存储管理、刷新；不暴露路径密码和推送凭据 |
| `src/restful/token.js` | Token 签发/删除（Workers 版，替换上游 JWT 方案为 nanoid） |
| `src/vendor/quickjs-executor.js` | **QuickJS 脚本沙箱**：替代上游 `new Function()` 执行用户脚本（Script Operator/Filter），支持 func / nodeFunc / content 三种模式，详见 4.4 |

### 3.2 构建层

| 文件 | 职责 |
|---|---|
| `esbuild.js` | **构建脚本**：4 个 esbuild 插件桥接 Workers 与上游源码；同时把上游 `createDynamicFunction` 替换为 QuickJS 沙箱执行（`SCRIPT_ENGINE=disabled` 可关闭） |
| `wrangler.toml.example` | Workers 部署配置示例：SQLite DO、KV 镜像、Cron、非敏感环境变量和 Secret 声明 |
| `package.json` | 依赖与脚本（`build`、`deploy`、`rotate-secret`、`rotate-secret:sh`） |

### 3.3 运维脚本（`scripts/`）

| 文件 | 职责 |
|---|---|
| `scripts/rotate-secret.ps1` | Windows PowerShell：生成随机 URL-safe 密码，通过管道写入 Cloudflare Worker Secret `SUB_STORE_FRONTEND_BACKEND_PATH`，并复制到剪贴板 |
| `scripts/rotate-secret.sh` | Linux/macOS Bash：同上，自动选择 `pbcopy`/`wl-copy`/`xclip`/`xsel` |

### 3.4 上游源码（构建时引入，`../Sub-Store/backend/src/`）

通过 esbuild `@/` 别名解析：**Workers `src/` 优先 → 回退到上游 `src/`**。

关键上游模块：
- `restful/subscriptions` — 订阅 CRUD
- `restful/collections` — 组合订阅
- `restful/artifacts` — 制品生成 + Gist 同步
- `restful/download` / `restful/preview` — 分享链接（公开 API）
- `core/proxy-utils/` — 代理协议解析（Surge/Loon/QX peggy 语法）
- `utils/migration` — 数据迁移

## 4. 核心流程

### 4.1 HTTP 请求处理

```
Browser / Client → Worker fetch()
  │
  ├─ 校验 SUB_STORE_DATA 与 SUB_STORE_COORDINATOR 绑定
  │
  ├─ 路径前缀鉴权（强制）
  │   ├─ 未配置或配置无效 → 503（fail closed）
  │   ├─ /api/*、/download/* 无前缀 → 401
  │   ├─ /backendPath 精确 → 302 重定向
  │   └─ /backendPath/... → 剥离前缀
  │
  ├─ OPTIONS 返回公开 CORS headers
  │
  └─ SUB_STORE_COORDINATOR.getByName("primary")
      ├─ 请求进入对象内串行队列
      ├─ 首次启动：从 KV 导入缺失的 sub-store/root 文档
      ├─ $.initFromStorage(DO Storage) → 加载权威状态
      ├─ migrate() → 上游数据结构迁移
      ├─ $app.handleRequest(request) → 精确路由分发
      ├─ $.persistCache() → 先提交 DO Storage
      └─ ctx.waitUntil() → 异步写 KV 镜像和发送推送
```

### 4.2 Cron 定时同步

```
scheduled() → SUB_STORE_COORDINATOR.runScheduled()
  ├─ 与 HTTP 请求共用串行队列和权威状态
  ├─ 检查 GitHub Token / artifacts
  ├─ 预生成订阅缓存（并行）
  ├─ 生成所有 artifacts（并行）
  ├─ syncToGist(files)
  ├─ 更新 artifact URL
  ├─ gistBackupAction('upload')
  └─ $.persistCache() → DO Storage，再异步镜像 KV
```

### 4.3 esbuild 构建管线

```
esbuild.js
  ├─ aliasPlugin: @/ → Workers src/ 优先，回退上游 src/
  ├─ peggyPrecompilePlugin: PEG 语法 → 预编译 JS 解析器
  ├─ evalRewritePlugin: 上游动态执行点 → Workers 兼容替换并断言命中次数
  └─ nodeStubPlugin: Node 模块 → Proxy 存根
```

构建完成后还会扫描产物；若残留 `eval()` 或 `new Function()`，构建直接失败。

### 4.4 QuickJS 脚本执行（Script Operator/Filter）

上游用 `new Function()` 动态执行用户脚本，Workers 禁止运行时代码生成，改用 QuickJS WASM 沙箱（`src/vendor/quickjs-executor.js`）。按输入类型分三种模式：

```
createScriptFunction(script, name)
  ├─ func 模式：IIFE 包裹脚本 → 返回 function operator/filter → 调用
  ├─ 失败且输入是节点数组 → nodeFunc 模式：快捷脚本逐 $server 遍历
  └─ 失败且输入含 $content/$files（文件/覆写场景） → content 模式：
       ├─ mihomoConfig/mihomoProfile 文件：沙箱内取脚本的 main 函数，
       │    宿主侧 YAML 解析 $content → main(config) → YAML 序列化回 $content
       │    （YAML 在宿主侧处理，因沙箱内无 ProxyUtils）
       └─ 其他文件：注入 $content/$files 全局变量直接执行脚本，回读结果
```

> 背景：早期实现缺少 content 模式，$content 输入被当作节点数组遍历（对象无
> length，循环不执行），导致 convert.js 类覆写脚本不报错但输出空配置。

## 5. 数据存储

- **权威存储**：SQLite-backed Durable Object `SubStoreCoordinator`，固定对象名 `primary`
- **DO Key `sub-store`**：主缓存（订阅/组合/设置/tokens/artifacts）
- **DO Key `root`**：根数据
- **旧数据迁移**：DO 对应 key 不存在时，从 `SUB_STORE_DATA` KV 读取；KV 读取失败则返回 503，不用空状态覆盖
- **写入策略**：请求结束时对比 snapshot；有变化才先写 DO Storage，成功后清除 dirty 状态
- **KV 镜像**：DO 提交成功后通过 `waitUntil()` 异步写回同名 KV key；镜像失败只记录脱敏错误
- **并发策略**：HTTP 与 Cron 都由同一个 DO 队列串行执行，避免共享状态的 read-modify-write 竞争

## 6. 安全机制

- **路径前缀鉴权**：`SUB_STORE_FRONTEND_BACKEND_PATH` 必须配置为 Worker Secret；缺失或格式无效时受保护接口 fail closed。
- **受保护路径**：管理 `/api/*` 与 `/download/*` 必须带路径前缀。
- **公开路径**：`/`、`/_health` 和携带有效 token 的 `/share/*`。
- **CORS**：允许任意前端 Origin，以兼容官方、自建和客户端内嵌前端；CORS 不作为鉴权边界，管理 API 仍必须使用正确的路径 Secret。
- **路由匹配**：静态和参数路由均为完整路径匹配，未知后缀返回 404。
- **环境变量最小披露**：前端只看到自定义名称和图标，路径密码与推送 URL 不进入环境接口响应。
- **Script Operator 沙箱化**：构建期改写 `createDynamicFunction` 为 QuickJS WASM 沙箱执行（内存/栈/指令数限制），避免 `eval`/`new Function`；可用 `SCRIPT_ENGINE=disabled` 关闭。
- **状态自检**：`/api/utils/worker-status` 输出 KV 绑定、鉴权、能力降级（脚本/socks/本地文件系统/cron）等运行时信息，方便部署后快速验证。

## 7. 外部依赖

| 依赖 | 用途 |
|---|---|
| `peggy` | PEG 语法编译（构建时） |
| `js-base64` | Base64 编解码 |
| `nanoid` | Token 生成 |
| `ms` | 时间字符串解析 |
| `lodash` | 工具函数 |
| `ip-address` | IP 地址处理 |
| `yaml` | YAML 解析 |
| `esbuild` | 构建（dev） |
| `wrangler` | 部署 CLI（dev） |

## 8. 免费计划约束与注意事项

1. **Workers Free 是硬约束**：DO migration 必须使用 `new_sqlite_classes`；不得引入 Paid 专属资源。CI 在上传模块压缩大小超过 Free 计划 3 MiB 时停止部署。
2. **免费额度耗尽只会失败**：Free 计划不会自动按量计费；只有主动升级 Workers Paid 才产生月费。Worker 与 DO 各有每日 100,000 请求额度。
3. **KV 镜像额度更低**：Free KV 每日写入 1,000 次；超限时镜像可能滞后，但 DO 权威写入不回滚。
4. **单值大小**：DO Storage 的 key 与 value 合计不能超过 2 MB；当前两个 JSON 文档会先受该限制，而不是总存储额度限制。
5. **上游兼容性**：上游 Sub-Store 更新可能引入 Node-only API，需要在本项目构建层适配。
6. **CPU 时限**：复杂订阅转换和 QuickJS 脚本仍可能触发 Workers Free CPU 限制；这会导致请求失败，不会产生费用。
7. **单对象吞吐**：所有状态集中在 `primary` 对象以换取全局串行一致性，适合个人免费实例，不适合高流量多租户服务。
8. **Secret 管理**：不要在 `[vars]` 中声明 `SUB_STORE_FRONTEND_BACKEND_PATH`；Worker Secret 不可读取原文，遗忘时只能轮换。
