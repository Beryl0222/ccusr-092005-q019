# 医者荣誉遴选后端

面向奖项评审秘书处的**可审计、可复现、不可篡改**的荣誉遴选系统。零运行时依赖，基于 Node.js 内置 `node:test`、`node:crypto`。

## 它解决什么问题

评审秘书处面临三类信任问题：

1. **身份与成果重复**——同一医生被医院按「个人技术」「团队项目」「社会服务」拆成多个候选；个人与团队的共同成果被重复计入。
2. **回避与计票不可信**——评委与推荐单位有合作；弃权、回避被折算成低分；并列被随意打破；事后改票。
3. **公示与历史说不清**——公示内容超出候选本人授权；异议期暗改选票；勘误说不清前后差异与批准人；无法复现历史轮次。

本系统以**事件溯源（event sourcing）+ 哈希链**回应：所有业务动作都只追加事件；当前状态由折叠事件得到；证据原件、选票、勘误、批准人全部留在链上。秘书处可以把同一份事件日志重放到任意轮次、任意时点。

## 核心机制

### 1. 规则、名额、轮次冻结

- 届次创建后，类别、每类名额、评审轮次、截止时间、并列顺位规则经 `freezeRules` 一次冻结（`RULES_FROZEN`），内含 `rulesHash`；开始后再次冻结或改动一律拒绝。
- 阶段只能沿固定顺序向前推进：`SETUP → NOMINATION → FACT_CHECK → PROFESSIONAL_REVIEW → SOCIAL_REVIEW → DELIBERATION → PUBLICITY → OBJECTION → FINALIZED`，不能倒流。

### 2. 提名与人工身份归并

区分两个概念，避免「一刀切合并」或「一律视为多人」：

- **自然人（person）**：人工核验证件（证件号只存哈希）后，把指向同一人的多条提名关联到同一 `personId`——即使分属不同类别（个人技术奖 / 社会服务奖）。
- **候选资格（candidate）**：不同类别是不同资格，**分别评审、分别计票**；同类别重复提名才做吸收式归并（`CANDIDATES_MERGED`），保留归并依据、理由、操作人。

团队候选需有联系人；个人与团队通过 `TEAM_LINKED` 关联。

### 3. 共同成果不重复计入，但分别说明贡献

- 共同成果对个人候选和团队候选使用**同一条成果记录**与 `dedupeKey`；重复 `dedupeKey` 申报被拒。
- 各候选通过 `ACHIEVEMENT_CREDIT_DECIDED` 分别写明自己的贡献，评审可看到「个人贡献 / 团队贡献」两份说明。

### 4. 证据：原件哈希、更正理由、截止约束

- 证据提交即对原件计算 SHA-256 指纹并永久保留（`EVIDENCE_SUBMITTED`）。
- 更正只追加新版本（`EVIDENCE_AMENDED`），**原件哈希不动**，必须填写处理理由。
- 首次提交与补充材料分别受 `deadlines.evidence` / `deadlines.evidenceSupplement` 截止时间约束。
- 更正会使原核验结论与依赖它的入围决定自动失效（`PENDING_RECHECK`），重新核验通过前该候选不能评分；前次结论保留在 `history`。

### 5. 候选本人确认公开范围

候选本人按板块白名单授权（`CANDIDATE_CONSENT`）：`basic / nominator / achievements / evidence_sources / contribution`。公示严格按白名单生成，未授权板块一律不出现；勘误也不得加入未授权板块。

### 6. 利益冲突决定查看与评分权限

- 评委登记后通过 `COI_DECLARED` 声明与某候选 / 自然人 / 推荐单位 / 机构的利益冲突，声明即生效；误报只能由秘书处**留痕撤回**（`COI_WITHDRAWN`）。
- 冲突按**自然人身份组**传导：医生在一个类别回避，则其所有候选资格、其所属团队、其推荐单位维度均回避；团队成员冲突传导到整个团队。
- 存在冲突的评委既**不能查看**候选材料（`viewCandidateMaterial` 拒绝），也**不能评分**（服务端强制，而非仅前端隐藏）。

### 7. 分阶段评审、弃权/回避不计低分、并列处置

