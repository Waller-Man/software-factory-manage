# 软件工厂 Manage 管理后端

运行在 DeepSeek Harness（DSH）中的软件工厂管理后端，提供能力分类、逻辑 Agent 与具体版本的新增、修改、删除草稿，以及人工确认后的 HugeGraph 写入。

**普通用户请下载 Releases 中的预编译安装包，按下面的新电脑快速启动步骤安装。源码下载 ZIP 不等于插件安装包。** Manage 依附 DSH 运行，没有独立网站、独立启动命令或自己的聊天系统；管理页面由配套 WebUI 提供。

## 功能

- **节点管理**：新增能力分类、逻辑 Agent 和子版本；修改分类名称、逻辑 Agent 名称及能力描述，修改版本资料。已有 `agent_id` 保持不变。
- **版本维护**：修改业务版本号（如 `v2.0`），或将同一版本改挂到另一个逻辑 Agent；保留真实节点 ID 和已有资料，同一父 Agent 下不能重号。
- **草稿与恢复**：改动先进入草稿，可继续编辑、恢复、撤销变更或删除草稿；不会因为填写表单或关闭页面自动入库。
- **人工预览与保存**：保存前核对变更内容及影响范围，用户明确确认后才写数据库；保留提交回执，重复提交不重复执行已记录的写入。
- **原生 AI 辅助**：复用 DSH 会话、模型选择和附件能力，帮助读取资料、整理字段和修改草稿；没有可用模型时仍可手工编辑。
- **八类注册字段**：当前 FieldGroup 基线为 19 项；逻辑能力描述与版本能力描述独立，版本描述缺省时显示“未填写”，不拿逻辑描述代替。

Manage 负责草稿、审批和写入；WebUI 负责展示和用户操作；Gateway 负责只读查询。Manage 不执行已登记的业务算法，也不会在启用时创建、迁移或重建数据库 Schema。

## 环境与配套插件

当前开发目标为 **DSH 0.2.1-alpha.2、Node.js 24 或以上、HugeGraph 1.7.0**，Cordis peer 版本为 `4.0.5-alpha.1`。其他版本需另外核对兼容性。

| 使用场景 | 需要准备的服务 |
| --- | --- |
| 读取能力树、节点和字段元数据 | 已准备好的 HugeGraph 软件工厂图，以及 Gateway 只读插件，包版本声明为 `^0.1.1` |
| 管理草稿与人工保存 | Manage，以及 DSH 原生 Connection、API Gateway、Typert、Storage Domain 和持久存储后端 |
| 使用概览、入库和修改页面 | 配套 WebUI；只安装 Manage 不会出现完整管理页面 |
| 使用 AI 草稿助手 | DSH 原生 Agents、Tools、SystemPrompt、AgentPresets、WorkingDirectory 及可用的 provider/model |

Manage 将 Gateway 声明为 peerDependency，应先安装并启用 Gateway。后端启用与 AI 服务就绪是两回事，缺少模型不代表可以跳过人工保存。

数据库需已包含 Capability、Agent、AgentVersion、FieldGroup 和 HAS_CHILD、HAS_AGENT、HAS_VERSION，版本描述需已加入 AgentVersion 可选属性。新电脑可以连接现有数据库；复制插件安装包不会自动创建或恢复数据库。

**数据库连接只在 Gateway、Manage 后端配置，不向 WebUI 填写数据库密码。** 两个后端必须指向同一张图；模型密钥由 DSH 管理，不另填到 Manage 的数据库配置中。

## 新电脑快速启动：使用预编译包

### 1. 准备宿主和数据库

1. 安装并启动兼容版本的 DSH，确认其原生网页可以正常登录，侧栏有“插件”管理入口。
2. 准备能从 DSH 所在电脑访问的 HugeGraph 软件工厂图；需要迁移数据库时，先单独完成数据库及 Schema 准备。
3. 安装并启用 Gateway，配置数据库连接，确认 `hugegraph_read` 调用 `{"action":"health"}` 返回 `ready: true`。
4. 如需 AI 辅助，先在 DSH 中配置可用模型和工作区。

本 README 从 DSH 已正常运行开始说明；宿主安装、启动命令及数据库部署以对应项目的说明为准。数据库位于另一台电脑时，连接地址不能继续使用本机的 `127.0.0.1`。

