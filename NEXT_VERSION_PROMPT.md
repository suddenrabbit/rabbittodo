# RabbitToDo 2.6 新对话启动 Prompt

复制下面内容到新的 Codex 对话，并在末尾填写第一个需求。

---

我们继续开发 RabbitToDo 2.6。项目仓库位于：

`/Users/zm/Documents/GitHub/rabbittodo`

生产地址：

`https://todo.srabbitwork.site`

开始工作前，请完整阅读：

- `/Users/zm/Documents/GitHub/rabbittodo/README.md`
- `/Users/zm/Documents/GitHub/rabbittodo/DEVELOPMENT_CONVENTIONS.md`

然后执行：

```bash
git status --short
git log -5 --oneline
```

当前本地开发基线：

- 分支：`main`
- commit：`8cd65b0`（后续以 `git log` 为准）
- 应用版本：`v20260824.194953`
- Service Worker：`rabbittodo-v114`
- 技术栈：原生 HTML/CSS/JavaScript PWA + Cloudflare Worker + D1
- 本地预览：`http://localhost:8792`
- 本地与生产 D1 均已应用 `migrations/0010_account_task_sort_mode.sql`；后续新增 schema 仍须先执行对应的 `pnpm run db:migrate:remote`，再部署代码。

当前产品要点：

- 待办与已办双页；任务包含加密标题/详情、颜色、标签、截止日期、状态、提醒、完成和置顶。
- 账号可选五种主题色，跨设备同步；新建任务默认使用当前主题色。
- 待办排序模式是账号级偏好，默认手动。手动模式可拖拽并保留置顶区与普通区的顺序；自动模式禁用拖拽但不覆盖手动顺序。
- 自动排序：置顶按后置顶在前；普通任务按截止日期升序，无截止日期最后；相同截止日期及无截止日期任务按“进行中 → 无状态 → 暂停”，再按添加时间。已办始终按完成时间倒序。
- 自动排序开关仅在待办页展开筛选后显示，位于“按标签”标题行右侧。
- 底栏是 56px 高、28px 圆角、最大宽度 280px 的紧凑悬浮毛玻璃胶囊，玻璃使用 24% 白色底、20px 模糊、150% 饱和度、30% 白色 1px 边框与极轻阴影，底部位于安全区上方 6px。任务内容可滚动到胶囊及安全区背后，列表末尾保留 `74px + safe-area-inset-bottom` 的避让空间。待办、已办按钮基础触控区为 56 × 44px，选中项扩展为无描边的 72 × 44px 中性淡灰色内胶囊，图标与文字仍使用主题色；44px 主题色圆形新增按钮位于 88px 宽的中央栏，我的页不显示新增按钮。横屏任务页的胶囊按右侧任务列表居中，横屏切回竖屏时自动收起筛选区；iOS 主屏 PWA 使用包含安全区的 `100vh` 填满视口，避免 `svh/dvh` 与底部安全区重复留白。不实现滚动自动收缩。真实设备不硬编码屏幕四角圆角，桌面机框预览保留模拟圆角。
- 竖屏固定标题与筛选区，仅任务列表滚动；“待办/已办”标题固定为 24px，不随滚动变化。竖屏筛选触发框为 40px，筛选与首个任务分区间距紧凑；我的页顶部与任务页使用相同安全区基线。横屏固定左侧功能区、右侧列表独立滚动，标题保持横屏规格。
- 已办页左上角品牌为 `RabbitDone`；待办与我的页保持 `RabbitToDo`。
- 已登录设备会从 IndexedDB 恢复任务快照和离线 outbox；远端同步是权威数据。标题与详情使用浏览器端 `rtenc:v2` 加密，密码不参与任务加密。
- PWA 更新自动应用，但编辑、拖拽或登录弹窗打开时延后；前台更新检查、会话和任务读取均有限时，超时保留本地快照与 outbox 并可恢复重试。任何前端缓存资源改动必须同步更新应用版本与 Service Worker 缓存名。

开发、验证、版本、缓存、迁移、发布和 Git 约束以 `DEVELOPMENT_CONVENTIONS.md` 为唯一权威来源；本 Prompt 仅提供启动上下文与当前产品快照。

请先确认已理解现状和开发约定，不要立即改代码。我的第一个新需求是：

【在这里填写】

---
