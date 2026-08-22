# RabbitToDo 2.6 开发与发布约定

本文件是 RabbitToDo 后续对话和开发工作的固定协作基线。除非用户明确修改约定，否则持续遵循。

## 一、工作目录与环境

- Git 仓库：`/Users/zm/Documents/GitHub/rabbittodo`
- 本地预览端口：`8792`
- 本地预览地址：`http://localhost:8792`
- 本地验证：使用已有用户名密码账号验证持续登录，并按需验证新用户名注册。
- 生产域名：`https://todo.srabbitwork.site`
- 生产数据库：Cloudflare D1，名称 `rabbittodo`，绑定名 `DB`
- 当前 2.6 本地开发基线：commit `76b6e71`，应用版本 `v20260822.085314`，Service Worker `rabbittodo-v105`。`migrations/0010_account_task_sort_mode.sql` 已在本地与生产 D1 应用。
- 2.2 已上线基线：commit `4150cfa`，应用版本 `v20260803.141847`，Service Worker `rabbittodo-v62`
- 2.0 生产起点（兼容与回退边界）：commit `e2498f7`，应用版本 `v20260801.110605`，Service Worker `rabbittodo-v43`
- 用户通常通过 GitHub Desktop 将本地 commit 推送到 GitHub。

## 二、先本地验证，再提交

所有功能、逻辑、样式和数据库相关改动遵循以下顺序：

1. 开始前检查 `git status --short`，保护用户已有改动。
2. 在本地实现，不直接改生产环境。
3. 启动或复用本地 Wrangler 服务，在 Safari 中打开本地预览。
4. 每次提醒用户验证已有账号的持续登录、离线编辑恢复，并按需验证新用户名注册。
5. 根据风险执行语法检查、接口检查、响应式检查和真实交互验证。
6. 把本地预览地址和重点测试项交给用户确认。
7. 未得到用户明确的“可以提交”“commit”等指令前，不提交 Git。
8. 用户确认后检查差异并 commit；版本号应已在本轮最后一次代码修改完成时确定，不得延后到 commit 时生成。
9. 不自动 push，除非用户明确要求；通常由用户通过 GitHub Desktop push。

## 三、版本号规则

应用版本格式：

```text
v年月日.时分秒
```

示例：

```text
v20260801.110605
```

规则：

- 使用本轮最后一次功能、逻辑或样式代码修改完成时的北京时间生成版本号，不使用 commit 时间。
- 在把本地预览交给用户验证前即确定并写入版本号；后续若再次修改代码，须重新生成版本号。仅同步版本字段本身或补充文档不视为新的代码修改。
- 秒数不要求与实际 commit 时间一致。
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
rabbittodo-v42
rabbittodo-v43
```

如果只是 README、开发文档或不影响静态客户端的 Worker 内部改动，不机械递增 Service Worker。

PWA 恢复前台时先在本地呈现任务快照，再检查 Service Worker 更新；远程同步必须在更新检查之后启动。更新检查、会话恢复和任务读取都必须有限时并释放各自同步锁，任何超时或网络失败都不能永久阻塞后续重试。检测到新版自动更新：先持久化本地修改，再激活新版并刷新，无需用户确认；编辑、拖拽或登录弹窗打开时推迟应用，避免刷新打断输入。

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
- API：覆盖已有账号持续会话、注册、登录、改密、重置与禁用后的会话撤销；验证离线创建重试不会产生重复任务。
- 数据存储：必要时直接检查本地 D1，确认字段、密文和排序结果。
- Service Worker：确认版本同时递增，避免只更新应用代码或只更新缓存名。
- 长列表与同步：使用超过一屏的本地任务数据，滚动到中下部并跨过一次真实的 30 秒自动同步，确认首个可见任务和滚动位置保持不变；同时验证 IndexedDB 快照、离线 outbox、网络恢复后的串行同步，以及竖屏固定顶部/筛选区和横屏双栏布局。
- 平台兼容：本地 Miniflare 与生产 Workers 可能存在运行时差异。涉及 Web Crypto、CPU、请求大小、D1 查询数量等平台限制时，不能只以本地成功为依据，必须核对 Cloudflare 当前限制并安排生产只读或低风险烟雾测试。

## 六、数据库迁移与数据安全

- D1 schema 变更必须新增 migration 文件，不修改已经在线执行过的 migration。
- migration 应尽量使用增量 `ALTER TABLE`、索引创建等方式，保护既有生产数据。
- 禁止为了普通升级删除、清空或重建生产任务表。
- 如果新代码依赖新字段，生产发布顺序为：先执行远程 migration，确认成功，再 push/deploy 新代码。
- 执行命令：`pnpm run db:migrate:remote`。
- 没有 schema 变化时不要执行无关 SQL；任务内容密文本身继续复用现有 TEXT 字段。`0006` 至 `0010` 已构成账户、离线同步、提醒、主题与排序偏好的既有基线；`0010_account_task_sort_mode.sql` 为账号增加默认 `manual` 的 `task_sort_mode`，已在生产应用。后续结构变化必须从最新 migration 编号递增。
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
docs: summarize version 2.0 workflow
```

