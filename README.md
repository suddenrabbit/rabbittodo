# RabbitToDo 1.0

RabbitToDo 是一个面向个人使用的轻量待办 PWA，围绕“快速记录、跨设备同步、低干扰管理”设计。它可以安装到 iPhone、iPad 和桌面设备，并根据窗口横竖比例切换响应式布局。

当前生产地址：[todo.srabbitwork.site](https://todo.srabbitwork.site)

当前 1.0 基线：

- Git commit：`800d017`
- 应用版本：`v20260731.204635`
- Service Worker 缓存：`rabbittodo-v34`
- 数据平台：Cloudflare Workers + D1
- 源代码：GitHub `suddenrabbit/rabbittodo`

## 1.0 功能概览

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

### 账户与登录（下一版本本地开发中）

- 用户名用于登录和界面展示，长度为 2–10 位；英文大小写按同一用户名处理。
- 新用户名确认一次密码后自动创建并登录，不再进入管理员审批流程。
- 既有 6 位身份码用户首次打开新版时，需使用原身份码并设置用户名、密码；浏览器会把任务重新加密，账号与任务随后切换到新的 256 位随机内部身份码。
- 管理后台位于 `/console/`，支持查看、启用、禁用账号，以及生成一次性密码重置码。
- 历史 `pending` 账号在 migration 中自动转为 `enabled`，已有 `disabled` 状态保持不变。

### 内容加密

- 新用户直接使用 256 位随机内部身份码作为固定加密种子；既有用户升级时也会生成同规格的新身份码，并在浏览器中把原任务从旧身份码密钥重新加密到新身份码密钥。
- 密码只用于服务端认证，不直接参与任务加密；修改或重置密码不会改变内部身份码和任务密文。
- 任务标题和详情在发送到 Worker 前加密，D1 中保存 `rtenc:v1:...` 密文。
- 标签、颜色、日期、状态和排序字段保持明文，以支持服务端存储和客户端筛选排序。
- 旧的明文任务由新版客户端首次读取后在后台分批加密回写。
- 内部身份码同时作为任务的数据分区键保存在 D1，因此该模型延续 1.0 的安全边界，不是服务端不可解密的零知识架构；优点是不依赖平台 Secret 或额外主密钥。

### PWA 与多端体验

- 提供应用图标、启动 Splash、Service Worker 离线缓存和版本更新检查。
- PWA 从后台恢复时先检查并接管新 Service Worker，再同步任务，避免旧脚本读取新格式数据。
- 在可见状态下每 30 秒同步一次任务；回到前台时主动检查版本和数据。
- 新增、编辑、完成、删除和排序采用乐观更新，界面先响应，数据库写入在后台串行执行。
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

本地地址通常为 [http://localhost:8792](http://localhost:8792)。使用身份码 `246810` 验证既有用户首次升级，也可以输入一个新用户名验证注册流程。本地 Wrangler 使用模拟 D1，不会修改生产数据库。

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

本次账户升级需先执行 `migrations/0006_user_accounts.sql`，确认成功后才可部署依赖新字段的代码。迁移只为既有账号表补充可空字段并新增会话、重置码表，不修改或重建任务表；既有 `pending` 自动启用，`disabled` 保持不变。老用户真正登录升级时，应用再以事务方式更新该用户的任务归属与密文。

其他发布同样应在确认 migration 成功后再推送 Git，由 Cloudflare 自动部署。迁移必须是增量且保护既有数据，禁止通过删除或重建生产表来完成普通升级。

### 发布前记录与回退

包含 D1 migration 的发布，在执行前先记录当前 Worker 版本和 D1 Time Travel bookmark：

```bash
pnpm exec wrangler deployments list
pnpm exec wrangler d1 time-travel info rabbittodo
```

本次账户升级的推荐顺序是：记录上述回退点，执行 `pnpm run db:migrate:remote`，确认成功后再部署代码并完成登录、旧用户升级、任务读取和管理后台烟雾测试。

如果发布后只是前端或 Worker 代码故障，优先在 Cloudflare Dashboard 的 **Workers & Pages → rabbittodo → Deployments** 回退到上一稳定版本，或使用：

```bash
pnpm exec wrangler rollback [上一稳定版本 ID]
```

代码回退不会自动回退 D1。本次 `0006_user_accounts.sql` 本身是增量迁移，保留新增列和新表不会妨碍 1.0 Worker 读取尚未升级的老用户；但一旦已有用户完成升级，其旧身份码与旧密文已被随机内部身份码和新密文替换，1.0 Worker 将无法识别这些账号。生产发布后若尚无人升级，可临时回退代码；若已有账号完成升级，应保持新版数据不动并优先修复、重新部署新版，不能要求用户再使用已经失效的旧身份码。

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

- 既有用户升级前仍以原 6 位身份码读取任务；升级成功后，旧身份记录和旧密文会被新的 256 位随机身份码与新密文原子替换。
- 为兼容 D1 免费套餐的单次查询上限，既有账号目前最多自动迁移 40 条任务；超过上限时不会改动旧账号或密文，需要先制定单独迁移方案。
- 解锁后的加密种子只保存在当前浏览器会话的 `sessionStorage`。同一会话刷新可继续使用，完全关闭浏览器后即使服务端会话尚有效，也需要再次输入密码解锁。
- 登录失败限速目前保存在单个 Worker 实例内，正式扩大使用规模前可迁移到 Durable Object、KV 或其他跨实例方案。
- 管理后台继续保留默认密码 `zhoumeng1987` 的哈希回退，源码不保存明文，但默认口令本身仍属于过渡方案；生产可用 Worker Secret `ADMIN_PASSWORD` 覆盖。
- 管理员一次性重置码只重置密码哈希，内部身份码和任务密文保持不变；获得重置码等同于获得该账号访问权，因此应严格限制后台权限。
- 历史明文自动加密逻辑应保留过渡期；确认生产 D1 不再存在明文后，可在后续版本评估清理并强制只接受密文。
