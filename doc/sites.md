# Sites 工程说明

行为合同见 [Sites 私有资料库](../spec/sites-library.md)。本扩展沿用上游关系画布与图文正文，保留本机 Node/SQLite/stdio 入口；`worker/` 为 Cloudflare Workers 后端。

## 构建与发布

通过当前官方 Sites building/hosting 流程注册一次，返回身份保存到私有 checkout 的 `.openai/hosting.json`。更新始终复用同一身份。公开 fork 保持 `.openai/` 被忽略，私有 Site 源码才跟踪该文件。清单只需 `d1: "DB"`、`r2: "BUCKET"`、`capabilities: ["mcp"]` 和平台返回的 `project_id`；账号、实例配置与凭据不写入公开代码。

运行 `npm ci` 与 `npm run build:site`。维护结构时才用 `npm run db:generate` 生成追加式迁移；发布使用随源码提交的既有迁移，不重新生成或修改已发布文件。Worker 为 `dist/server/index.js`，网页资源在 `dist/client/`，清单与迁移在 `dist/.openai/`。生成的 Wrangler 配置仅用于本地验证，正式资源由 Sites 管理。使用官方 `site-workflow.mjs` 保存源码、构建、打包，再调用官方私有发布工具，检查成功终态。不得向上游写入、force push 或修改访问范围来通过验证。

## 一致性与认证

`worker/library.mjs` 使用 D1 预编译单语句和原子 `batch`。每次变更先对全库 revision 比较交换；批内的非空约束检查失败则整体回滚。并发重新读取计划，不替换用户的内容版本或请求标识。变更与重试凭据在同一批内提交。标签批量变更使用单条 SQL。

`db/schema.ts` 和 `drizzle/` 管理结构，已发布迁移不改写。升级迁移 `0001` 只追加正文格式及关系类型、理由、版本字段；旧正文保持纯文本，旧连接保留标识、两端并补默认说明。请求只插入空画布状态，不建立或修改表。D1 和 R2 都在服务器资料库模块访问。

Sites 管理 owner-only 策略、ChatGPT 登录和插件 OAuth。Worker 只信任平台传入的用户身份；仅有服务访问凭据时拒绝资料读写。API 写入额外检查同源和专用请求头。MCP 的发现只含工具说明，不包含记录。

`worker/mcp.mjs` 使用官方 WebStandardStreamableHTTPServerTransport，提供无状态 `POST /mcp` 初始化、发现和调用。网页、JSON 接口与 MCP 共用 15 个工具和校验规则。原 `/api/tools` 不作为远程 MCP。插件由 Sites 提供，不另建 App、不配置本地 MCP、不安装持续 GitHub 凭据。

## 附件与导出

20 MiB 原件经过大小、摘要、类型签名和 UTF-8 校验，先写 R2 并读回检查，再提交 D1 元数据。跨存储没有事务；失败可遗留未引用原件，相同请求可安全重试。下载核对完整原件；HTML 等主动内容强制下载并设置 sandbox。不提供 OCR、PDF 全文识别或远程 URL 下载。

gzip 导出保持本机版本 3 格式和 128 MiB 解压上限，先逐段计算 canonical JSON 摘要，再按流输出，避免一次驻留全部附件。原本机恢复命令可读入并写向新的隔离目录；第一版不提供云端恢复或其他私有实例导入。

## 验证边界

`npm test` 保留本机集成测试，另以本地 workerd 和相同编译 Worker，经官方 HTTP MCP 客户端检验 D1/R2、重启、冲突、重试、连线、分页、完整导出及访问边界。测试数据全部临时、自行编写，不部署到正式资料库。协议通过不表示用户已经连接插件。

实际发布终态和 owner-only 策略经 Sites 工具另行核实。附加只读 WebMCP 使用 `document.modelContext` 特征检测，支持环境中的验证单独记录。平台登录、用户插件连接与手机实机体验不由本地构建代替。