- commit 前执行语法检查和 `git diff --check`。
- commit 后确认 `git status --short` 为空，并向用户报告 commit hash、应用版本和 Service Worker 版本。
- 不使用破坏性 Git 命令覆盖用户改动。

## 八、当前产品约束

- 用户名只用于登录和展示；新用户使用唯一约束保护的 256 位随机内部身份码，该身份码同时作为任务分区与固定加密种子。
- 生产账号均使用随机内部身份码；前端、Worker 与管理后台不再保留旧 6 位身份码升级或审批兼容代码。
- 密码只用于认证，不直接参与任务加密。修改密码和管理员一次性重置只更新密码哈希，不能改变内部身份码或任务密文；系统不依赖额外服务器主密钥。
- 新用户名经一次密码确认后自动注册并启用，不再审批；管理员仍可启用或禁用账号。migration 自动启用历史 `pending`，保留 `disabled`。
- 已登录设备将用户名、解锁材料、已解密任务快照和待同步操作持久化在 IndexedDB，以便 PWA 被系统回收后立即恢复；退出登录时清除这些本地数据。
- 加密范围只有标题与详情；标签、日期、颜色、状态、完成信息和排序字段保持明文。
- 浏览器端新写入的任务内容使用 `rtenc:v2`：身份码去掉 `u_` 后 base64url 解码得到的 32 字节即密钥材料，用 HKDF-SHA256（salt `RabbitToDo task content v2`、info `task-content`）派生 AES-GCM 密钥，无迭代次数；密文格式为 `rtenc:v2:` + base64(iv || ciphertext)。
- 客户端与 Worker 只接受 `rtenc:v2` 标题以及 v2 或空值的详情；不再包含旧密文派生、解密、明文回写或 `/api/tasks/encrypt` 迁移接口。生产 D1 已于 2026-08-22 只读核验为纯 v2。
- Worker 端密码哈希使用 PBKDF2-SHA-256、100,000 次迭代，并在 `password_params` 中记录参数。Cloudflare Workers 会拒绝超过 100,000 次的 PBKDF2 请求，禁止恢复为 210,000 或让后台默认密码校验使用更高迭代数。任务内容 v2 使用 HKDF 派生，不受该 PBKDF2 上限影响。
- create/update outbox 发送时必须从 IndexedDB 的本地已解密任务快照重新生成 v2 payload；快照缺失时仅允许重放已经严格校验为 v2 的既有 payload，否则明确失败，不得发送旧格式。
- 管理后台默认密码只允许以哈希常量保留回退，不在源码保存明文；当前约定口令仍为 `zhoumeng1987`。
- 系统不使用 `SERVER_MASTER_KEY` 或其他额外服务器主密钥。内部身份码保存在 D1 并作为固定加密种子；修改密码和管理员重置不得改变它。
- 会话 Cookie 为 HttpOnly、SameSite=Lax，闲置 180 天过期；设置与续期时同时下发 `Expires` 与 `Max-Age`，清除时使用 `Max-Age=0` 且 `Expires` 设为过去时间。每次前台会话恢复自动续期，多个设备可同时登录。改密码、管理员重置和禁用账号仍撤销会话。`SameSite=Lax` 仍能阻止跨站 POST/PUT/DELETE 携带 Cookie（CSRF 保护），同时允许外部链接与书签的顶层 GET 导航携带会话 Cookie，避免 PC 浏览器丢失登录态。
- 启动必须先恢复本地任务快照，再拉取远端权威数据；Service Worker 更新检查先于远端同步启动，但只能有限等待。会话和任务读取使用统一超时；前台、Service Worker、任务与 outbox 同步锁在成功、失败和超时后都必须释放。新建、编辑、完成、删除与排序每次都直接发送远端，不得用 `navigator.onLine` 或其他浏览器网络状态字段跳过请求；只有超时或网络层失败才进入本地 outbox 且显示“未同步”。排序回放前必须刷新远端同列表项目，并补齐离线期间新增的项目，不能让旧排序记录堵塞后续操作。遗留 outbox 不得阻塞远端读取，读取时需合并保留本机未同步项；迟到的旧读取结果不得覆盖更高同步代次或读取期间发生的本地安全写入。只有明确的 401/403 才清除登录态，普通网络失败保留快照和 outbox，显示失败阶段与原因并安排重试。创建操作使用持久客户端编号防止重试重复创建，跨设备同一任务冲突按最后成功同步的写入覆盖。
- 任务页在竖屏固定标题与筛选区、横屏固定左侧功能区；两种方向均只允许 `.workspace-tasks` 独立滚动。竖屏“待办/已办”标题固定为 24px，不随任务滚动变化；横屏标题保持现有横屏规格。竖屏筛选触发框为 40px，筛选区与首个任务分区保持紧凑间距；我的页顶部与任务页使用相同安全区基线。重新渲染同一视图/筛选结果时必须恢复任务滚动锚点，切换视图或筛选条件时才从新列表顶部开始。
- 底栏为 56px（另加安全区）的全宽普通导航；安全区外上、下留白分别为 4px、2px，待办与已办按钮使用 56 × 44px 触控区。待办、已办页将 44px 主题色圆形新增按钮收入中间栏位，我的页不显示新增按钮。已办页左上角小品牌显示 `RabbitDone`，待办与我的页保持 `RabbitToDo`。
- 网页启动阶段不显示独立 Splash；HTML 可绘制后保持与 App 一致的背景色，本地快照恢复完成即直接进入任务页或登录页。
- 待办先分置顶区与普通区。排序模式是账号级偏好 `task_sort_mode`，默认 `manual`，通过账户偏好接口跨设备同步。手动模式下每个区内优先手动位置，未记录位置时按创建时间正序，新增任务在队尾；尚未同步的新建任务可临时拖动但不得写入排序记录。自动模式下禁止拖拽，不覆盖手动位置：置顶任务按 `pinned_at` 倒序；普通任务先按截止日期升序，无日期任务最后；相同截止日期与无日期任务均按进行中、无状态、暂停，再按创建时间正序。已办始终只按完成时间倒序。
- 计划完成日期等日期展示使用 `dateLabel` 统一格式化：月、日不带前导零（如 `8月3日`），当年日期不显示年份，跨年日期带年份（如 `2025年12月31日`），当天显示“今天”；底层存储仍为 `YYYY-MM-DD`。
- 提醒时间当前仅支持上海时区；重复规则为不重复/每天/每周/每月。提醒数据只存在 D1 的 `task_reminders` 表（每任务最多一条），推送订阅只存在 `push_subscriptions` 表，不允许新增与既有任务表耦合的提醒字段。
- 页面打开时的提醒由前端本地检查负责（`checkDueReminders`，25 秒节流，不发起 API 请求），本地 `fireKey` 防重；页面关闭时的提醒由 Worker Cron（`* * * * *`）扫描 `next_fire_at` 推送。设置提醒时间时前端顺带检查通知状态，未开启则在用户手势中请求权限并注册推送（已拒绝时静默跳过）。本地 `wrangler dev` 不自动触发 Cron，需手动 `curl http://localhost:8792/cdn-cgi/handler/scheduled` 验证。
- 后台推送在推送瞬间临时解密 `rtenc:v2` 任务标题，通知显示真实任务标题（明文只在内存与推送负载，不落库）；格式或解密异常时回退通用文案 `RabbitToDo / 你有一条待办提醒`，不允许因解密失败报错或吞提醒。
- 推送失败（非 404/410）必须保留 `next_fire_at` 继续重试，不得吞提醒；无订阅时没有可送达设备，不重复提醒置 `enabled=0` 停用、重复提醒推进 `next_fire_at`，禁止每分钟空转重试。推送服务返回 404/410 时清理订阅；完成任务、删除任务或清除提醒时同步停用/删除提醒。
- 推送密钥通过 Secret 提供：本地 `.dev.vars`（`VAPID_PRIVATE_KEY`、`VAPID_PUBLIC_KEY`），生产 `wrangler secret put`。Cron 每分钟固定 1440 次请求计入 Workers Free 每日 10 万请求额度（约 1.44%），调整 `triggers.crons` 时需同步评估额度与提醒准时性。
