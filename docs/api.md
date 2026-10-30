# Manage API 1.0

实现包：`@software-factory/manage` 0.1.0。目标DSH：0.2.1-alpha.2。本文是接口规范源，打包时复制到插件的 `docs/api.md`。类型唯一来源为 `packages/contracts/src/manage.ts`，发布包通过 `@software-factory/manage/types` 和生成的 `/remote` 提供前端声明。

## 1. 调用入口与权限

- 原生Client命名空间：`ctx.remote.sfManage`，共16个方法。本插件自带无页面Client桥，消费者不重复mount。
- 签名统一为 `method(token, request, signal?)`。token是短期界面授权，request是下文的JSON对象；signal交给宿主取消机制，不放入JSON。
- 每个方法均返回 `RemoteResult<ManageResult<T>>`，须检查传输与业务两层ok。
- 只读图查询使用Gateway；Manage不增加概览读取接口。
- 仅Manage专属真实Agent作用域注册两个草稿Tool，没有其他插件可注入的通用CUD服务。src/database是私有实现，不是供前端直接调用的入口。

### 1.1 先从认证网页取得界面授权

在已登录DSH的同源网页中：

```ts
const response = await fetch('/api/sf-manage/ui-session', {
  method: 'POST', credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json' }, body: '{}'
});
const sessionResult = await response.json();
if (!sessionResult.ok) throw new Error(sessionResult.error.message);
const { token, expiresAt } = sessionResult.data;
```

端点检查Connection认证准入、原始Host/Origin与同源Fetch信息。请求体仅为 `{}`；成功直接返回 `ManageResult<UiSession>`，此端点不套Remote外层。失败HTTP403，并返回业务错误。

授权有效20分钟，停用/重启使其失效；到期重新申请并重新预览。token只保存在前端内存，不写localStorage、会话日志、草稿、Tool参数或控制台。预览nonce同样不得进入AI上下文。

首版按单profile的operator管理草稿，不承诺多用户审批角色。token是认证网页能力，不是抵御恶意同进程插件或被控制浏览器的“人工点击证明”。Remote的peer存在本身不构成授权。

### 1.2 两层结果解包

```ts
import type {} from '@software-factory/manage/remote';
import type { ManageResult } from '@software-factory/manage/types';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';

function unwrap<T>(outer: RemoteResult<ManageResult<T>>): T {
  if (!outer.ok) throw new Error(outer.error.message);
  if (!outer.value.ok) throw new Error(outer.value.error.message);
  return outer.value.data;
}
const status = unwrap(await ctx.remote.sfManage.status(token, {}));
```

业务结果：`{ok:true,data:T}` 或 `{ok:false,error:{code,message,field?}}`。不要仅以HTTP200或外层ok认定保存成功，仍需检查回执state。

## 2. 基本类型

```ts
type NodeKind = 'Capability' | 'Agent' | 'AgentVersion';
type NodeRef = {vertexId:string} | {ref:string};
type DraftMode = 'overview' | 'new-agent' | 'new-version' | 'edit-version';
type DraftContext = {
  step:number; // 0..8
  origin:'overview'|'manage';
  selected?:NodeRef;
};
```

- vertexId是数据库真实顶点ID；Agent.agent_id是稳定业务ID，不能混用。
- ref是stageCreate返回的 `draft:...` 引用，允许同一草稿中继续挂载孩子；禁止自行把它当作HugeGraph原生ID。
- properties和set的值均为TEXT字符串；JSON字段先JSON.stringify再提交，不直接传数组或对象。
- 草稿最多50项变更、2MiB；请求最多256KiB。普通标识最长4096、标题200、字段文本131072字符，不接受未知请求字段或数据库透传参数。

## 3. 草稿结构与状态

`ManageDraft`返回：

| 字段 | 含义 |
| --- | --- |
| id / formatVersion | 草稿ID / 固定1 |
| title / mode | 名称和操作模式 |
| revision | 内容修订号，所有修改请求携带expectedRevision |
| state | editing、committing、saved、attention |
| createdAt / updatedAt | ISO时间 |
| context | 当前步骤、来源、选中对象 |
| changes | create/update/delete变更列表，每项含id |
| bases | 后端读取的原始NodeView，按vertexId索引，供预填与差异展示 |

