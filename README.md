# 医者荣誉遴选后端

面向“医者荣誉”评选的可审计领域后端。推荐机构提交候选身份、类别、事迹与证明来源，秘书处人工归并身份、候选本人确认公开范围；事实核验、专业评议、社会责任审议分阶段推进；评委利益冲突声明决定其对特定候选的查看与评分权限；弃权与回避不折算成低分；规则、名额、轮次一经开始即冻结；公示仅展示获准内容，异议期可复核证据但禁止暗改选票与材料。

## 设计要点：事件溯源 + 链式哈希

遴选全过程的唯一事实来源是只追加的事件日志（`src/domain/journal.js`）：

- 每条事件携带 `hash = SHA256(prevHash || canonical(payload))`，首条锚定 `GENESIS`；
- 任何插入、删除、改写历史事件都会在加载/校验时断链暴露（`journal.verify()`）；
- 选票同样是事件；计票时固化“选票摘要”，异议期可重算比对（`verifyBallotsIntact`）；
- 任意历史时刻可按事件序号前缀重放复现（`stateAt(seq)`、`reproduceRound(events, roundId, seq)`）。

当前状态是日志的纯函数折叠（`src/domain/projection.js`），所有“能不能做”的规则集中在 `src/domain/service.js`，适配层（HTTP）不承载业务规则。

## 规则落地位置

| 诉求 | 实现 |
| --- | --- |
| 同一医生被按个人技术/团队项目/社会服务拆分提名 | `mergeIdentities` 人工归并身份簇（个人与团队不混并），误归并可 `unlinkIdentity`，全部留痕 |
| 候选本人确认公开范围 | `confirmConsent`（full / deeds_only / custom 四字段）；未确认不进公示；deeds_only 隐名 |
| 三阶段分阶段推进 | `openStage/recordStageVerdict/completeStage`，严格前置顺序：事实核验→专业评议→社会责任审议 |
| 评委合作单位回避 | `declareCOI` 可对候选/身份簇/推荐单位声明：recuse 不可见不可评、restricted 仅脱敏可见不可评、none 完整权限；未声明默认无权 |
| 弃权与回避不算低分 | 计票时回避/受限整体排除、弃权单独计数，二者均不进分母，均分仅基于有效打分 |
| 规则名额轮次开始即冻结 | `defineRules` 仅冻结前可用；`openEdition` 自动冻结并校验类别/轮次齐备 |
| 补充材料受截止时间约束 | 提名截止与补充截止分别校验 |
| 更正保留原件哈希与理由 | `correctEvidence` 永久保留 originalHash 与每次更正链；异议期内必须出示批准 |
| 共同成果避免重复计入 | `declareSharedWork` 各方分别说明贡献，`allocateSharedWork` 只能计入一个候选 |
| 并列处置 | 名次线并列未正式处置（`resolveTie`，方法与理由留痕）不得确定获奖/公示；不跨名额线的并列不阻断 |
| 公示只展示获准内容 | `publishRound` 按授权生成快照；未授权跳过并说明 |
| 公示勘误前后可查、谁批准 | `correctPublication` 需对应批准，前后快照永久保留，`publicationDiff` 输出字段级差异与批准人 |
| 异议期复核证据、禁止暗改 | `requestEvidenceReview/closeEvidenceReview` 受异议截止约束；改动须批准；选票摘要封存校验 |
| 复现任一历史轮次 | `reproduceRound(events, roundId, upToSeq)` |

## 目录

```
src/
  domain/
    journal.js     追加写事件日志与链式哈希校验
    projection.js  事件→状态归约与查询选择器（含评委权限、公示视图）
    service.js     SelectionService：全部命令与规则把关、计票、并列处置、公示勘误
    replay.js      历史轮次复现与勘误深度差异
    store.js       日志文件落盘/重载（重载即验链）
    crypto.js      稳定序列化与 SHA-256
    clock.js       可注入时钟（测试可固定/快进）
    errors.js      领域错误码
  bootstrap.js     把 fixtures/seed.json 导入全新届次
  seed.js          种子读取（保留基线接口）
  server/http.js   JSON HTTP 适配层
  server/index.js  启动入口
test/              63 个测试：日志链、冻结/截止、归并、授权、回避与计票、
                   证据更正、共同成果、阶段门、并列、公示勘误、异议封存、
                   历史复现、HTTP、落盘篡改、端到端场景
fixtures/seed.json 端到端场景数据（拆分提名、共同成果、三家推荐机构、三名评委）
```

## 使用

```bash
npm test                 # 运行全部测试
PORT=3000 node src/server/index.js
```

命令统一走 `POST /commands`，body：`{"command": "...", "payload": {...}}`，
操作人取 `x-actor` 头（生产环境应替换为鉴权中间件）。

查询：`GET /state`、`GET /state?atSeq=12`（历史时刻）、`GET /journal/verify`、
`GET /judge-view/:judgeId/:candidateId`、`GET /rounds/:id/awardees`、
`GET /rounds/:id/ballots-intact`、`GET /rounds/:id/reproduce?atSeq=`、
`GET /publications/:id/diff`、`GET /candidates/:id/public-view`。

典型全流程见 `test/scenario.test.js`：拆分提名→重名归并→本人隐名授权→三阶段→
合作评委回避计票（回避/弃权不进分母）→公示→异议复核与批准勘误→哈希链与选票封存校验→历史轮次复现。