### 2. 下载并解压 Manage

从项目的 **Releases／发布** 获取 `software-factory-manage-0.1.0.zip`，解压到一个长期保留的目录，例如：

```text
D:\DSH-Plugins\software-factory-manage\
├── package.json
├── cordis.patch.yml
├── README.md
├── .env.example
├── icon.svg
├── lib\
├── locale\
├── docs\api.md
└── scripts\check-connection.mjs
```

以**包含 `package.json` 的目录**为准；解压后如果多了一层文件夹，继续进入内层。普通用户不需要安装源码依赖、执行构建或启动额外后端进程；DSH 安装器仍可能解析包依赖，因此不承诺完全离线安装。

尚未发布 Release 时，请联系维护者获取预编译 ZIP 或完整运行目录。同版 `.tgz` 是 npm 格式分发包，供支持该格式的安装器或开发者使用。

### 3. 配置数据库连接

在上述 **Manage 安装目录**中，将 `.env.example` 复制为 `.env`，与 `package.json` 放在同一层。首次配置可执行：

```powershell
Set-Location 'D:/DSH-Plugins/software-factory-manage'
Copy-Item -LiteralPath '.env.example' -Destination '.env'
notepad .env
```

填写这五项，连接格式与 Gateway 一致：

```dotenv
HUGEGRAPH_BASE_URL=http://127.0.0.1:18080
HUGEGRAPH_GRAPHSPACE=DEFAULT
HUGEGRAPH_GRAPH=hugegraph
HUGEGRAPH_USERNAME=
HUGEGRAPH_PASSWORD=
```

- 地址、图空间、图和凭据应与 Gateway 指向同一张现有图；用户名、密码只在本地填写，不上传到源码仓库或 Releases。
- 也可在 DSH 的 Manage 插件配置中，将 `envFile` 指向已有 Gateway `.env` 的绝对路径，避免维护两份配置。
- 相对路径按 **Manage 插件目录**解析，不按 DSH 启动目录解析；不会自动搜索源码目录或用系统环境变量覆盖连接。
- 如果实际安装的是解压包，把 `.env` 放在源码 `packages/manage` 中不会生效。升级时保留原 `.env`，不要用空模板覆盖。

插件不再强制检查配置文件的 ACL 或 Unix 权限位，但 DSH 进程需要能读取文件；仍检查普通文件、大小、UTF-8 和配置格式。

### 4. 在 DSH 网页安装

1. 打开“插件 → 添加插件 → 安装第三方插件”。
2. 安装来源填写 Manage 解压目录的绝对路径，例如 `D:\DSH-Plugins\software-factory-manage`。这是 **DSH 服务端电脑**上的路径，浏览器电脑上的路径不能代替服务端路径；目录方式不要填写 ZIP 文件或上一级目录。
3. 安装完成后启用该 Bundle 及 `sf-manage` 条目，确认没有激活错误；同时保留随包的 Manage 草稿助手预设。
4. 安装并启用配套 WebUI，刷新网页，在侧栏打开“软件工厂概览”或“软件工厂入库”。

Manage 复用 DSH 的网页、认证和进程，不额外监听 HTTP 端口。目录安装后请保留该目录，不要删除、移动或改名。

也可使用包含 Gateway、Manage、WebUI 的软件工厂组合 Bundle。**独立安装与组合安装选择一种，不要重复启用相同插件。** 组合安装时按各后端实际配置的 `envFile` 放置连接文件，不能照搬独立 ZIP 的内部目录假设。

### 5. 检查连接

在 Manage 安装目录执行：

```powershell
node scripts/check-connection.mjs
```

若使用外部配置文件，传入该文件的绝对路径：

```powershell
node scripts/check-connection.mjs 'D:/DSH-Plugins/software-factory-gateway/.env'
```

成功结果包含 `ok: true`、`schema: "compatible"` 和 `databaseWrites: 0`。此命令仅读取 Schema，不执行新增、修改或删除；它不替代 Gateway 健康检查，也不代表真实写库已经验证。

### 6. 验证可用