changes结构：

```ts
type DraftChange =
  | {id:string;kind:'create';ref:string;label:NodeKind;parent:NodeRef;properties:Record<string,string>}
  | {id:string;kind:'update';target:NodeRef;set:Record<string,string>;unset:string[]}
  | {id:string;kind:'delete';target:NodeRef;confirmedParentIds:string[]};
```

草稿返回值不包含冻结计划的nonce、界面token或可伪造的批准标志。bases由后端生成，请求不能替换。服务端串行检查修订并保存，冲突返回REVISION_CONFLICT；前端应重新载入，不自动覆盖人工内容。

editing允许修改和删除；committing禁止编辑；saved可读取或删除草稿记录，但不再编辑；attention表示部分写入或结果待核对，保留原草稿和回执，不能直接删除或重提，先reconcile并人工处理现状。

## 4. 方法清单

所有参数表中的request均必传，即使内容是 `{}`。所有方法均需有效token。

| 方法 | request | 成功data |
| --- | --- | --- |
| status | `{}` | ManageStatus |
| createDraft | `{mode,title?,targetVertexId?}` | ManageDraft |
| listDrafts | `{includeSaved?}` | DraftSummary[] |
| getDraft | `{draftId}` | ManageDraft |
| updateDraft | `{draftId,expectedRevision,title?,context?}` | ManageDraft |
| deleteDraft | `{draftId,expectedRevision}` | `{deleted:true}` |
| stageCreate | `{draftId,expectedRevision,label,parent,properties}` | ManageDraft |
| stageUpdate | `{draftId,expectedRevision,target,set?,unset?}` | ManageDraft |
| stageMoveVersion | `{draftId,expectedRevision,target,parent}` | ManageDraft，只更换版本的逻辑Agent归属 |
| stageDelete | `{draftId,expectedRevision,target,confirmedParentIds?}` | ManageDraft |
| undoChange | `{draftId,expectedRevision,changeId}` | ManageDraft |
| previewChanges | `{draftId,expectedRevision}` | `{plan,approvalNonce}` |
| commitChanges | `{draftId,expectedRevision,planId,digest,approvalNonce}` | CommitReceipt |
| getReceipt | `{draftId,requestId}` | CommitReceipt |
| reconcile | `{draftId,requestId}` | CommitReceipt，只读核对 |

### 4.1 status

返回 `{apiVersion:'1.0',readyToCommit,gatewayReady,writerReady,diagnostic?,aiSessionIncluded:boolean}`。此方法只读：检查Gateway及写入目标Schema，不执行CUD。readyToCommit=false时查看diagnostic，不据此自动安装依赖或迁移Schema。

### 4.2 createDraft / listDrafts / getDraft

mode没有隐含数据库写操作。title省略显示“未命名草稿”。不选target也可以建立不完整草稿，之后逐步填写。

传targetVertexId时，后端从Gateway载入完整节点到bases并预选。edit-version模式的target必须是AgentVersion；FieldGroup不能编辑。选择目标不自动产生update变更。

listDrafts默认includeSaved=false；返回id、title、mode、revision、state、updatedAt、changeCount，按更新时间倒序。includeSaved=true可显示已入库草稿记录。getDraft用于完整恢复。

### 4.3 updateDraft / deleteDraft

updateDraft更新标题或context。仅更新context不增加内容修订、不使预览失效；标题或业务变化增加修订并使旧预览失效。context的step须为0..8，页面往返可携带selected。可选editingVersion保存已锁定的版本引用，独立于概览临时选中的父级；旧草稿缺省时前端从已选版本识别。context不是写入或批准授权。

deleteDraft删除的是Manage草稿记录，不执行图数据库删除。前端下拉“×”调用此方法，禁止与stageDelete混淆。committing/attention状态会返回DRAFT_LOCKED。

### 4.4 stageCreate

根据父类型强制关系：Capability→Capability为HAS_CHILD，Capability→Agent为HAS_AGENT，Agent→AgentVersion为HAS_VERSION。AgentVersion不能有孩子。

