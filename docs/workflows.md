# workflow-mcp 工作流文档

本文档覆盖所有 15 个工作流领域的 53 个工具。本文重点说明 **5 个新增工作流**（Notify、Container、Scaffold、Secrets、Webhook），其余 10 个工作流请参考已有文档或 README。

---

## 目录

- [1. 🔔 通知 (Notify)](#1--通知-notify)
- [2. 📦 容器 (Container)](#2--容器-container)
- [3. 📋 脚手架 (Scaffold)](#3--脚手架-scaffold)
- [4. 🔐 密钥管理 (Secrets)](#4--密钥管理-secrets)
- [5. 🔄 Webhook](#5--webhook)

---

## 1. 🔔 通知 (Notify)

发送通知到 Slack、企业微信、Email 等多个渠道。

### 环境变量配置

| 变量 | 渠道 | 说明 |
|------|------|------|
| `NOTIFY_SLACK_WEBHOOK` | Slack | Slack Incoming Webhook URL |
| `NOTIFY_WECOM_KEY` | 企业微信 | 企业微信机器人 Webhook Key |
| `NOTIFY_SMTP_HOST` | Email | SMTP 服务器地址 |
| `NOTIFY_SMTP_PORT` | Email | SMTP 端口（默认 25） |
| `NOTIFY_EMAIL_FROM` | Email | 发件人地址 |
| `NOTIFY_EMAIL_TO` | Email | 收件人地址 |
| `NOTIFY_WEBHOOK_<NAME>` | 自定义 | 自定义 Webhook 渠道 |

### 工具列表

#### notify_send

向单个渠道发送通知。

```json
{
  "channel": "slack",
  "title": "部署完成",
  "message": "v2.1.0 已部署到生产环境",
  "priority": "high"
}
```

支持优先级：`low`、`normal`（默认）、`high`、`critical`

#### notify_send_multi

群发通知到多个渠道。

```json
{
  "channels": ["slack", "wecom"],
  "title": "系统通知",
  "message": "例行维护完成"
}
```

#### notify_list_channels

列出所有已配置的可用通知渠道。

```json
{}
```

---

## 2. 📦 容器 (Container)

Docker 镜像构建、推送和 Compose 编排管理。

### 工具列表

#### docker_build

从 Dockerfile 构建镜像。

```json
{
  "directory": "/path/to/project",
  "tag": "myapp:latest",
  "dockerfile": "Dockerfile.prod",
  "buildArgs": {
    "NODE_VERSION": "18",
    "APP_ENV": "production"
  },
  "noCache": false
}
```

#### docker_push

推送镜像到仓库。

```json
{
  "tag": "myapp:latest",
  "registry": "registry.example.com",
  "username": "deploy",
  "password": "your-token"
}
```

> 如果已通过 `docker login` 登录，可以省略 `registry`、`username`、`password`。

#### docker_compose_up

启动 Compose 服务。

```json
{
  "directory": "/path/to/project",
  "services": ["web", "api"],
  "detach": true,
  "build": true,
  "envFile": ".env.production"
}
```

#### docker_compose_down

停止 Compose 服务。

```json
{
  "directory": "/path/to/project",
  "removeVolumes": false,
  "removeImages": false
}
```

---

## 3. 📋 脚手架 (Scaffold)

内置模板项目生成器，支持 Vue 3、React、Next.js、Node.js、Express API 等模板。

### 内置模板

| 模板名 | 框架 | 包含内容 |
|--------|------|----------|
| `vue3-app` | Vue 3 + Vite | TS 配置、App.vue、env.d.ts |
| `react-app` | React 19 + Vite | TS 配置、App.tsx、CSS |
| `next-app` | Next.js 15 + App Router | Layout、Page、next.config.ts |
| `node-ts` | Node.js + TypeScript | TS 配置、src/index.ts、utils |
| `express-api` | Express + TypeScript | 路由示例、health 路由 |

### 工具列表

#### scaffold_init

从内置模板创建新项目。

```json
{
  "template": "vue3-app",
  "name": "my-awesome-app",
  "outputDir": "./my-awesome-app",
  "vars": {
    "packageName": "my-awesome-app"
  },
  "force": false
}
```

#### scaffold_add_module

往已有项目添加模块。

```json
{
  "module": "vue-component",
  "name": "UserProfile",
  "directory": "./my-project"
}
```

支持的模块类型：

| module | 适用项目 | 生成位置 |
|--------|----------|----------|
| `vue-component` | Vue 项目 | `src/components/<Name>.vue` |
| `react-component` | React 项目 | `src/components/<Name>.tsx` |
| `express-route` | Express 项目 | `src/routes/<Name>.ts` |

会自动检测 `package.json` 中的依赖来判断项目类型。

---

## 4. 🔐 密钥管理 (Secrets)

AES-256-GCM 加密的本地密钥存储，支持多环境 profile 隔离。

### 工作原理

- 加密密钥存储在 `~/.workflow-mcp/secrets/.master`（自动生成，仅创建时读取）
- 每个 profile 存储为一个 JSON 文件：`~/.workflow-mcp/secrets/<profile>.json`
- 使用 AES-256-GCM 对值进行加密，只有 master key 可解密
- profile 支持多环境隔离（如 `dev`、`staging`、`production`）

### 工具列表

#### secret_set

存储密钥。

```json
{
  "key": "API_KEY",
  "value": "sk-abc123...",
  "profile": "production"
}
```

#### secret_get

获取密钥值。

```json
{
  "key": "API_KEY",
  "profile": "production"
}
```

返回明文值。

#### secret_list

列出密钥（值仅显示图标，不展示明文）。

```json
{
  "profile": "production"
}
```

不传 `profile` 则列出所有 profile 及其密钥数量。

#### secret_remove

删除密钥。

```json
{
  "key": "API_KEY",
  "profile": "production"
}
```

---

## 5. 🔄 Webhook

临时 HTTP 服务接收 Webhook，以及发送 Webhook 请求。

### 工具列表

#### webhook_listen

启动临时 HTTP 服务器接收 webhook。

```json
{
  "port": 8080,
  "path": "/webhook",
  "timeout": 300,
  "secret": "my-webhook-secret"
}
```

- 默认路径 `/webhook`，默认端口 `8080`
- 支持 HMAC-SHA256 签名验证（`X-Hub-Signature-256` 和 `X-Hub-Signature`）
- 超时自动关闭（默认 300s，最长 3600s）
- 发送 `POST /webhook/stop` 可提前终止监听

返回所有接收到的请求摘要。

#### webhook_fire

发送 webhook 请求到外部系统。

```json
{
  "url": "https://hooks.example.com/events",
  "method": "POST",
  "payload": {
    "event": "deploy.completed",
    "version": "v2.1.0"
  },
  "headers": {
    "X-Custom-Header": "value"
  },
  "secret": "shared-secret"
}
```

- 支持 `POST`、`PUT`、`PATCH`
- 设置 `secret` 会自动计算 HMAC-SHA256 签名并添加 `X-Hub-Signature-256` 和 `X-Hub-Signature` 头
- 自定义 `headers` 支持传递任意请求头
