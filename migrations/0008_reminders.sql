-- 2.3 提醒功能：新增两张关联表，不修改现有 tasks 表，保护既有生产数据。

CREATE TABLE IF NOT EXISTS task_reminders (
  reminder_id TEXT PRIMARY KEY,
  identity_code TEXT NOT NULL,
  task_id INTEGER NOT NULL,
  remind_at TEXT NOT NULL,
  tz TEXT NOT NULL,
  repeat_rule TEXT NOT NULL DEFAULT '{"freq":"none"}',
  next_fire_at TEXT NOT NULL,
  last_fired_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (identity_code) REFERENCES identities(code),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

-- 每个任务最多一个提醒（一对一），防止重复。
CREATE UNIQUE INDEX IF NOT EXISTS task_reminders_identity_task_idx
  ON task_reminders(identity_code, task_id);

-- Cron 调度按触发时间与启用状态扫描到期提醒。
CREATE INDEX IF NOT EXISTS task_reminders_fire_idx
  ON task_reminders(next_fire_at, enabled);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  identity_code TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (identity_code) REFERENCES identities(code)
);

-- endpoint 全局唯一，防止同一推送通道重复登记。
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_idx
  ON push_subscriptions(endpoint);

-- 按用户列出全部订阅，用于 Cron 向多设备推送。
CREATE INDEX IF NOT EXISTS push_subscriptions_identity_idx
  ON push_subscriptions(identity_code);