草稿properties可暂不完整，直到previewChanges才要求真实必填字段和JSON合法。新增时id、name、version等不填虚构默认值。返回的最后一项create含ref，用于新增孩子或继续编辑。

```ts
let draft = unwrap(await ctx.remote.sfManage.createDraft(token, {
  mode:'overview', title:'新增能力'
}));
draft = unwrap(await ctx.remote.sfManage.stageCreate(token, {
  draftId:draft.id, expectedRevision:draft.revision,
  label:'Capability', parent:{vertexId:rootVertexId},
  properties:{name:'用户提供的能力名称'}
}));
```

这两次调用写入草稿存储，图数据库写入次数为0。

### 4.5 stageUpdate

set和unset至少提供一项。同一字段不能同时set和unset。省略字段=保持原值；set=明确填写；unset=清空可选属性，不能用空字符串代替。

已有Capability仅可改name；已有Agent可改name和description，agent_id不可修改。AgentVersion可修改version（业务版本号，例如v2.0）及其他白名单版本属性，真实vertexId始终不变。版本号同一最终父Agent内唯一，提交时不得为空，也不能unset。根不能改名。对ref引用的新节点可继续填写其白名单属性，正式身份尚未入库。

逻辑Agent共享字段只能在其自身编辑流程中修改。版本流程context.editingVersion存在时，修改已有Agent返回EDIT_SCOPE；WebUI从概览右键打开逻辑Agent修改弹窗后，用已有updateDraft设置overview/selected上下文，预填名称和逻辑描述，关闭弹窗恢复原版本上下文。agent_id显示只读。上下文决定业务编辑范围，不能替代会话鉴权或人工批准；AI没有updateDraft/批准Tool，仍只可修改绑定草稿。

改版本号示例：`stageUpdate({draftId,expectedRevision,target:{vertexId},set:{version:'v2.1'}})`。同一草稿可合并版本号修改与stageMoveVersion，唯一性校验检查全部变更后的归属和版本号；不重新生成节点、不复制原资料。Agent.description与AgentVersion.description按目标类型独立处理。

同一已有节点的多次update会合并。第一次编辑时后端保存bases；若数据库对象已被改变，不能静默覆盖旧基线。

```ts
draft = unwrap(await ctx.remote.sfManage.stageUpdate(token, {
  draftId:draft.id, expectedRevision:draft.revision,
  target:{vertexId:versionVertexId},
  set:{developer:'用户提供的姓名'}, unset:['cost_json']
}));
```

### 4.6 stageDelete / undoChange

后端根据完整关系和当前草稿判断叶节点，不看页面是否折叠。根和仍有孩子的节点不能删除。删除前的新节点ref只撤销该次新增，不产生数据库删除。

多个父级时，前端先用Gateway node查询读取完整关系，向用户列出父节点。确认删除整个节点及全部挂载后，将实际父节点ID列表传入confirmedParentIds；缺少或不符返回SHARED_DELETE_CONFIRMATION_REQUIRED。此参数仅来自人工界面，后续AI会话不得自行生成批准。

undoChange按changeId撤销一项变更。若该新增节点已被其他草稿变化引用，撤销会拒绝，需要先撤销相关孩子，避免悬空引用。

所有操作只更新草稿。正式删除按“删除批准范围的挂载边→删除叶节点”执行，失败可能留下脱挂节点，回执如实显示，不自动补偿。

### 4.7 stageMoveVersion

调用者为受认证WebUI；AI仅能通过所属会话的草稿Tool调用同一个服务。参数target为当前AgentVersion，parent必须是逻辑Agent，支持已有vertexId或草稿ref。能力分类、版本、FieldGroup不能作为版本父级。只更新Manage草稿与修订，旧批准立即失效，不写图数据库。

已有版本产生 `kind:'move-version'` 变更，含target、fromParentId、parent；同一版本再次换父级只保留最后一次移动，选回原父级则撤销该移动，属性修改仍保留。新增草稿版本直接改变其create.parent，保留ref与已填写属性，不重复创建空版本。原版本必须只有一个逻辑Agent归属，异常多归属返回AMBIGUOUS_PARENT，不自动删除共享关系。目标Agent已有同号版本返回ALREADY_EXISTS。

