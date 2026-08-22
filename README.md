# RabbitToDo 2.6

RabbitToDo 是一个面向个人使用的轻量待办 PWA，围绕"快速记录、跨设备同步、低干扰管理"设计。它可以安装到 iPhone、iPad 和桌面设备，并根据窗口横竖比例切换响应式布局。

当前生产地址：[todo.srabbitwork.site](https://todo.srabbitwork.site)

当前本地开发基线：

- Git commit：`f12c32f`（`main`）
- 应用版本：`v20260822.091737`
- Service Worker 缓存：`rabbittodo-v108`
- 数据平台：Cloudflare Workers + D1
- 源代码：GitHub `suddenrabbit/rabbittodo`
- `migrations/0010_account_task_sort_mode.sql` 已应用到本地与生产 D1，构成当前排序偏好基线。

2.2 已上线基线（用于判断旧版本兼容性与回退边界）：

- Git commit：`4150cfa`
- 应用版本：`v20260803.141847`
- Service Worker 缓存：`rabbittodo-v62`

2.0 生产起点（用于判断旧版本兼容性与回退边界）：

- Git commit：`e2498f7`
- 应用版本：`v20260801.110605`
- Service Worker 缓存：`rabbittodo-v43`
- 数据平台：Cloudflare Workers + D1
- 源代码：GitHub `suddenrabbit/rabbittodo`

2.0 在 1.0 任务能力的基础上完成了用户名密码账户体系、旧用户迁移、管理员账号控制、PWA 更新安全和长列表滚动体验。2.1 增加本地优先任务快照、离线 outbox、跨设备同步修复、手动排序和响应式滚动优化。2.2 修复 PC 浏览器会话保持并统一计划完成日期展示。2.3 新增定时提醒与 Web Push 推送。2.4 将任务内容加密升级为 `rtenc:v2`，客户端自动迁移旧 `rtenc:v1` 密文，推送时临时解密 v2 标题。2.5 增加账号主题、兔子头像、精简任务卡片、竖屏滚动标题收缩和可跨设备记住的自动排序模式。2.6 改为紧凑全宽底栏，将新增操作收入待办/已办页中央，并收紧筛选与任务分区节奏；已办页左上角品牌显示为 `RabbitDone`。

## 2.6 功能概览

### 任务管理

- “待办”和“已办”两个主页面，默认进入待办。
- 任务支持标题、详情、颜色、多个标签、计划完成日期和状态。
- 任务状态包括默认、进行中、暂停和已完成。
- 详情在任务卡片中单行截断展示，点击卡片进入完整编辑。
- 计划日期可留空；无日期任务不判断逾期。
- 逾期任务显示浅红色背景、超期状态和超期天数；未来任务显示剩余天数。
- 已完成任务记录并展示完成日期，跨年日期显示完整年份。
- 动态标签和颜色筛选；40px 紧凑筛选触发框在横屏默认展开，筛选按钮自动换行。
- 自动排序开关仅在待办页展开“筛选”后显示，位于“按标签”标题行右侧；默认关闭。
- 已办页的左上角品牌名显示为 `RabbitDone`，页面主标题仍为“已办”。

### 排序与置顶

- 排序模式是账号偏好，默认“手动排序”，通过 `identities.task_sort_mode` 跨设备同步；切换自动模式不会改写既有手动顺序。
- 手动模式下，待办卡片的非按钮区域支持拖动：触摸端长按后拖动，桌面端按住鼠标移动即可；待办分置顶事项与普通待办，拖入或拖出置顶区域会自动切换置顶状态。没有置顶任务时，拖动过程中会临时出现置顶分割线。
- 自动模式下禁止拖拽排序。置顶任务按置顶时间倒序；普通任务按截止日期升序（越早逾期越靠前、越近越靠前），无截止日期任务放在最后。相同截止日期及无截止日期任务均按“进行中 → 无状态 → 暂停”，再按添加时间正序；置顶时间或添加时间相同再按任务 ID 保持稳定顺序。
- 已办事项只按完成时间倒序排列，不支持手动拖动排序。
- 已置顶任务完成后保留内部置顶属性，重新切回待办时回到置顶区域。

### 账户与登录

- 用户名只用于登录和界面展示，长度为 2–10 位；须以中文或英文字母开头，可包含中文、英文字母、数字和下划线，英文大小写按同一用户名处理。
- 密码长度为 8–256 位。首次输入一个尚未存在的用户名时，界面要求再次确认密码，随后自动创建并启用账号，不再进入管理员审批流程。
- 生产账号均使用随机内部身份码和用户名密码登录；旧 6 位身份码升级入口及后台审批兼容代码已移除。
- 管理后台位于 `/console/`，支持查看、启用、禁用账号，以及生成一次性密码重置码。
- 一次性重置码有效期为 15 分钟；重置密码会撤销旧会话，但不会改变内部身份码或任务密文。
- 历史 `pending` 账号在 migration 中自动转为 `enabled`，已有 `disabled` 状态保持不变。
- 登录后的页面支持五种账号主题色（葡萄紫、薄荷绿、日落橙、海盐蓝、莓果粉），选择结果保存在账号中并跨设备同步；兔子头像背景、品牌名、主要操作和选中态会随主题变化。
- 新建任务默认使用当前账号主题色；编辑既有任务或切换主题不会改变历史任务颜色，任务卡片颜色和错误、逾期等语义状态色保持独立。

### 内容加密

- 新用户直接使用 32 字节密码学随机数生成的内部身份码（`u_` 加 Base64URL）作为固定加密种子；数据库主键约束负责最终唯一性保护。
- 密码只用于服务端认证，不直接参与任务加密；修改或重置密码不会改变内部身份码和任务密文。
- 任务标题和详情在发送到 Worker 前加密，D1 中保存 `rtenc:v2:...` 密文（v2 直接把 32 字节身份码作为密钥材料，用 HKDF-SHA256 派生 AES-GCM 密钥，无迭代次数）。
- 客户端与 Worker 只读写 `rtenc:v2`；Worker 拒绝明文及其他密文版本，客户端不再包含旧密文派生、解密或后台迁移逻辑。
- 标签、颜色、日期、状态和排序字段保持明文，以支持服务端存储和客户端筛选排序。
- 2026-08-22 对生产 D1 的只读核验确认：所有 63 条任务标题及 22 条非空详情均为 `rtenc:v2`，其余详情为空，明文及旧密文版本均为 0。
- 内部身份码同时作为任务的数据分区键保存在 D1，因此该模型延续 1.0 的安全边界，不是服务端不可解密的零知识架构；优点是不依赖平台 Secret 或额外主密钥。
- 浏览器端 v2 任务密钥用 HKDF-SHA256 从身份码直接派生；服务端密码哈希使用 PBKDF2-SHA-256（100,000 次），不得超过 Cloudflare Workers 当前支持的迭代上限。

### PWA 与多端体验

- 提供应用图标、Service Worker 离线缓存和版本更新检查；网页启动阶段不显示独立 Splash，本地快照恢复后直接进入任务页或登录页。
- 启动时缓存优先加载应用壳，并从 IndexedDB 立即恢复持续解锁的任务快照；随后检查版本和远程数据。
- 已登录设备保持 180 天滚动会话，多个设备可同时登录；退出登录、改密、重置或禁用会撤销相应会话。会话 Cookie 为 `HttpOnly`、`SameSite=Lax`，同时下发 `Expires` 与 `Max-Age`，确保 PC 浏览器从书签、外部链接等入口打开时也能保持登录态（2.2 起由 `SameSite=Strict` 调整）。
- 启动先显示本地任务快照，随后拉取远端权威数据。新建、编辑、完成、删除与排序每次都直接尝试写入远端，不以浏览器网络状态字段作判断；只有请求超时或网络层失败才写入离线 outbox，并在任务上标记“未同步”。排序回放会刷新远端同列表任务、补齐离线期间新增的项目后再写入，避免旧排序记录堵塞后续操作。遗留 outbox 不阻塞远端读取，也不阻塞其中已可发送的创建操作；读取时合并保留本机未同步项。列表顶端会显示同步中、成功或失败的具体阶段与原因，可点击立即重试。回到前台、网络状态变化或定时检查时持续重试，成功后立即移除标记；同一任务冲突以最后成功同步的写入为准。
- Service Worker 检测到新版后自动更新：先持久化本地操作，再激活新版并刷新页面，无需确认；正在编辑任务、拖拽或登录弹窗打开时会推迟到安全时机，避免刷新打断输入。前台恢复仍先启动更新检查，但只等待有限时间；检查超时或网络失败不会锁死会话、outbox 或任务读取，后续会自动重试。
- 底部采用 56px（另加安全区）的全宽紧凑毛玻璃导航；任务内容可滚动到底栏背后并被实时模糊，列表末尾保留补偿空间以完整避让底栏。待办、已办页的 44px 主题色圆形“新增”按钮位于中间，我的页不显示新增按钮。真实手机与 iPad 页面不模拟设备四角圆角，由系统视口负责屏幕裁切，布局仅通过四向安全区避让圆角、刘海与 Home Indicator；34px 外框圆角只用于桌面机框预览。
- 竖屏时标题与筛选区固定，仅任务列表滚动；“待办/已办”标题固定为 24px，不随滚动变化。我的页从与任务页相同的顶部安全区基线开始。横屏时左侧功能区固定、右侧任务列独立滚动，标题保持横屏规格。自动同步和同一列表内的重新渲染会按首个可见任务恢复阅读位置，不再跳回顶部。
- 支持 iPhone、iPad、macOS Safari 和桌面宽屏；宽大于高时使用横屏双栏布局。

### 提醒与推送通知

- 任务卡片可设置提醒日期与时间（当前支持上海时区），并选择不重复、每天、每周或每月重复；提醒条目在卡片上以铃铛图标展示。
- 在任务卡片设置提醒时间时，如果系统通知尚未开启，会直接在该次点击中请求通知权限并注册推送（仍可在“我的”页单独管理）；已拒绝时静默跳过，不打断提醒设置。
- 页面打开时由前端本地检查到期提醒（25 秒节流，不产生额外 API 请求）：始终显示应用内横幅，已授权系统通知时再弹出浏览器通知；每个设备用本地 `fireKey` 防重。
- 页面关闭时由 Worker Cron（`* * * * *`，每分钟）扫描到期提醒，向该账号全部已注册推送设备发送 Web Push；推送使用 VAPID 加密（Web Push 协议 `aes128gcm`）。
- 推送负载在推送瞬间由 Worker 临时解密 `rtenc:v2` 任务标题，后台通知显示真实任务标题；明文只出现在内存与推送负载，不落库。格式或解密异常时回退通用文案（`RabbitToDo / 你有一条待办提醒`）。
- “我的”页展示真实订阅状态与已注册设备数（已开启/未注册/不可用），可一键请求权限并注册推送；“重新开启推送”会重新拉取 VAPID 公钥并重建不完整订阅；“发送测试通知”会立即向全部已注册设备推送一条测试通知，用于验证推送链路。
- 推送失败（非 404/410）保留触发时间，由下一次 Cron 继续重试，不吞提醒；无订阅时没有可送达设备，不重复提醒直接停用、重复提醒推进到下一次，避免每分钟空转放大 D1 读取。
- 推送服务返回 404/410（订阅过期/失效）时自动清理该订阅；完成任务、删除任务或清除提醒会同步停用/删除对应提醒。
- 订阅与提醒数据保存在 D1 新增的 `task_reminders`、`push_subscriptions` 两张表中（`migrations/0008_reminders.sql`），不修改既有任务表。

## 技术架构

```text
public/                  PWA 前端静态资源
public/console/          用户管理后台
src/worker.js            Cloudflare Worker API
migrations/              D1 数据库增量迁移
scripts/                 SQLite 数据导入辅助脚本
wrangler.jsonc           Worker、静态资源和 D1 绑定配置
DEVELOPMENT_CONVENTIONS.md  开发、验证、版本和发布约定
NEXT_VERSION_PROMPT.md      新对话启动 Prompt（优先使用）
```

前端为无框架的 HTML、CSS 和 JavaScript；后端由 Cloudflare Worker 提供 `/api/*`，D1 保存账号、会话、一次性重置记录与任务数据。

提醒链路：`public/app.js` 负责页面打开时的本地检查与横幅；`src/worker.js` 的 `scheduled` 处理器由 `wrangler.jsonc` 中的 `triggers.crons`（`* * * * *`）每分钟触发，扫描 D1 到期提醒并向已注册设备推送。推送密钥通过环境变量/Secret 提供：本地 `VAPID_PRIVATE_KEY`、`VAPID_PUBLIC_KEY` 写在 `.dev.vars`，生产用 `wrangler secret put` 配置。

## 本地开发

环境要求：Node.js 22+、pnpm。

```bash
pnpm install --frozen-lockfile
pnpm run db:migrate:local
pnpm dev --port 8792
```

本地地址通常为 [http://localhost:8792](http://localhost:8792)。使用已有用户名密码账号验证持续登录、离线恢复与任务同步，也可以输入一个新用户名验证注册流程。本地 Wrangler 使用模拟 D1，不会修改生产数据库。

本地 Wrangler **不会自动触发 Cron**（官方行为），需要手动触发 `scheduled` 处理器以验证提醒推送：

```bash
curl "http://localhost:8792/cdn-cgi/handler/scheduled"
```

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

2.0 账户体系对应的 `migrations/0006_user_accounts.sql` 已进入生产基线。2.1 的 `migrations/0007_offline_task_mutations.sql` 只给既有任务表增加可空的离线创建幂等编号及唯一索引。2.3 的 `migrations/0008_reminders.sql` 新增 `task_reminders` 与 `push_subscriptions` 两张表及索引。账号主题使用 `migrations/0009_account_theme.sql` 增加 `theme_color`；自动/手动排序使用 `migrations/0010_account_task_sort_mode.sql` 增加默认值为 `manual` 的 `task_sort_mode`。这些 migration 均为增量变更，不修改既有任务内容；`0010` 已进入生产基线，后续依赖新字段的版本仍须先执行对应远端 migration。

#### 含新 migration 的发布顺序

依赖新字段的版本必须**先执行远程 migration，再部署代码**：

```bash
pnpm run db:migrate:remote
pnpm run deploy
```

Cron 触发已内置于 `wrangler.jsonc` 的 `triggers.crons`（`* * * * *`），随 `pnpm run deploy` 一并生效，无需在 Dashboard 手工添加；可在 Dashboard → Workers & Pages → `rabbittodo` → Settings → Triggers → Cron Triggers 中确认。

推送密钥在生产首次部署前配置（本地开发用 `.dev.vars`，不入库）：

```bash
pnpm exec wrangler secret put VAPID_PRIVATE_KEY
pnpm exec wrangler secret put VAPID_PUBLIC_KEY
```

免费版额度提示：Cron 每分钟触发每天固定 1440 次调用，约占 Workers Free 每日 10 万请求额度的 1.44%（Cron 计入请求上限）；D1 Free 每日 500 万行读取、10 万行写入。当前提醒量级下余量充足，若后续提醒规模显著增长，再考虑降频或聚合推送。

其他发布同样应在确认 migration 成功后再推送 Git，由 Cloudflare 自动部署。迁移必须是增量且保护既有数据，禁止通过删除或重建生产表来完成普通升级。

### 发布前记录与回退

包含 D1 migration 的发布，在执行前先记录当前 Worker 版本和 D1 Time Travel bookmark：

```bash
pnpm exec wrangler deployments list
pnpm exec wrangler d1 time-travel info rabbittodo
```

需要完整 SQL 备份时执行 `pnpm run db:backup:remote`（默认写入 `backups/<时间戳>/`，导出远程 D1 全量 schema 与数据，并尝试一并记录 Time Travel bookmark 供回退参考）。


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

- 生产用户均使用随机内部身份码，旧身份码入口和审批兼容代码已经移除。
- 解锁材料、解密后的任务快照和待同步操作保存在已登录设备的 IndexedDB。清除网站数据、卸载 PWA 或退出登录会清除本地恢复层，D1 始终是远端权威数据。
- Background Sync 在各浏览器支持不一致；网络恢复、回到前台和定时检查会继续尝试发送本地 outbox，PWA 被完全终止时将在下次打开后继续。
- 服务端密码哈希 PBKDF2 必须保持在 Cloudflare Workers 支持范围内，固定为 100,000 次；任务内容只使用 v2 HKDF 派生，两者用途不同。
- 登录失败限速目前保存在单个 Worker 实例内，正式扩大使用规模前可迁移到 Durable Object、KV 或其他跨实例方案。
- 提醒时间当前仅支持上海时区；其他时区需要先扩展 `SUPPORTED_TIME_ZONES` 与服务端时区换算逻辑。
- 页面关闭时的提醒依赖浏览器推送通道与 Worker Cron；未注册推送的设备只能靠页面打开时的本地横幅提醒，不会收到后台推送。
- 有推送订阅但推送服务持续失败（非 404/410）时，提醒会保留触发时间由 Cron 每分钟重试，属于“不吞提醒”的预期行为；本地开发经代理推送可能较慢。
- 管理后台继续保留默认密码 `zhoumeng1987` 的哈希回退，源码不保存明文，但默认口令本身仍属于过渡方案；生产可用 Worker Secret `ADMIN_PASSWORD` 覆盖。
- 管理员一次性重置码只重置密码哈希，内部身份码和任务密文保持不变；获得重置码等同于获得该账号访问权，因此应严格限制后台权限。
- create/update outbox 在发送时从本地已解密任务快照重新生成 v2 payload，避免队列长期绑定旧传输内容；远端写入始终执行严格 v2 校验。
