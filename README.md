# workflow-mcp

一个基于 **MCP（Model Context Protocol）协议**的**全能工作流自动化服务器**，提供 **15 个工作流领域、50+ 个工具**，覆盖开发、运维、数据处理全流程。

> 🧩 兼容任何 MCP 客户端（Claude Desktop、VS Code、JetBrains 等），通过 stdio 通信。

---

## 📋 工作流总览

| 工作流 | 描述 | 工具数 |
|--------|------|--------|
| **Git** | 分支管理、自动提交、合并 PR、同步 Fork、状态查看 | 5 |
| **文件处理** | 目录监听、带忽略规则的文件读写 | 5 |
| **代码审查** | 按严重级别审查差异、生成审查报告 | 4 |
| **部署** | 配置验证、滚动部署、失败自动回滚 | 4 |
| **ETL** | 数据提取、转换、加载流水线，支持定时调度 | 4 |
| **定时器** | 基于 Cron 表达式的任务调度，持久化存储 | 4 |
| **通知** | 发送 Slack、企业微信、邮件通知 | 3 |
| **容器** | Docker 镜像构建/推送、docker-compose 管理 | 4 |
| **脚手架** | 从内置模板快速生成 Vue/React/Next/Node/Express 项目 | 2 |
| **密钥管理** | AES-256-GCM 加密的密钥存储，支持多环境配置 | 4 |
| **Webhook** | 监听/发送 Webhook 请求，HMAC 签名验证 | 2 |
| **数据库** | 多类型数据库查询（SQLite/PostgreSQL/MySQL/MariaDB） | 4 |
| **远程管理** | SSH 远程命令执行、文件传输、端口隧道 | 4 |
| **日志管理** | 日志查看、搜索、轮转、分析、实时关键字监控 | 5 |
| **工作流编排** | 多步骤工作流定义与执行引擎，支持变量替换和错误处理 | 6 |

---

## ⚡ 快速开始

```bash
# 安装依赖
npm install

# 构建
npm run build

# 启动 MCP 服务器（stdio 模式）
npm start

# 开发模式（自动监听文件变化）
npm run dev
```

---

## 🔧 各工作流详情

### 1. 🔗 Git 工作流
| 工具 | 说明 |
|------|------|
| `git_create_branch` | 从指定基分支创建新分支 |
| `git_auto_commit` | 自动暂存并提交变动 |
| `git_create_pr` | 创建 Pull Request |
| `git_merge_branch` | 合并分支 |
| `git_sync_fork` | 从上游仓库同步 Fork |

### 2. 📁 文件处理
| 工具 | 说明 |
|------|------|
| `file_watch` | 监听指定目录的文件变更（创建/修改/删除） |
| `file_read` | 高效读取文件内容，支持忽略规则 |
| `file_write` | 写入文件内容，支持路径自动创建 |
| `file_search` | 在目录中搜索文件 |
| `file_list` | 列出目录文件，支持 glob 过滤和忽略规则 |

### 3. 👀 代码审查
| 工具 | 说明 |
|------|------|
| `review_diff` | 审查代码差异，按严重级别分类 |
| `review_file` | 审查单个文件 |
| `review_report` | 生成代码审查报告 |
| `review_summary` | 生成审查摘要和统计数据 |

### 4. 🚀 部署
| 工具 | 说明 |
|------|------|
| `deploy_validate` | 验证部署配置 |
| `deploy_run` | 执行部署（滚动更新模式） |
| `deploy_rollback` | 回滚到上一个稳定版本 |
| `deploy_status` | 查询部署状态和发布历史 |

### 5. 🔄 ETL 数据流水线
| 工具 | 说明 |
|------|------|
| `etl_extract` | 从数据源提取数据 |
| `etl_transform` | 转换数据 |
| `etl_load` | 加载数据到目标 |
| `etl_run` | 运行完整 ETL 流水线（提取→转换→加载） |

### 6. ⏰ 定时任务
| 工具 | 说明 |
|------|------|
| `scheduler_add` | 添加 Cron 定时任务 |
| `scheduler_list` | 列出所有定时任务 |
| `scheduler_remove` | 删除定时任务 |
| `scheduler_status` | 查看任务执行状态 |