版本的真实ID、版本号和全部版本属性不因移动改变；原ID中的历史Agent文字不用于判断当前归属，归属以HAS_VERSION为准。逻辑Agent共享字段展示新父级的资料，不将原Agent名称或描述覆盖到新Agent。预览明确展示原父级→新父级，并复用create_edge/delete_edge计划；正式保存先建立新HAS_VERSION并回读，再解除旧HAS_VERSION并回读，不创建/删除版本节点。既有属性修改可与移动共同审批保存。

失败沿用现有回执与只读核对：新关系已建立但旧关系尚未解除时可能暂有两个挂载，必须如实报告partial/unknown，不自动重放、删除节点或补偿。预览后原归属/数据库变化会拒绝旧计划。

```ts
draft = unwrap(await ctx.remote.sfManage.stageMoveVersion(token, {
  draftId: draft.id, expectedRevision: draft.revision,
  target: { vertexId: versionVertexId }, parent: { vertexId: newAgentVertexId }
}));
```

## 5. 预览与人工保存

### 5.1 previewChanges

检查数据库Schema、草稿必填、JSON、唯一身份、合法关系、根和叶节点规则，并读取完整基线。拒绝Gateway截断或不完整关系；不把best-effort读取宣称为事务快照。

plan包含id、draftId、revision、digest、beforeFingerprint、createdAt、expiresAt、steps。steps包含index、operation、description及必要的beforeNode、afterNode、edge、ref、set、unset。

物理operation为create_node、update_node、unset_properties、create_edge、delete_edge、delete_node。草稿引用由后端在创建节点回读后绑定真实ID；Agent原生ID由数据库返回，不由前端拼接。

预览有效10分钟，并绑定当前界面授权。重新预览替换旧计划；编辑内容使旧计划失效。approvalNonce只返给调用界面，保存在前端内存，用于随后人工点击保存。

### 5.2 commitChanges

```ts
const preview = unwrap(await ctx.remote.sfManage.previewChanges(token, {
  draftId:draft.id, expectedRevision:draft.revision
}));
// 界面展示preview.plan；以下调用只放在用户明确点击保存的处理函数中。
const receipt = unwrap(await ctx.remote.sfManage.commitChanges(token, {
  draftId:draft.id, expectedRevision:draft.revision,
  planId:preview.plan.id, digest:preview.plan.digest,
  approvalNonce:preview.approvalNonce
}));
```

服务端在同一串行队列中核对token、修订、digest、nonce、到期及数据库前置指纹，先持久化接受记录，再执行固定步骤。planId同时用作幂等requestId；同请求返回原回执，不重放写入。相同planId的修订或digest不同返回IDEMPOTENCY_CONFLICT。

唯一可能写图的Remote是commitChanges，禁止注册成AI Tool。代码示例不代表收到AI建议就自动调用提交。只要一个请求已发出后发生超时，就不能直接说完全未写入。

## 6. 回执与只读核对

CommitReceipt包含：requestId、draftId、revision、planId、digest、state、startedAt、finishedAt?、steps、results、bindings、error?。

- results每项：index、state（attempting/verified/unknown）、actualId?、error?。
- bindings：草稿ref到实际原生ID。
- steps：本次已批准的完整物理步骤，便于前端显示。

| state | 前端含义 |
| --- | --- |
| executing | 已接受并在执行，查询原requestId，不再提交新请求 |
| succeeded | 全部步骤已回读验证，刷新Gateway概览并定位 |
| failed | 本次执行失败；结合results判断是否发出请求 |
| partial | 已确认部分步骤，其他步骤未执行；不能自动重试整个计划 |
| unknown | 有请求或回读无法确认，先核对原回执 |
| stale | 预留状态；当前前置变化通常在提交前以业务错误DATA_CHANGED返回 |

