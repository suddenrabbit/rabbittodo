# RabbitToDo · Cloudflare 版本

这是 RabbitToDo 的独立 Cloudflare 部署包：

- **Cloudflare Workers**：提供静态 PWA 文件和 `/api/*` 接口；
- **Cloudflare D1**：替代原服务器上的 SQLite；
- **GitHub**：保存源代码，并可触发 Cloudflare 自动部署。

现有的 6 位身份码机制保持不变。它只用于隔离数据，**不是安全认证**；部署至公网后请勿存储敏感信息。

## 目录

```text
public/                 PWA 前端资源
src/worker.js           Worker API，接口与旧 Node 服务兼容
migrations/             D1 数据库结构迁移
scripts/                SQLite 数据迁移辅助脚本
wrangler.jsonc          Cloudflare 配置
```

## 首次部署

需要 Node.js 22+、pnpm，以及 Cloudflare 账户。

```bash
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm run db:create
```

最后一条命令会输出 D1 的 `database_id`。将它填写到 `wrangler.jsonc` 中的：

```json
"database_id": "00000000-0000-0000-0000-000000000000"
```

然后创建生产数据库表并部署：

```bash
pnpm run db:migrate:remote
pnpm run deploy
```

部署完成后，Cloudflare 会给出 `*.workers.dev` 地址；在 Workers & Pages 项目中绑定自定义域名即可启用正式地址与 HTTPS。Workers 可将静态资源与 API 一并部署，`/api/*` 会由 Worker 处理，其他请求由静态资源服务处理。

## 本地开发

首次本地运行先创建本地 D1 数据库：

```bash
pnpm install --frozen-lockfile
pnpm run db:migrate:local
pnpm run dev
```

`wrangler dev` 会使用本地模拟的 D1 数据库，不会读取或修改线上数据。

## 从现有 SQLite 导入数据

在导入期间，先停止旧服务或确保不再写入旧数据库。建议先做在线备份：

```bash
sqlite3 /path/to/todo.sqlite ".backup '/tmp/todo-backup.sqlite'"
```

先按“首次部署”创建 D1 表，再从备份导出数据：

```bash
chmod +x scripts/export-sqlite-for-d1.sh
./scripts/export-sqlite-for-d1.sh /tmp/todo-backup.sqlite /tmp/rabbittodo-data.sql
pnpm exec wrangler d1 execute rabbittodo --remote --file=/tmp/rabbittodo-data.sql
```

脚本仅导出 `identities` 和 `tasks` 的 INSERT 数据；表结构始终由 `migrations/` 管理。它兼容原百度云服务器的旧 SQLite 结构：若来源库尚未包含 `details` 与 `status` 两列，导入时会分别补为空字符串与 `none`。导入后在新地址输入原来的身份码，核对任务数、标签、完成状态及排序，再停用旧服务。

## GitHub 自动部署

1. 将本目录作为仓库根目录推送到 GitHub。
2. 在 Cloudflare Workers & Pages 中连接该 GitHub 仓库，并选择 `main` 为生产分支。
3. 在 Cloudflare 的部署设置中执行 `pnpm install --frozen-lockfile && pnpm run deploy`，或使用 Workers 的 Git 集成功能创建自动部署。
4. 为预览分支启用 Preview deployment；合并到 `main` 后自动发布生产版本。

首次仍建议在本机执行一次 `pnpm run deploy`，以验证 D1 绑定和域名。之后的部署应以 GitHub 推送为准。

## 日常命令

```bash
# 预览本地版本
pnpm run dev

# 应用新增的 D1 migration
pnpm run db:migrate:remote

# 手动发布 Worker（通常由 GitHub 自动部署替代）
pnpm run deploy
```

## 自动刷新与请求量

前端会在回到前台时同步，并在可见状态下每 30 秒拉取一次任务。新增、编辑、完成、删除与排序采用乐观更新：界面立即响应，数据库写入在后台按操作顺序串行完成；若写入失败，应用会提示并恢复服务器中的最新数据。新任务会加入未完成事项顶部；未完成事项遵循手动排序，已完成事项显示在底部的“已完成”区并按完成时间倒序。对于个人或少量设备使用，这只是很小的 D1 读取负载；Worker 端保持了 `Cache-Control: no-store`，避免任务数据被缓存为旧内容。

## HTTPS 与 PWA

Cloudflare 的 `workers.dev` 地址和绑定后的 HTTPS 域名都能满足 iPhone/iPad Safari 的 Service Worker 与安装式 PWA 要求。不要再以 IP + HTTP 作为正式访问地址。

## TODO：really user identity
