# RabbitToDo 开发与发布约定

本文件是 RabbitToDo 后续对话和开发工作的固定协作基线。除非用户明确修改约定，否则持续遵循。

## 一、工作目录与环境

- Git 仓库：`/Users/zm/Documents/GitHub/rabbittodo`
- 本地预览端口：`8792`
- 本地预览地址：`http://localhost:8792`
- 本地既有用户升级验证身份码：`246810`
- 生产域名：`https://todo.srabbitwork.site`
- 生产数据库：Cloudflare D1，名称 `rabbittodo`，绑定名 `DB`
- 用户通常通过 GitHub Desktop 将本地 commit 推送到 GitHub。

## 二、先本地验证，再提交

所有功能、逻辑、样式和数据库相关改动遵循以下顺序：

1. 开始前检查 `git status --short`，保护用户已有改动。
2. 在本地实现，不直接改生产环境。
3. 启动或复用本地 Wrangler 服务，在 Safari 中打开本地预览。
4. 每次提醒用户使用身份码 `246810` 验证既有用户升级，并按需验证新用户名注册。
5. 根据风险执行语法检查、接口检查、响应式检查和真实交互验证。
6. 把本地预览地址和重点测试项交给用户确认。
7. 未得到用户明确的“可以提交”“commit”等指令前，不提交 Git。
8. 用户确认后再更新版本、检查差异并 commit。
9. 不自动 push，除非用户明确要求；通常由用户通过 GitHub Desktop push。

## 三、版本号规则

应用版本格式：

```text
v年月日.时分秒
```

示例：

```text
v20260731.204635
```

规则：

- 使用准备 commit 时的北京时间生成版本号。
- 秒数不要求与实际 commit 时间严格一致。
- 版本号显示在“我的”页面底部，用于验证发布是否生效。
- 文档变更或不影响客户端的纯后端变更，不必修改应用版本。

## 四、Service Worker 更新规则

每次 commit 前都评估本次改动是否影响 PWA 缓存资源。

如果修改了 `public/app.js`、HTML、CSS、图标、manifest 或其他被 Service Worker 缓存的前端资源，则同时更新：

1. `public/app.js` 的 `APP_VERSION`
2. `public/app.js` 的 `EXPECTED_SERVICE_WORKER_VERSION`
3. `public/sw.js` 的 `CACHE`

Service Worker 版本沿用递增格式，例如：

```text
rabbittodo-v34
rabbittodo-v35
```

如果只是 README、开发文档或不影响静态客户端的 Worker 内部改动，不机械递增 Service Worker。

PWA 恢复前台时必须先完成 Service Worker 更新检查，再同步任务数据，避免旧前端读取新格式数据。登录、旧用户升级资料正在输入或编辑器打开时，不应强制刷新打断用户。

## 五、验证要求

最低检查：

```bash
node --check public/app.js
node --check public/sw.js
node --check src/worker.js
node --check public/console/app.js
git diff --check
git status --short
```

按改动范围补充：

- 前端视觉：macOS Safari 本地预览。
- 触摸、拖拽、键盘和 PWA：iPhone 实机验证。
- 响应式：桌面竖屏、桌面横屏、iPhone、iPad 横竖屏。
- API：使用身份码 `246810` 完成本地旧用户升级，再使用会话 Cookie 调用本地 `/api/*`；同时覆盖注册、登录、改密、重置与禁用后的会话撤销。
- 数据存储：必要时直接检查本地 D1，确认字段、密文和排序结果。
- Service Worker：确认版本同时递增，避免只更新应用代码或只更新缓存名。

## 六、数据库迁移与数据安全

- D1 schema 变更必须新增 migration 文件，不修改已经在线执行过的 migration。
- migration 应尽量使用增量 `ALTER TABLE`、索引创建等方式，保护既有生产数据。
- 禁止为了普通升级删除、清空或重建生产任务表。
- 如果新代码依赖新字段，生产发布顺序为：先执行远程 migration，确认成功，再 push/deploy 新代码。
- 执行命令：`pnpm run db:migrate:remote`。
- 没有 schema 变化时不要执行无关 SQL；任务内容密文本身继续复用现有 TEXT 字段。账户体系使用新增 migration `0006_user_accounts.sql`，只扩展账号表并新增会话、重置码表，不修改任务表。
- 涉及迁移时，交付说明必须明确脚本名称、执行顺序和既有数据保护方式。

## 七、Git 约定

- commit 只包含本轮已确认的相关改动，不混入无关文件。
- 每次 commit 前，评估本次改动是否影响用户可见功能、产品规则、技术架构、数据库迁移、部署流程、已知边界或版本基线；如有影响，必须同步更新 `README.md`。
- 纯样式微调、内部修复或不改变既有约定的改动，无需机械修改 README；提交说明应能清楚表达改动范围。
- 当本文件约定的开发、验证、版本、Service Worker、迁移或发布流程发生变化时，必须在同一轮改动中同步更新 `DEVELOPMENT_CONVENTIONS.md`。
- commit message 使用简洁的 Conventional Commits 风格，例如：

```text
feat: add manual task ordering
fix: prioritize pwa updates before task sync
docs: summarize version 1.0 workflow
```

- commit 前执行语法检查和 `git diff --check`。
- commit 后确认 `git status --short` 为空，并向用户报告 commit hash、应用版本和 Service Worker 版本。
- 不使用破坏性 Git 命令覆盖用户改动。

## 八、当前产品约束

- 用户名只用于登录和展示；新用户使用唯一约束保护的 256 位随机内部身份码，该身份码同时作为任务分区与固定加密种子。
- 既有用户升级时，浏览器用原 6 位身份码解密任务，再用新的 256 位随机身份码重新加密；服务端必须原子切换账号、任务归属和密文，失败时保留全部旧数据。
- 密码只用于认证，不直接参与任务加密。修改密码和管理员一次性重置只更新密码哈希，不能改变内部身份码或任务密文；系统不依赖额外服务器主密钥。
- 新用户名经一次密码确认后自动注册并启用，不再审批；管理员仍可启用或禁用账号。migration 自动启用历史 `pending`，保留 `disabled`。
- 解锁后的加密种子只存当前浏览器会话的 `sessionStorage`，不写入长期本地存储；浏览器会话结束后需再次输入密码。
- 加密范围只有标题与详情；标签、日期、颜色、状态、完成信息和排序字段保持明文。
- 旧明文任务由客户端按需后台迁移，正常密文任务不会重复回写。
- 管理后台默认密码只允许以哈希常量保留回退，不在源码保存明文；当前约定口令仍为 `zhoumeng1987`。