getReceipt仅读取持久回执，不检查数据库。reconcile对已尝试但未确认步骤进行有界只读核对，可将unknown变为verified/partial/succeeded，但**不执行任何剩余步骤或自动补偿**。确认部分完成后，按实际现状人工建立新草稿继续，而非重放旧计划。

宿主重启会撤销所有界面授权和未提交预览；持久的executing回执转unknown、草稿转attention，不自动继续执行。

## 7. 字段白名单与必要校验

| 对象 | 字段 |
| --- | --- |
| Capability | name |
| Agent | agent_id、name、description |
| AgentVersion | version、status、developer、invoke_kind、dsh_ref、performance_evidence_json、constraints_json、model_dependencies_json、selection_policy_json、object_categories_json、input_schema、output_schema、intermediate_artifacts_json、cost_json、effect_json |

实际不可空：Capability.name；Agent全部三项；AgentVersion.version/status/input_schema/output_schema。其余版本属性可省略或unset。Schema必填策略不符时拒绝提交，不迁移数据库。status支持draft/enabled/disabled/able，未提供不自动填draft。

JSON均通过TEXT字符串提交：模型依赖是含name、可选vendor的对象数组；处理类别是字符串数组；中间产物是声明对象数组；其他JSON和输入输出为对象。输入输出对象可以是简明业务声明或旧JSON Schema，不编译为Tool参数验证器。

developer是版本级TEXT，多人用顿号分隔；模型、类别、优选指标和中间产物不建立Model/ArtifactType节点或旧关系。未改动的历史文本保持原值，修改其他字段不自动重写它。

## 8. 常用错误与处理

| code | 前端处理 |
| --- | --- |
| INVALID_INPUT / VALIDATION_FAILED | 按field提示修正；草稿无需清空 |
| UNAUTHORIZED | 界面重新申请授权并重新预览，禁止自动批准 |
| DEPENDENCY_UNAVAILABLE / CONFIG / SCHEMA | 展示依赖或配置问题，不自动安装/迁移 |
| REVISION_CONFLICT | 重新载入草稿，避免覆盖另一编辑 |
| DRAFT_LOCKED | 查询回执或选择其他草稿 |
| NOT_FOUND | 草稿、变更或节点已不存在 |
| ROOT_PROTECTED / STABLE_ID / ILLEGAL_RELATION | 禁止操作，保持稳定身份与关系 |
| EDIT_SCOPE | 版本流程不能修改已有逻辑Agent共享字段，请从概览逻辑Agent修改入口进入 |
| NOT_LEAF | 先处理孩子；不级联删除 |
| SHARED_DELETE_CONFIRMATION_REQUIRED | 列出全部父级并询问用户 |
| ALREADY_EXISTS | 选择已有Agent/版本，禁止覆盖创建 |
| READ_INCOMPLETE / LIMIT | 当前读取或大小无法安全处理，不伪称完整结果 |
| PLAN_STALE / DATA_CHANGED | 保留草稿，重新读取、核对与预览；旧对象基线变化时需撤销该项后重新编辑 |
| IDEMPOTENCY_CONFLICT | 不复用该requestId提交不同内容 |
| WRITE_UNKNOWN / READBACK_MISMATCH | 显示原回执，使用只读reconcile，不自动重试 |
| DATABASE / INTERNAL / UNAVAILABLE / CANCELLED | 保留内容并显示错误，已提交时先查原回执 |

本版包含统一WebUI和专属AI适配；验证为合成数据库、隔离宿主严格分发及真实DSH ToolRuntime作用域。真实浏览器认证、网页安装、模型对话和真实库CUD仍需部署验收。

## 9. 原生AI会话接入

### ensureAssistant（仅草稿/会话，无图写入）

调用者：认证WebUI。参数 `{draftId, sourceSessionId?}`，仍需token；返回 `{sessionId, workspace}`。错误包括UNAUTHORIZED、NOT_FOUND、DRAFT_LOCKED、DEPENDENCY_UNAVAILABLE、SESSION_BUSY。未启用原生依赖时可以继续手工填写。status.aiSessionIncluded现在为boolean，表示运行时依赖已接入，不代表模型路由或安全预设已成功开通；ensureAssistant失败会返回诊断。