- 事实核验（`FACT_CHECK`）通过且列明已核验证据，候选才具备评分资格（`FACT_ELIGIBILITY_DECIDED`）。
- 专业评议、社会责任审议在各自阶段进行；评分限冻结规则的 `[min,max]`。
- **弃权是显式动作**（须填理由），`value=null` 不计入分母、绝不按 0 处理；回避者从评委名册剔除，也不产生低分。
- 投票**以首次提交为准**，不能重复投票、不能改票；轮次结果封存后评分通道在任何阶段都关闭。
- 跨名额线的并列不由计票单方面打破：未处置并列时拒绝封存；必须按冻结 `tieRule` 引用顺位键（`RULE`）或由委员会裁定（`COMMITTEE`，需批准人+理由）。

### 8. 公示、异议与勘误

- 公示取自**已封存轮次**的入选名单，按候选授权生成快照（`PUBLICATION_PUBLISHED`）；缺授权不能公示。
- 异议只能在 `OBJECTION` 阶段提出（`OBJECTION_FILED`），可登记复核的证据但不能引用他人证据；异议期只复核，**没有改票通道**。
- 勘误（`PUBLICATION_CORRECTED`）记录候选、板块、**前值/后值**、理由、**批准人**、时间，并可关联异议编号；当前公示快照同步更新，但每次勘误永久留痕。
- 异议全部结论后才能 `finalize` 结束届次。

### 9. 历史复现与篡改发现

- 每条事件含 `prevHash` 与自身哈希，形成哈希链；任何插入、删除、修改都会被 `verifyChain` / 载入时校验发现。
- 封存轮次时记录事件序号区间 `[fromSeq,toSeq)` 与**该轮全部选票集合的指纹** `scoreSetHash`。
- `AuditService.replayRound` 把日志折叠回封存时点重新计票，逐一比对指纹与名次——暗改选票必然暴露；`replayAt(toSeq)` 可复现任意历史时点。
- `publicationCorrections` 逐条说明「改了什么、谁批准」；`evidenceTrail` 展示原件哈希与更正链；`identityTrail` 展示重名/跨类别归并依据。

## 目录结构

```
src/
  core/            # 哈希、错误类型、哈希链事件存储
    hash.js
    errors.js
    eventStore.js
  domain/          # 事件类型、阶段枚举、投影 reducer、策略（回避/计票/公示过滤）
    events.js
    projection.js
    policy.js
  services/        # 命令服务：遴选、评审、公示异议、审计复现
    selectionService.js
    reviewService.js
    publicityService.js
    auditService.js
  index.js         # 统一导出 + createHonorsBackend 组装
examples/
  walkthrough.js   # 端到端秘书处场景演示
test/              # node:test 测试（43 项）
fixtures/seed.json
```

## 使用

```bash
npm test            # 运行全部测试
npm run walkthrough # 端到端演示：归并、回避计票、封存复现、勘误审计
```

最小用法：

```js
import { createHonorsBackend, Stage, ConsentSection } from "./src/index.js";

const api = createHonorsBackend();           // 共享同一事件存储
api.selection.createEdition({ editionId: "E1", name: "2026 年度", year: 2026 });
api.selection.freezeRules("E1", { categories: ["个人技术奖"], quotas: { 个人技术奖: 1 },
  rounds: [{ roundId: "R1", stage: Stage.PROFESSIONAL_REVIEW, scoring: { min: 0, max: 100 } }],
  deadlines: {} });
// …提名、归并、证据、回避、打分、封存、公示…

api.audit.verifyIntegrity();                 // 哈希链完整性
const replay = api.audit.replayRound("E1", "R1");
replay.scoreSetHashMatches;                  // 复现计票与封存是否一致
```

事件日志可落盘并在载入时校验：

```js
await api.store.persist("./data/edition.json");
const store = await EventStore.fromFile("./data/edition.json"); // 被篡改即抛 CHAIN_TAMPERED
```

## 设计取舍

- **为什么用事件溯源而非共享表格**：回避、计票、勘误的异议本质是「能否证明当时发生了什么」。事件日志是只追加的事实来源，表格的单元格可被静默覆盖；哈希链让任何覆盖都可被发现，折叠复现让「当时的结果」不依赖当前数据库状态。
- **弃权为什么必须显式**：缺票与弃权语义不同。系统要求弃权填理由并存 `null`，从计票分母排除；这样既不折算低分，也保留了「该评委看过但选择不评」的可解释性。
- **证据更正为什么牵连入围失效**：若新内容自动继承「已核验」，更正就成了绕过事实核验的暗道；让结论失效并重核，虽严格但堵住了这条路径，更正窗口也因此受补充截止时间限制。
- 证件号等敏感身份信息只存哈希；公示快照不含机构等未授权字段。