- **概览**：能够读取能力树，查看逻辑 Agent 和版本详情；进入“修改”后可右键节点，将新增、修改或叶节点删除加入草稿。
- **入库与修改**：可创建草稿，按第 0—8 步填写或修改；已有版本资料会预填，第 0 步只允许选择逻辑 Agent 作为新父级，不会复制成空版本。
- **AI 辅助**：助手能够读取资料、查询工厂数据并整理当前草稿；附件上传沿用 DSH，PDF/DOCX 等二进制内容的解析取决于宿主可用能力。
- **人工保存**：先查看变更预览，需要正式入库时再明确确认。仅为验证安装，无须写入测试节点或运行耗时算法。

**插件已启用不等于数据库、模型或真实业务算法都已验证。** 如页面仍是旧版，重启 DSH 并按 `Ctrl+F5` 刷新。

## AI 权限与数据保护

**实际数据库 CUD、人工批准和提交入库没有注册为 DSH AI Tool。**

| 调用入口 | 能做什么 |
| --- | --- |
| Manage 专属 AI 会话 | 通过 `sf_manage_read_draft`、`sf_manage_edit_draft` 读取或修改绑定草稿；使用只读查询及受限原生文件读取 |
| 普通聊天、编排及其他插件 | 不获得 Manage 专属草稿权限、通用数据库写工具或原始写客户端 |
| 受认证的 WebUI | 操作草稿，预览变更，由用户明确批准后提交保存 |
| Manage 私有写入组件 | 校验批准计划及草稿修订后，执行限定的节点、属性和关系写入 |

AI 不获得批准 Tool、通用文件写入或 Shell Tool。人工批准绑定具体变更，批准后的内容变化不能继续使用旧批准。

根节点不可修改或删除；仅允许删除叶节点，多父叶节点需由用户确认全部挂载范围。同一草稿先删完孩子后，可继续删除已成为叶节点的父节点。请保持同一张图由 Manage 独占写入，停用旧注册写入口，不并行运行修改该图的数据库脚本。

## 更新与停用

- **更新**：按发布说明替换安装文件，保留本地 `.env`，重启 DSH，再按 `Ctrl+F5` 刷新网页；需要时同步更新 WebUI、Gateway。
- **停用／启用**：在 DSH“插件”页操作。停用不会删除数据库、草稿或历史回执；如果保存被中断，重新启用后按原回执核对，不默认重放写入。
- **草稿位置**：草稿、会话绑定和提交回执保存在 DSH Storage Domain 的 `software_factory_manage` 域，不在插件代码目录或 `.env` 中。
- **更换电脑**：另外备份和迁移数据库、DSH 持久数据及工作区；安装包只包含插件程序，不包含用户草稿、会话、模型配置和数据库内容。

Manage 本身不产生算法运行成果；业务产物由 Runtime 或对应业务插件保存和交付。

## 遇到问题

- **配置或依赖报错**：检查安装目录中的 `.env`、Gateway 和 DSH 原生服务。
- **页面或 AI 不可用**：检查 WebUI 和模型配置；更新后重启 DSH 并按 `Ctrl+F5` 刷新。
- **保存超时**：保留草稿与原回执，先核对结果，不要重复入库。

仍有问题时提供版本、报错和操作步骤，不要发送密码或 `.env`。

## 接口与二次开发

接口参数和调用方式见[接口文档](docs/api.md)。AI 及 stage 系列只改草稿，正式写库仍须认证界面人工确认。

源码依赖 reconstruct 中的 Contracts、Gateway 和匹配版本的 DSH 开发环境，尚不支持单独复制 Manage 目录构建。准备好环境后，在 reconstruct 根目录执行：

```powershell
npm.cmd run build:manage
npm.cmd run check:manage
npm.cmd run test:manage
npm.cmd run pack:manage
```

DSH 源码不在相邻的 `DSH-Softwarefactory` 目录时，通过 `DSH_SOURCE` 指定位置。

## 发布与安装包

打包结果位于 `packages/manage/artifacts/`：

- `.zip`、`.tgz`：上传远程仓库的 **Releases**，普通用户推荐 ZIP。
- `release/software-factory-manage/`：可直接按目录安装。

源码正常提交 Git；生成目录和本地 `.env` 不提交、不上传。