服务端根据草稿持久绑定产生独立Session ID；sourceSessionId仅用来读取宿主实际来源Agent的模型选择与WorkingDirectory，不是授权依据。不接受前端传入路径或模型凭据。没有来源会话、来源已关闭或未加载时，采用DSH WorkingDirectory.defaultDirectory和默认模型，不要求先打开来源；新会话固定这些初始值，恢复不覆盖已在原生选择器切换的模型。

会话由 `agents.create/resume` 和 `agentPresets.mount/select` 接入。`software-factory-manage` 安全预设负责冷恢复。Tools限制通过真实exec.agent对象身份、agents.get注册对象、Tool定义同一性及草稿持久归属共同执行；不是检查调用者自填agentId。继承工具仅放行现有Gateway的hugegraph_read；官方read/read_image定义通过正常ToolRuntime局部注册，不导出官方工具套件的write/edit。guard同步拒绝其他入口，pre-execute只做额外拒绝或next，不强制allow、不绕开宿主策略。文件读取使用宿主文件系统，拒绝凭据名称、目录及Manage实际envFile路径；原生附件上传由DSH拥有，不另造上传Remote。

| Tool | 参数 | 返回与权限 |
| --- | --- | --- |
| sf_manage_read_draft | `{}` | 当前会话所属草稿与Gateway完整业务图；不含token、计划批准或nonce |
| sf_manage_edit_draft | `{action,expectedRevision,...}` | create用label/parent/properties；update用target/set/unset，可选label仅核对真实类型；move-version用target/parent；delete用target。只暂存本会话草稿，成功返回ManageDraft，失败为业务错误 |
| hugegraph_read | 既有Gateway Tool参数 | 复用现有只读查询，无CUD或任意请求透传 |
| read | `{file_path,offset?,limit?}` | DSH官方有界UTF-8资料读取，经过真实会话与路径检查 |
| read_image | `{file_path}` | 附件服务可用时提供；读取前由官方工具检查模型是否支持图片 |

两个草稿Tool不接受draftId、sessionId、approved或confirmedParentIds。AI不能确认多父叶节点删除，界面必须明确询问并通过stageDelete确认。Tool使用同一草稿service和修订检查，与人工编辑冲突返回REVISION_CONFLICT；未知可选信息省略，不编造缺项。连续删除按草稿模拟后的图判断叶节点：已暂存删除孩子后，可再暂存删除父级；保存计划按此顺序执行，仍需同一次人工批准。

AI草稿Tool的JSON Schema与执行参数解析共用 `assistant/edit-contract.ts`。`update` 不使用 `properties`，已有节点使用 `{vertexId:真实ID}`，新增草稿节点使用 `{ref:'draft:…'}`，两者不能混用。可选 `label` 必须与真实节点类型一致，不改变目标或赋予权限；类型不一致返回 `INVALID_INPUT`、field=`label`。其他缺项、错类型或多余字段返回 `INVALID_INPUT` 并指出字段，不再误报 `INTERNAL`。该兼容仅作用于AI Tool，UI Remote的stageUpdate参数不变。

```json
{"action":"update","expectedRevision":2,"label":"AgentVersion","target":{"vertexId":"av:agent%3Aexample:0.1.0"},"set":{"developer":"用户提供的姓名"}}
```

以上ID与修订号仅为格式示例，实际调用须先读取当前草稿和图。AI成功后再次读取草稿核实实际变更；错误时按具体字段修正，禁止改动无关字段试错。修改草稿不等于保存入库。

ManageDraft新增可选 `lastCommitRequestId`，仅供刷新后读取既有回执，不包含批准能力。草稿列表的attention/committing状态可通过getDraft读取此指针，再getReceipt/reconcile。nonce永不持久到浏览器。

版本能力描述：AgentVersion.description为独立可选TEXT；Agent.description为逻辑总体能力。创建版本可省略description；更新保持原值时不提交该键，填写使用set.description，清空使用unset:["description"]。不得复制或回写逻辑描述。所有操作仍先写草稿，最终人工保存。当前FieldGroup基线为八类19项。