### 7. 🔔 通知
| 工具 | 说明 |
|------|------|
| `notify_send` | 发送通知到指定渠道（Slack/企业微信/邮件） |
| `notify_send_multi` | 多通道同时发送通知 |
| `notify_list_channels` | 列出可用的通知通道 |

### 8. 📦 容器
| 工具 | 说明 |
|------|------|
| `docker_build` | 构建 Docker 镜像 |
| `docker_push` | 推送 Docker 镜像到仓库 |
| `docker_compose_up` | 启动 docker-compose 服务 |
| `docker_compose_down` | 停止 docker-compose 服务 |

### 9. 📋 脚手架
| 工具 | 说明 |
|------|------|
| `scaffold_init` | 从模板初始化新项目 |
| `scaffold_add_module` | 为已有项目生成新模块 |

**内置模板**：Vue 3 + Vite、React + Vite、Next.js、Node.js + Express 完整项目结构。

### 10. 🔐 密钥管理
| 工具 | 说明 |
|------|------|
| `secret_set` | 保存加密密钥，自动 AES-256-GCM 加密 |
| `secret_get` | 读取解密后的密钥值 |
| `secret_list` | 列出当前环境的所有密钥名 |
| `secret_remove` | 删除指定密钥 |

支持多环境配置（Profile），适用于开发/测试/生产隔离。

### 11. 🔄 Webhook
| 工具 | 说明 |
|------|------|
| `webhook_listen` | 启动 HTTP 服务器监听 Webhook 事件 |
| `webhook_fire` | 发送 Webhook 请求到外部系统（支持 HMAC 签名） |

### 12. 🗄️ 数据库
| 工具 | 说明 |
|------|------|
| `db_query` | 执行 SQL 查询（SELECT/INSERT/UPDATE/DELETE） |
| `db_list_tables` | 列出数据库中的所有表 |
| `db_export` | 导出查询结果为 JSON/CSV |
| `db_import` | 从 CSV/JSON 文件导入数据 |

支持数据库类型：**SQLite、PostgreSQL、MySQL、MariaDB**。

### 13. 🖥️ 远程管理
| 工具 | 说明 |
|------|------|
| `remote_exec` | 在远程服务器上执行命令 |
| `remote_copy` | 上传/下载文件到远程服务器 |
| `remote_script` | 在远程服务器上执行本地脚本文件 |
| `remote_tunnel` | 建立 SSH 端口隧道 |

### 14. 📊 日志管理
| 工具 | 说明 |
|------|------|
| `log_tail` | 查看日志文件最近的 N 行 |
| `log_search` | 在日志文件中搜索（支持正则表达式） |
| `log_rotate` | 日志轮转（按大小、压缩、保留份数） |
| `log_analyze` | 日志分析（Nginx/Access/Error/JSON 格式） |
| `log_watch` | 实时监控日志文件中的关键字告警 |

### 15. ⚙️ 工作流编排
| 工具 | 说明 |
|------|------|
| `workflow_define` | 定义多步骤工作流 |
| `workflow_run` | 执行工作流，支持 `${varName}` 变量替换 |
| `workflow_update` | 更新现有工作流定义 |
| `workflow_list` | 列出所有已定义的工作流 |
| `workflow_remove` | 删除工作流 |
| `workflow_run_list` | 查看工作流执行记录 |

---

## 🛠️ 开发与测试

```bash
# 构建（TypeScript 编译到 dist/）
npm run build

# 开发模式（监听文件变化）
npm run dev

# 运行测试
npx vitest run

# 启动守护进程模式（支持定时任务持久化）
npm run start:daemon
```

---

## 📦 技术栈

| 技术 | 用途 |
|------|------|
| **TypeScript** | 全栈类型安全 |
| **MCP SDK** | 标准化的模型上下文协议通信 |
| **SQLite (better-sqlite3)** | 定时任务、工作流编排持久化 |
| **Zod** | 运行时参数校验与类型推断 |
| **SSH2** | 远程服务器管理 |
| **Chokidar** | 文件系统事件监听 |

---

## 📄 文档

完整的工作流文档请查看 [`docs/workflows.md`](docs/workflows.md)，涵盖每个工具的详细参数说明和示例。

---

## 📝 许可证

MIT
