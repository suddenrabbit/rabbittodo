# RabbitToDo 2.0

RabbitToDo 是一个面向个人使用的轻量待办 PWA，围绕“快速记录、跨设备同步、低干扰管理”设计。它可以安装到 iPhone、iPad 和桌面设备，并根据窗口横竖比例切换响应式布局。

当前生产地址：[todo.srabbitwork.site](https://todo.srabbitwork.site)

当前 2.0 生产基线：

- Git commit：`e2498f7`
- 应用版本：`v20260801.110605`
- Service Worker 缓存：`rabbittodo-v43`
- 数据平台：Cloudflare Workers + D1
- 源代码：GitHub `suddenrabbit/rabbittodo`

2.0 在 1.0 任务能力的基础上完成了用户名密码账户体系、旧身份码迁移、管理员账号控制、PWA 更新安全和长列表滚动体验。生产 D1 已保留既有任务数据，旧用户按首次登录逐个完成升级。

## 2.0 功能概览

### 任务管理

- “待办”和“已办”两个主页面，默认进入待办。
- 任务支持标题、详情、颜色、多个标签、计划完成日期和状态。
- 任务状态包括默认、进行中、暂停和已完成。
- 详情在任务卡片中单行截断展示，点击卡片进入完整编辑。
- 计划日期可留空；无日期任务不判断逾期。
- 逾期任务显示浅红色背景、超期状态和超期天数；未来任务显示剩余天数。
- 已完成任务记录并展示完成日期，跨年日期显示完整年份。
- 动态标签和颜色筛选；横屏默认展开筛选区，筛选按钮自动换行。

### 排序与置顶

- 支持鼠标和触摸拖动，带跟手位移、重排动画和边缘自动滚动。
- 待办任务分为置顶事项与普通待办；拖入或拖出置顶区域会自动切换置顶状态。
- 没有置顶任务时，拖动过程中会临时出现置顶分割线。
- 手动排序位置优先于自动排序规则。
- 没有手动位置时，待办依次参考置顶时间、计划日期、任务状态、创建时间。
- 已办事项默认按完成时间倒序；手动拖动后保留手动顺序。
- 已置顶任务完成后保留内部置顶属性，重新切回待办时回到置顶区域。

### 账户与登录

- 用户名只用于登录和界面展示，长度为 2–10 位；须以中文或英文字母开头，可包含中文、英文字母、数字和下划线，英文大小写按同一用户名处理。
- 密码长度为 8–256 位。首次输入一个尚未存在的用户名时，界面要求再次确认密码，随后自动创建并启用账号，不再进入管理员审批流程。
- 生产既有用户均已完成升级迁移，旧 6 位身份码入口已关闭；使用用户名和密码登录。
- 管理后台位于 `/console/`，支持查看、启用、禁用账号，以及生成一次性密码重置码。
- 一次性重置码有效期为 15 分钟；重置密码会撤销旧会话，但不会改变内部身份码或任务密文。
- 历史 `pending` 账号在 migration 中自动转为 `enabled`，已有 `disabled` 状态保持不变。

### 内容加密

- 新用户直接使用 32 字节密码学随机数生成的内部身份码（`u_` 加 Base64URL）作为固定加密种子；数据库主键约束负责最终唯一性保护。既有用户升级时也会生成同规格的新身份码，并在浏览器中把原任务从旧身份码密钥重新加密到新身份码密钥。
- 密码只用于服务端认证，不直接参与任务加密；修改或重置密码不会改变内部身份码和任务密文。
- 任务标题和详情在发送到 Worker 前加密，D1 中保存 `rtenc:v1:...` 密文。
- 标签、颜色、日期、状态和排序字段保持明文，以支持服务端存储和客户端筛选排序。
- 旧的明文任务由新版客户端首次读取后在后台分批加密回写。
- 内部身份码同时作为任务的数据分区键保存在 D1，因此该模型延续 1.0 的安全边界，不是服务端不可解密的零知识架构；优点是不依赖平台 Secret 或额外主密钥。
- 任务内容密钥在浏览器中使用 PBKDF2-SHA-256（120,000 次）派生；服务端密码哈希使用 PBKDF2-SHA-256（100,000 次），不得超过 Cloudflare Workers 当前支持的迭代上限。

### PWA 与多端体验

- 提供应用图标、启动 Splash、Service Worker 离线缓存和版本更新检查。
- 启动时缓存优先加载应用壳，并从 IndexedDB 立即恢复持续解锁的任务快照；随后检查版本和远程数据。
- 已登录设备保持 180 天滚动会话，多个设备可同时登录；退出登录、改密、重置或禁用会撤销相应会话。
- 新增、编辑、完成、删除和排序先写入本地快照和离线 outbox，网络恢复、回到前台或定时检查时再串行同步；同一任务冲突以最后成功同步的写入为准。
- Service Worker 检测到新版后只显示“立即更新”确认按钮；确认时显示“更新中…”，持久化本地操作后才接管新版，避免自动刷新。
- 竖屏时标题与筛选区固定，仅任务列表滚动；自动同步和同一列表内的重新渲染会按首个可见任务恢复阅读位置，不再跳回顶部。
- 支持 iPhone、iPad、macOS Safari 和桌面宽屏；宽大于高时使用横屏双栏布局。

## 技术架构

```text
public/                  PWA 前端静态资源
public/console/          用户管理后台
src/worker.js            Cloudflare Worker API
migrations/              D1 数据库增量迁移
scripts/                 SQLite 数据导入辅助脚本
wrangler.jsonc           Worker、静态资源和 D1 绑定配置
DEVELOPMENT_CONVENTIONS.md  开发、验证、版本和发布约定
NEXT_VERSION_PROMPT.md      新对话启动 Prompt
```

前端为无框架的 HTML、CSS 和 JavaScript；后端由 Cloudflare Worker 提供 `/api/*`，D1 保存账号、会话、一次性重置记录与任务数据。

## 本地开发

环境要求：Node.js 22+、pnpm。

```bash
pnpm install --frozen-lockfile
pnpm run db:migrate:local
pnpm dev --port 8792
```

本地地址通常为 [http://localhost:8792](http://localhost:8792)。使用已有用户名密码账号验证持续登录、离线恢复与任务同步，也可以输入一个新用户名验证注册流程。本地 Wrangler 使用模拟 D1，不会修改生产数据库。

常用检查：

```bash
node --check public/app.js
node --check public/sw.js
node --check src/worker.js
node --check public/console/app.js
git diff --check
git status --short
```

完整协作规则见 [DEVELOPMENT_CONVENTIONS.md](./DEVELOPMENT_CONVENTIONS.md)。

## 首次部署

```bash
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm run db:create
```

把命令输出的 `database_id` 写入 `wrangler.jsonc`，然后执行：

```bash
pnpm run db:migrate:remote
pnpm run deploy
```

Cloudflare Git 集成可关联 GitHub `main` 分支自动部署。正式环境必须使用 HTTPS，才能完整支持 iOS PWA 和 Web Crypto。

## 日常发布

仅当前改动包含新的数据库 migration 时，先执行：

```bash
pnpm run db:migrate:remote
```

2.0 账户体系对应的 `migrations/0006_user_accounts.sql` 已进入生产基线。2.1 的 `migrations/0007_offline_task_mutations.sql` 只给既有任务表增加可空的客户端离线创建编号及唯一索引，用于安全重试，不删除、不重建也不修改既有任务内容。生产发布时先执行 `0007`，再部署依赖它的代码。

其他发布同样应在确认 migration 成功后再推送 Git，由 Cloudflare 自动部署。迁移必须是增量且保护既有数据，禁止通过删除或重建生产表来完成普通升级。

### 发布前记录与回退

包含 D1 migration 的发布，在执行前先记录当前 Worker 版本和 D1 Time Travel bookmark：

```bash
pnpm exec wrangler deployments list
pnpm exec wrangler d1 time-travel info rabbittodo
```

包含新 migration 的推荐发布顺序是：记录上述回退点，执行 `pnpm run db:migrate:remote`，确认成功后再部署代码，并完成登录、任务读取和管理后台烟雾测试。纯前端或纯 Worker 修复不重复执行无关 migration。

如果发布后只是前端或 Worker 代码故障，优先在 Cloudflare Dashboard 的 **Workers & Pages → rabbittodo → Deployments** 回退到上一稳定版本，或使用：

```bash
pnpm exec wrangler rollback [上一稳定版本 ID]
```

代码回退不会自动回退 D1。生产中已经可能存在完成 2.0 升级的账号，其旧身份码与旧密文已被随机内部身份码和新密文替换，因此不能再把 1.0 Worker 当作通用回退版本。普通故障应优先回退到兼容当前 2.0 数据结构的稳定 Worker，或在当前 2.0 基线上修复后重新部署。

只有 migration 错误或生产数据被破坏时，才停止写入并使用发布前 bookmark 恢复 D1：

```bash
pnpm exec wrangler d1 time-travel restore rabbittodo --bookmark=[发布前 bookmark]
```

Time Travel 会原地覆盖数据库，发布后新产生的账号、任务和修改会丢失，因此它属于最后手段，执行前必须再次确认目标 bookmark，并记录恢复命令返回的 `previous_bookmark`，以便必要时撤销恢复。数据库恢复到旧结构后，再把 Worker 回退到对应的旧版本。

仅修改前端缓存资源时，需要同步更新：

- `public/app.js` 中的 `APP_VERSION`
- `public/app.js` 中的 `EXPECTED_SERVICE_WORKER_VERSION`
- `public/sw.js` 中的缓存版本

文档或纯后端改动不应机械地升级 Service Worker；每次提交前都要根据实际缓存影响评估。

## 从 SQLite 导入 D1

先停止旧服务写入并备份：

```bash
sqlite3 /path/to/todo.sqlite ".backup '/tmp/todo-backup.sqlite'"
```

初始化 D1 后导出并导入：

```bash
chmod +x scripts/export-sqlite-for-d1.sh
./scripts/export-sqlite-for-d1.sh /tmp/todo-backup.sqlite /tmp/rabbittodo-data.sql
pnpm exec wrangler d1 execute rabbittodo --remote --file=/tmp/rabbittodo-data.sql
```

表结构由 `migrations/` 管理，导入脚本只负责数据。导入完成后应核对身份码数量、任务数量、完成状态、标签和排序，再停用旧服务。

## 已知边界与后续方向

- 生产用户均已完成旧身份码迁移，旧入口已关闭；仍保留已升级账号的随机内部身份码和现有密文格式。
- 解锁材料、解密后的任务快照和待同步操作保存在已登录设备的 IndexedDB。清除网站数据、卸载 PWA 或退出登录会清除本地恢复层，D1 始终是远端权威数据。
- Background Sync 在各浏览器支持不一致；网络恢复、回到前台和定时检查会继续尝试发送本地 outbox，PWA 被完全终止时将在下次打开后继续。
- 服务端 PBKDF2 必须保持在 Cloudflare Workers 支持范围内；2.0 固定为 100,000 次。浏览器端任务内容派生使用 120,000 次，两者用途不同，不能机械合并。
- 登录失败限速目前保存在单个 Worker 实例内，正式扩大使用规模前可迁移到 Durable Object、KV 或其他跨实例方案。
- 管理后台继续保留默认密码 `zhoumeng1987` 的哈希回退，源码不保存明文，但默认口令本身仍属于过渡方案；生产可用 Worker Secret `ADMIN_PASSWORD` 覆盖。
- 管理员一次性重置码只重置密码哈希，内部身份码和任务密文保持不变；获得重置码等同于获得该账号访问权，因此应严格限制后台权限。
- 历史明文自动加密逻辑应保留过渡期；确认生产 D1 不再存在明文后，可在后续版本评估清理并强制只接受密文。
