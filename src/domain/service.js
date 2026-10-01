import { EventJournal } from "./journal.js";
import {
  COI,
  STAGES,
  accessLevelOf,
  assignedJudges,
  ballotDigest,
  candidatesInRound,
  categoryOf,
  clusterOfCandidate,
  createInitialState,
  isFrozen,
  publicViewOfCandidate,
  reduce,
  roundConfig,
  rulesOf,
} from "./projection.js";
import { fail } from "./errors.js";
import { systemClock } from "./clock.js";

const SECTION_KEYS = ["identity", "category", "deeds", "evidenceSources"];

/**
 * 遴选命令服务。所有状态变更都以命令→校验→事件的方式经过这里：
 * 规则冻结、截止时间、阶段门、回避门、选票封存均不可绕过。
 */
export class SelectionService {
  constructor({ journal = new EventJournal(), clock = systemClock(), actor = "secretariat" } = {}) {
    this.journal = journal;
    this.clock = clock;
    this.defaultActor = actor;
  }

  // -- 基础 ----------------------------------------------------------------

  #now() {
    return this.clock.now();
  }

  #iso() {
    return this.#now().toISOString();
  }

  #append(type, payload, actor) {
    return this.journal.append(type, payload, actor ?? this.defaultActor, this.#iso());
  }

  /** 重建当前状态（每次调用都从日志折叠；规则规模下足够，且杜绝旁路状态）。 */
  state() {
    return this.journal.fold(reduce, createInitialState());
  }

  stateAt(seq) {
    return this.journal.fold(reduce, createInitialState(), { upToSeq: seq });
  }

  #requireRules(state) {
    const rules = rulesOf(state);
    if (!rules) fail("RULES_MISSING", "尚未定义评审规则");
    return rules;
  }

  #assertNotFrozen(state) {
    if (isFrozen(state)) {
      fail(
        "RULES_FROZEN",
        `规则、名额与评审轮次已于 ${state.edition.frozenAt} 冻结，不得变更`,
        { frozenAt: state.edition.frozenAt, frozenBy: state.edition.frozenBy }
      );
    }
  }

  #assertStarted(state) {
    if (state.edition.status !== "in_progress") fail("EDITION_NOT_STARTED", "遴选尚未开始");
  }

  #requireCandidate(state, id) {
    return state.candidates[id] ?? fail("CANDIDATE_NOT_FOUND", `候选不存在：${id}`, { candidateId: id });
  }

  #requireEvidence(state, id) {
    return state.evidences[id] ?? fail("EVIDENCE_NOT_FOUND", `证明材料不存在：${id}`, { evidenceId: id });
  }

  #requireApproval(state, approvalId, action, targetId) {
    const a = state.approvals[approvalId];
    if (!a) fail("APPROVAL_MISSING", `缺少批准记录：${approvalId}`, { approvalId });
    if (a.action !== action) fail("APPROVAL_WRONG_ACTION", "批准事项与操作不符", { expected: action, got: a.action });
    if (targetId && a.targetId !== targetId) {
      fail("APPROVAL_WRONG_TARGET", "批准对象与操作对象不符", { expected: targetId, got: a.targetId });
    }
    return a;
  }

  #beforeDeadline(deadlineIso, code, message) {
    if (deadlineIso && this.#now().getTime() > new Date(deadlineIso).getTime()) {
      fail(code, message, { deadline: deadlineIso, now: this.#iso() });
    }
  }

  // -- 届次与规则 ----------------------------------------------------------

  openEdition({ editionId, name }, actor) {
    const state = this.state();
    if (state.edition.status === "in_progress") fail("EDITION_ALREADY_STARTED", "遴选已在进行中");
    const rules = this.#requireRules(state);
    if (!Array.isArray(rules.rounds) || rules.rounds.length === 0) fail("RULES_NO_ROUNDS", "冻结前必须确定评审轮次");
    if (!Array.isArray(rules.categories) || rules.categories.length === 0) fail("RULES_NO_CATEGORIES", "冻结前必须确定奖项类别与名额");
    this.#append("EDITION_OPENED", { editionId, name: name ?? state.edition.name ?? editionId }, actor);
    if (!isFrozen(this.state())) this.#append("RULES_FROZEN", { at: this.#iso() }, actor);
    return this.journal.headHash();
  }

  /** 定义/修订规则。仅在冻结（即遴选开始）之前允许。 */
  defineRules({ version, rules }, actor) {
    const state = this.state();
    this.#assertNotFrozen(state);
    const normalized = normalizeRules(rules);
    this.#append("RULES_DEFINED", { version: version ?? `v${(state.edition.ruleVersions?.length ?? 0) + 1}`, rules: normalized }, actor);
    return normalized;
  }

  /** 赛前提前冻结规则（可选；openEdition 会兜底冻结）。 */
  freezeRules(actor) {
    const state = this.state();
    this.#requireRules(state);
    if (isFrozen(state)) return state.edition.frozenAt;
    this.#append("RULES_FROZEN", { at: this.#iso() }, actor);
    return this.#iso();
  }

  closeEdition(actor) {
    const state = this.state();
    this.#assertStarted(state);
    this.#append("EDITION_CLOSED", {}, actor);
  }

  // -- 推荐机构与提名 ------------------------------------------------------

  registerNominator({ nominatorId, name, type }, actor) {
    const state = this.state();
    if (state.nominators[nominatorId]) fail("NOMINATOR_EXISTS", `推荐机构已存在：${nominatorId}`);
    this.#append("NOMINATOR_REGISTERED", { nominatorId, name, type: type ?? "hospital" }, actor);
  }

  submitCandidate(
    { candidateId, nominatorId, rawName, affiliation, candidateType, categoryId, deedsSummary, contributionNote },
    actor
  ) {
    const state = this.state();
    this.#assertStarted(state);
    if (state.candidates[candidateId]) fail("CANDIDATE_EXISTS", `候选已提交：${candidateId}`);
    if (!state.nominators[nominatorId]) fail("NOMINATOR_NOT_FOUND", `推荐机构不存在：${nominatorId}`);
    if (!["person", "team"].includes(candidateType)) fail("BAD_CANDIDATE_TYPE", "候选身份只能是 person 或 team");
    if (!categoryOf(state, categoryId)) fail("CATEGORY_NOT_FOUND", `奖项类别不存在：${categoryId}`);
    // 注意：同一姓名/同一医生被不同条线重复提名是允许的——先收，再由秘书处人工归并
    this.#beforeDeadline(state.edition.rules.deadlines?.nomination, "NOMINATION_CLOSED", "提名截止时间已过");
    this.#append(
      "CANDIDATE_SUBMITTED",
      {
        candidateId,
        nominatorId,
        rawName,
        affiliation,
        candidateType,
        categoryId,
        deedsSummary: deedsSummary ?? "",
        contributionNote: contributionNote ?? "",
        at: this.#iso(),
      },
      actor ?? nominatorId
    );
  }

  withdrawCandidate({ candidateId, reason }, actor) {
    const state = this.state();
    this.#requireCandidate(state, candidateId);
    const openVotes = Object.values(state.rounds).some((r) => r.status === "voting_open");
    if (openVotes) fail("ROUND_IN_PROGRESS", "投票进行中不得撤回候选");
    this.#append("CANDIDATE_WITHDRAWN", { candidateId, reason: reason ?? "", at: this.#iso() }, actor);
  }

  // -- 人工身份归并 --------------------------------------------------------

  /**
   * 秘书处把同一真人的多个候选（个人技术/团队项目/社会服务等拆分提名）归入一簇。
   * 已属于其他簇的成员会被一并并入；每次操作均留痕（操作人、时间、说明）。
   */
  mergeIdentities({ clusterId, memberCandidateIds, canonicalCandidateId, note }, actor) {
    const state = this.state();
    if (!Array.isArray(memberCandidateIds) || memberCandidateIds.length < 2) {
      fail("MERGE_TOO_FEW", "归并至少需要两个候选");
    }
    const members = memberCandidateIds.map((id) => this.#requireCandidate(state, id));
    const types = new Set(members.map((m) => m.candidateType));
    if (types.size > 1) {
      fail("MERGE_TYPE_MISMATCH", "个人候选与团队候选不能按同一身份归并；共同成果请用共享成果申报", {
        types: [...types],
      });
    }
    const canonical = canonicalCandidateId ?? memberCandidateIds[0];
    if (!memberCandidateIds.includes(canonical)) fail("MERGE_BAD_CANONICAL", "规范候选必须在归并成员中");
    // 若成员已在其他簇，把旧簇整体并入，并记录合并来源
    const otherClusters = new Set(
      memberCandidateIds.map((id) => state.candidates[id].clusterId).filter((cid) => cid && cid !== clusterId)
    );
    let union = new Set(memberCandidateIds);
    for (const cid of otherClusters) {
      for (const id of state.clusters[cid].memberIds) union.add(id);
    }
    if (state.clusters[clusterId]) {
      for (const id of state.clusters[clusterId].memberIds) union.add(id);
    }
    this.#append(
      "IDENTITIES_MERGED",
      {
        clusterId,
        canonicalCandidateId: canonical,
        memberCandidateIds: [...union],
        absorbedClusters: [...otherClusters],
        note: note ?? "",
        at: this.#iso(),
      },
      actor
    );
  }

  unlinkIdentity({ clusterId, candidateId, reason }, actor) {
    const state = this.state();
    const cluster = state.clusters[clusterId];
    if (!cluster || !cluster.memberIds.includes(candidateId)) fail("CLUSTER_MEMBER_NOT_FOUND", "候选不在该身份簇中");
    this.#append("IDENTITY_UNLINKED", { clusterId, candidateId, reason: reason ?? "", at: this.#iso() }, actor);
  }

  // -- 本人公开授权 --------------------------------------------------------

  confirmConsent({ clusterId, candidateId, scope, allowedSections, contact }, actor) {
    const state = this.state();
    let cid = clusterId;
    if (!cid) {
      this.#requireCandidate(state, candidateId);
      const existing = clusterOfCandidate(state, candidateId);
      if (existing) fail("CONSENT_USE_CLUSTER", "该候选已归并，授权须以身份簇为单位确认", { clusterId: existing.id });
      cid = `solo:${candidateId}`;
    } else if (!state.clusters[cid]) {
      fail("CLUSTER_NOT_FOUND", `身份簇不存在：${cid}`);
    }
    const normalized = normalizeConsent(scope, allowedSections);
    this.#append(
      "CONSENT_CONFIRMED",
      { clusterId: cid, scope, allowedSections: normalized, contact: contact ?? null, at: this.#iso() },
      actor
    );
  }

  // -- 证明材料 ------------------------------------------------------------

  submitEvidence({ evidenceId, candidateId, kind, source, title, contentHash, kindTag }, actor) {
    const state = this.state();
    this.#requireCandidate(state, candidateId);
    if (state.evidences[evidenceId]) fail("EVIDENCE_EXISTS", `证明材料已存在：${evidenceId}`);
    const tag = kindTag ?? "initial";
    if (!["initial", "supplement"].includes(tag)) fail("BAD_EVIDENCE_TAG", "材料标记只能是 initial 或 supplement");
    const deadlines = state.edition.rules.deadlines ?? {};
    if (tag === "initial") {
      this.#beforeDeadline(deadlines.nomination, "NOMINATION_CLOSED", "提名（含初始证明）截止时间已过");
    } else {
      this.#beforeDeadline(deadlines.supplements ?? deadlines.nomination, "SUPPLEMENT_CLOSED", "补充材料截止时间已过");
    }
    if (!contentHash) fail("EVIDENCE_NO_HASH", "证明材料必须提交内容哈希");
    this.#append(
      "EVIDENCE_SUBMITTED",
      { evidenceId, candidateId, kind, source, title, contentHash, kindTag: tag, at: this.#iso() },
      actor
    );
  }

  /**
   * 更正材料：原哈希永久保留在 corrections 链上，须填写处理理由；
   * 异议期内的更正必须出示书面批准（禁止暗改）。
   */
  correctEvidence({ evidenceId, newContentHash, reason, approvalId }, actor) {
    const state = this.state();
    const evidence = this.#requireEvidence(state, evidenceId);
    if (!reason || !reason.trim()) fail("CORRECTION_NO_REASON", "更正必须填写处理理由");
    if (!newContentHash) fail("EVIDENCE_NO_HASH", "更正材料必须提交新内容哈希");
    if (newContentHash === evidence.currentHash) fail("CORRECTION_NO_CHANGE", "新哈希与当前版本相同");
    if (state.objection && !state.objection.closedAt) {
      this.#requireApproval(state, approvalId, "evidence_correction", evidenceId);
    }
    this.#append(
      "EVIDENCE_CORRECTED",
      { evidenceId, newContentHash, reason, approvalId: approvalId ?? null, at: this.#iso() },
      actor
    );
  }

  grantApproval({ approvalId, action, targetId, reason }, actor) {
    const state = this.state();
    if (state.approvals[approvalId]) fail("APPROVAL_EXISTS", "批准记录已存在");
    this.#append("APPROVAL_GRANTED", { approvalId, action, targetId, reason: reason ?? "" }, actor);
  }

  // -- 个人/团队共同成果 ---------------------------------------------------

  declareSharedWork({ workId, title, candidateIds, contributions }, actor) {
    const state = this.state();
    this.#assertStarted(state);
    if (state.sharedWorks[workId]) fail("SHARED_WORK_EXISTS", `共同成果已存在：${workId}`);
    if (!Array.isArray(candidateIds) || candidateIds.length < 2) fail("SHARED_WORK_TOO_FEW", "共同成果至少涉及两个候选");
    for (const id of candidateIds) this.#requireCandidate(state, id);
    const contrib = {};
    for (const id of candidateIds) {
      contrib[id] = contributions?.[id] ?? ""; // 各方可分别说明贡献
    }
    this.#append("SHARED_WORK_DECLARED", { workId, title, candidateIds: candidateIds.slice(), contributions: contrib }, actor);
  }

  /** 共同成果只能计入一个候选的成绩；其余候选保留各自贡献说明。 */
  allocateSharedWork({ workId, countedForCandidateId, note }, actor) {
    const state = this.state();
    const work = state.sharedWorks[workId];
    if (!work) fail("SHARED_WORK_NOT_FOUND", `共同成果不存在：${workId}`);
    if (!work.candidateIds.includes(countedForCandidateId)) fail("SHARED_WORK_BAD_TARGET", "计入对象必须是成果参与方");
    if (work.countedFor && work.countedFor !== countedForCandidateId) {
      fail("SHARED_WORK_REALLOCATED", "共同成果已计入其他候选，不得重复计入", { countedFor: work.countedFor });
    }
    this.#append("SHARED_WORK_ALLOCATED", { workId, countedForCandidateId, note: note ?? "", at: this.#iso() }, actor);
  }

  // -- 评委与利益冲突声明 --------------------------------------------------

  registerJudge({ judgeId, name, organization }, actor) {
    const state = this.state();
    if (state.judges[judgeId]) fail("JUDGE_EXISTS", `评委已存在：${judgeId}`);
    this.#append("JUDGE_REGISTERED", { judgeId, name, organization: organization ?? null }, actor);
  }

  assignJudge({ roundId, judgeId }, actor) {
    const state = this.state();
    this.#requireRules(state);
    if (!roundConfig(state, roundId)) fail("ROUND_NOT_DEFINED", `规则中不存在该轮次：${roundId}`);
    if (!state.judges[judgeId]) fail("JUDGE_NOT_FOUND", `评委不存在：${judgeId}`);
    if (state.assignments[roundId]?.[judgeId]) fail("JUDGE_ALREADY_ASSIGNED", "评委已在该轮次名单中");
    this.#append("JUDGE_ASSIGNED", { roundId, judgeId }, actor);
  }

  declareCOI({ declarationId, judgeId, targetType, targetId, scope, relation }, actor) {
    const state = this.state();
    if (!state.judges[judgeId]) fail("JUDGE_NOT_FOUND", `评委不存在：${judgeId}`);
    if (![COI.RECUSE, COI.RESTRICTED, COI.NONE].includes(scope)) fail("BAD_COI_SCOPE", "声明类型无效");
    if (!["candidate", "cluster", "nominator"].includes(targetType)) fail("BAD_COI_TARGET", "声明对象类型无效");
    if (targetType === "candidate") this.#requireCandidate(state, targetId);
    if (targetType === "cluster" && !state.clusters[targetId]) fail("CLUSTER_NOT_FOUND", `身份簇不存在：${targetId}`);
    if (targetType === "nominator" && !state.nominators[targetId]) fail("NOMINATOR_NOT_FOUND", `推荐机构不存在：${targetId}`);
    if (state.coiDeclarations[declarationId]) fail("COI_EXISTS", "声明已存在");
    this.#append(
      "COI_DECLARED",
      { declarationId, judgeId, targetType, targetId, scope, relation: relation ?? "", at: this.#iso() },
      actor ?? judgeId
    );
  }

  releaseCOI({ declarationId, reason }, actor) {
    const state = this.state();
    const d = state.coiDeclarations[declarationId];
    if (!d) fail("COI_NOT_FOUND", "利益冲突声明不存在");
    this.#append("COI_RELEASED", { declarationId, reason: reason ?? "", at: this.#iso() }, actor);
  }

  // -- 阶段推进：事实核验 → 专业评议 → 社会责任审议 -------------------------

  openStage(arg, actor) {
    const stage = typeof arg === "string" ? arg : arg.stage;
    const state = this.state();
    this.#assertStarted(state);
    if (!STAGES.includes(stage)) fail("BAD_STAGE", `未知阶段：${stage}`);
    const idx = STAGES.indexOf(stage);
    for (let i = 0; i < idx; i++) {
      if (state.stageState[STAGES[i]]?.status !== "completed") {
        fail("STAGE_ORDER", `必须先完成前置阶段：${STAGES[i]}`);
      }
    }
    if (state.stageState[stage]?.status === "completed") fail("STAGE_DONE", `阶段已完成：${stage}`);
    if (state.stageState[stage]?.status === "open") return;
    this.#append("STAGE_OPENED", { stage, at: this.#iso() }, actor);
  }

  recordStageVerdict({ stage, candidateId, verdict, note }, actor) {
    const state = this.state();
    if (state.stageState[stage]?.status !== "open") fail("STAGE_NOT_OPEN", `阶段未开放：${stage}`);
    this.#requireCandidate(state, candidateId);
    if (!["pass", "fail", "needs_info"].includes(verdict)) fail("BAD_VERDICT", "阶段结论无效");
    this.#append("CANDIDATE_STAGE_VERDICT", { stage, candidateId, verdict, note: note ?? "" }, actor);
  }

  completeStage(arg, actor) {
    const stage = typeof arg === "string" ? arg : arg.stage;
    const state = this.state();
    if (state.stageState[stage]?.status !== "open") fail("STAGE_NOT_OPEN", `阶段未开放：${stage}`);
    this.#append("STAGE_COMPLETED", { stage, at: this.#iso() }, actor);
  }

  disqualifyCandidate({ candidateId, reason, approvalId, effectiveFromRoundId }, actor) {
    const state = this.state();
    this.#requireCandidate(state, candidateId);
    const rules = this.#requireRules(state);
    if (!rules.rounds.some((r) => r.id === effectiveFromRoundId)) fail("ROUND_NOT_DEFINED", "生效轮次不存在");
    this.#requireApproval(state, approvalId, "disqualification", candidateId);
    this.#append(
      "CANDIDATE_DISQUALIFIED",
      { candidateId, reason, approvalId, effectiveFromRoundId, at: this.#iso() },
      actor
    );
  }

  // -- 轮次与选票 ----------------------------------------------------------

  openRound(arg, actor) {
    const roundId = typeof arg === "string" ? arg : arg.roundId;
    const state = this.state();
    this.#assertStarted(state);
    const rules = this.#requireRules(state);
    const order = rules.rounds.findIndex((r) => r.id === roundId);
    if (order < 0) fail("ROUND_NOT_DEFINED", `规则中不存在该轮次：${roundId}`);
    if (state.rounds[roundId]?.status === "voting_open") return;
    const round = rules.rounds[order];
    // 前序轮次必须已计票（先于阶段检查，给出最直接的拒绝理由）
    for (let i = 0; i < order; i++) {
      if (state.rounds[rules.rounds[i].id]?.status !== "counted") {
        fail("ROUND_ORDER", `前序轮次尚未完成计票：${rules.rounds[i].id}`);
      }
    }
    // 所属阶段必须已经启动
    if (state.stageState[round.stage]?.status !== "open") {
      fail("STAGE_NOT_OPEN", `须先开放阶段：${round.stage}`);
    }
    this.#append("ROUND_OPENED", { roundId, at: this.#iso() }, actor);
  }

  static cellId(roundId, judgeId, candidateId) {
    return `${roundId}|${judgeId}|${candidateId}`;
  }

  castBallot({ roundId, judgeId, candidateId, verdict, score, comment }, actor) {
    const state = this.state();
    const round = state.rounds[roundId];
    if (!round || round.status !== "voting_open") fail("ROUND_NOT_OPEN", "该轮次未在投票中，选票不予受理");
    if (!state.assignments[roundId]?.[judgeId]) fail("JUDGE_NOT_ASSIGNED", "评委不在本轮名单中");
    if (!candidatesInRound(state, roundId).some((c) => c.id === candidateId)) {
      fail("CANDIDATE_NOT_ELIGIBLE", "候选不在本轮参评范围（类别不符/已撤回/已取消资格）");
    }
    const access = accessLevelOf(state, judgeId, candidateId);
    if (access === null) fail("COI_UNDECLARED", "评委尚未提交利益冲突声明，不得查看或评分该候选");
    if (access === COI.RECUSE) fail("COI_RECUSED", "评委已回避该候选，不得查看或评分");
    if (access === COI.RESTRICTED) fail("COI_RESTRICTED", "评委对该候选仅有受限查看权，不得评分");

    if (verdict === "abstain") {
      if (score !== undefined && score !== null) fail("ABSTAIN_WITH_SCORE", "弃权票不得携带分数");
    } else if (verdict === "score") {
      const range = state.edition.rules.scoreRange ?? { min: 0, max: 100 };
      if (typeof score !== "number" || Number.isNaN(score) || score < range.min || score > range.max) {
        fail("BAD_SCORE", `分数必须在 ${range.min}–${range.max} 之间`, { range });
      }
    } else {
      fail("BAD_BALLOT_VERDICT", "选票只能是 score 或 abstain");
    }

    // 同一格位重复投票只追加新版本，历史永不覆盖
    const cellId = SelectionService.cellId(roundId, judgeId, candidateId);
    this.#append(
      "BALLOT_CAST",
      { cellId, roundId, judgeId, candidateId, verdict, score: score ?? null, comment: comment ?? "", at: this.#iso() },
      actor ?? judgeId
    );
  }

  closeRound(arg, actor) {
    const roundId = typeof arg === "string" ? arg : arg.roundId;
    const state = this.state();
    if (state.rounds[roundId]?.status !== "voting_open") fail("ROUND_NOT_OPEN", "该轮次未在投票中");
    this.#append("ROUND_CLOSED", { roundId, at: this.#iso() }, actor);
  }

  /**
   * 计票：
   * - 回避/受限评委整体排除（不计入分母，更不会折算低分）；
   * - 弃权票单独计数，同样不进分母；
   * - 仅对有效打分求均值；并列严格标出，须经并列处置后才能进入获奖/公示。
   */
  countRound(arg, actor) {
    const roundId = typeof arg === "string" ? arg : arg.roundId;
    const state = this.state();
    const round = state.rounds[roundId];
    if (!round) fail("ROUND_NOT_FOUND", "轮次不存在");
    if (round.status === "counted") fail("ROUND_ALREADY_COUNTED", "该轮次已计票并封存");
    if (round.status !== "closed") fail("ROUND_NOT_CLOSED", "计票前必须先关闭投票");
    const rules = this.#requireRules(state);
    const judges = assignedJudges(state, roundId);
    const candidates = candidatesInRound(state, roundId);

    const perCandidate = [];
    const outstanding = [];
    const undeclared = [];
    for (const candidate of candidates) {
      const scored = [];
      let abstainCount = 0;
      const exclusions = [];
      for (const judgeId of judges) {
        const access = accessLevelOf(state, judgeId, candidate.id);
        if (access === null) {
          undeclared.push({ judgeId, candidateId: candidate.id });
          continue;
        }
        if (access === COI.RECUSE || access === COI.RESTRICTED) {
          exclusions.push({ judgeId, reason: access });
          continue;
        }
        const cell = state.ballots[SelectionService.cellId(roundId, judgeId, candidate.id)];
        const v = cell?.current;
        if (!v) {
          outstanding.push({ judgeId, candidateId: candidate.id });
          continue;
        }
        if (v.verdict === "abstain") abstainCount += 1;
        else scored.push({ judgeId, score: v.score });
      }
      const totalScore = scored.reduce((s, x) => s + x.score, 0);
      const average = scored.length ? totalScore / scored.length : null;
      perCandidate.push({
        candidateId: candidate.id,
        categoryId: candidate.categoryId,
        totalScore,
        scoredCount: scored.length,
        abstainCount,
        excludedCount: exclusions.length,
        exclusions,
        average,
      });
    }

    if (undeclared.length > 0) {
      fail("COI_UNDECLARED_AT_COUNT", "有评委尚未对相关候选提交利益冲突声明，计票前必须补齐声明或退出", {
        undeclared,
      });
    }
    if (outstanding.length > 0) {
      fail("ROUND_INCOMPLETE", "仍有评委（无回避且未声明弃权）未投票，不能计票", { outstanding });
    }

    // 名次与并列在类别内部判定（1,2,2,4），并列用平均原始值严格比较
    const rowsByCategory = new Map();
    for (const row of perCandidate) {
      if (!rowsByCategory.has(row.categoryId)) rowsByCategory.set(row.categoryId, []);
      rowsByCategory.get(row.categoryId).push(row);
    }
    for (const rows of rowsByCategory.values()) {
      const sorted = rows.slice().sort((a, b) => (b.average ?? -1) - (a.average ?? -1));
      let lastAvg = null;
      let lastRank = 0;
      sorted.forEach((row, idx) => {
        if (lastAvg !== null && row.average === lastAvg) row.rank = lastRank;
        else {
          row.rank = idx + 1;
          lastRank = row.rank;
        }
        lastAvg = row.average;
      });
      for (const row of rows) {
        row.tiedWith = rows
          .filter((other) => other !== row && other.rank === row.rank && row.average !== null)
          .map((other) => other.candidateId);
      }
    }
    const byId = Object.fromEntries(perCandidate.map((r) => [r.candidateId, r]));
    const ties = perCandidate.filter((r) => r.tiedWith.length > 0).map((r) => r.candidateId);
    const digest = ballotDigest(state, roundId);

    this.#append(
      "ROUND_COUNTED",
      {
        roundId,
        rulesVersion: rules.version,
        quotaSnapshot: quotaSnapshot(rules),
        perCandidate,
        ties,
        outstanding: [],
        ballotDigest: digest,
        at: this.#iso(),
      },
      actor
    );
    return { perCandidate: byId, ties, ballotDigest: digest };
  }

  /** 并列处置：对实际并列的候选组给出正式次序（理事会表决/抽签等），全程留痕。 */
  resolveTie({ roundId, tiedGroupCandidateIds, orderedCandidateIds, method, reason }, actor) {
    const state = this.state();
    const result = state.results[roundId];
    if (!result) fail("ROUND_NOT_COUNTED", "轮次尚未计票");
    const group = new Set(tiedGroupCandidateIds);
    const rows = result.perCandidate.filter((r) => group.has(r.candidateId));
    if (rows.length !== group.size) fail("TIE_BAD_GROUP", "并列组成员与计票结果不符");
    const rank = rows[0].rank;
    if (!rows.every((r) => r.rank === rank)) fail("TIE_NOT_TIED", "给出的候选当前并非并列");
    if (orderedCandidateIds.length !== group.size || !orderedCandidateIds.every((id) => group.has(id))) {
      fail("TIE_BAD_ORDER", "处置次序必须恰好包含并列组全部成员");
    }
    if (new Set(orderedCandidateIds).size !== group.size) {
      fail("TIE_BAD_ORDER", "处置次序不得重复成员，必须是并列组的一个排列");
    }
    const prior = state.tieResolutions[roundId] ?? [];
    if (prior.some((r) => r.tiedGroupCandidateIds.every((id) => group.has(id)) && r.tiedGroupCandidateIds.length === group.size)) {
      fail("TIE_ALREADY_RESOLVED", "该并列组已经过正式处置，不得更改");
    }
    this.#append(
      "TIE_RESOLVED",
      { roundId, tiedGroupCandidateIds: [...group], orderedCandidateIds, method: method ?? "council_vote", reason: reason ?? "", at: this.#iso() },
      actor
    );
  }

  /** 应用类别名额与并列处置，给出获奖建议；名次线并列未处置时报错。 */
  awardeesOf(arg) {
    const roundId = typeof arg === "string" ? arg : arg.roundId;
    const state = this.state();
    const result = state.results[roundId];
    if (!result) fail("ROUND_NOT_COUNTED", "轮次尚未计票");
    const resolutions = state.tieResolutions[roundId] ?? [];
    const resolvedGroups = resolutions.map((r) => new Set(r.orderedCandidateIds));
    const orderWithin = new Map();
    for (const r of resolutions) r.orderedCandidateIds.forEach((id, i) => orderWithin.set(id, i));

    const byCategory = new Map();
    for (const row of result.perCandidate) {
      if (row.average === null) continue; // 全部弃权/回避，无人得分
      if (!byCategory.has(row.categoryId)) byCategory.set(row.categoryId, []);
      byCategory.get(row.categoryId).push(row);
    }
    const awardees = [];
    const unresolvedTies = [];
    for (const [categoryId, rows] of byCategory) {
      const quota = categoryOf(state, categoryId)?.quota ?? 0;
      // 按相同平均分组成并列组，自高到低推进名次
      const groups = [];
      const groupByAvg = new Map();
      for (const row of rows) {
        let g = groupByAvg.get(row.average);
        if (!g) {
          g = { average: row.average, rows: [] };
          groupByAvg.set(row.average, g);
          groups.push(g);
        }
        g.rows.push(row);
      }
      groups.sort((a, b) => b.average - a.average);

      let position = 0;
      for (const g of groups) {
        const start = position;
        const end = start + g.rows.length;
        const straddlesCutoff = g.rows.length > 1 && start < quota && end > quota;
        if (straddlesCutoff) {
          const resolved = resolvedGroups.some(
            (s) => s.size === g.rows.length && g.rows.every((r) => s.has(r.candidateId))
          );
          if (!resolved) {
            unresolvedTies.push({
              categoryId,
              cutoffRank: quota,
              members: g.rows.map((r) => r.candidateId),
            });
          } else {
            g.rows.sort((a, b) => orderWithin.get(a.candidateId) - orderWithin.get(b.candidateId));
          }
        }
        g.rows.forEach((row, i) => {
          if (start + i < quota) {
            awardees.push({ candidateId: row.candidateId, categoryId, rank: start + i + 1, average: row.average });
          }
        });
        position = end;
      }
    }
    if (unresolvedTies.length > 0) {
      fail("TIE_UNRESOLVED", "名次线存在未处置的并列，不能确定获奖名单", { unresolvedTies });
    }
    return awardees;
  }

  // -- 异议期 --------------------------------------------------------------

  openObjectionPeriod({ deadline }, actor) {
    const state = this.state();
    if (state.objection && !state.objection.closedAt) fail("OBJECTION_OPEN", "异议期已在进行中");
    if (!deadline || new Date(deadline).getTime() <= this.#now().getTime()) {
      fail("BAD_DEADLINE", "异议期截止时间必须晚于当前时间");
    }
    this.#append("OBJECTION_PERIOD_OPENED", { at: this.#iso(), deadline }, actor);
  }

  requestEvidenceReview({ candidateId, scope }, actor) {
    const state = this.state();
    this.#requireCandidate(state, candidateId);
    if (!state.objection || state.objection.closedAt) fail("OBJECTION_NOT_OPEN", "异议期未开放");
    if (this.#now().getTime() > new Date(state.objection.deadline).getTime()) {
      fail("OBJECTION_CLOSED", "异议期已截止", { deadline: state.objection.deadline });
    }
    this.#append("EVIDENCE_REVIEW_OPENED", { candidateId, scope: scope ?? "all" }, actor);
  }

  closeEvidenceReview({ candidateId, conclusion }, actor) {
    const state = this.state();
    if (!state.objection) fail("OBJECTION_NOT_OPEN", "异议期未开放");
    this.#append("EVIDENCE_REVIEW_CLOSED", { candidateId, conclusion: conclusion ?? "", at: this.#iso() }, actor);
  }

  closeObjectionPeriod(actor) {
    const state = this.state();
    if (!state.objection || state.objection.closedAt) fail("OBJECTION_NOT_OPEN", "异议期未开放或已关闭");
    this.#append("OBJECTION_PERIOD_CLOSED", { at: this.#iso() }, actor);
  }

  /** 重算选票摘要并与计票时封存的摘要比对（哈希链 + 摘要双保险证明未暗改选票）。 */
  verifyBallotsIntact(arg) {
    const roundId = typeof arg === "string" ? arg : arg.roundId;
    const state = this.state();
    const result = state.results[roundId];
    if (!result) fail("ROUND_NOT_COUNTED", "轮次尚未计票");
    const recomputed = ballotDigest(state, roundId);
    if (recomputed !== result.ballotDigest) {
      fail("BALLOT_TAMPERED", "选票摘要与计票封存时不一致，选票可能被篡改", {
        sealed: result.ballotDigest,
        recomputed,
      });
    }
    return { intact: true, sealed: result.ballotDigest, recomputed };
  }

  // -- 公示与勘误 ----------------------------------------------------------

  publishRound(arg, actor) {
    const roundId = typeof arg === "string" ? arg : arg.roundId;
    const state = this.state();
    if (!state.results[roundId]) fail("ROUND_NOT_COUNTED", "轮次尚未计票，不能公示");
    let awardees;
    try {
      awardees = this.awardeesOf(roundId);
    } catch (e) {
      if (e.code === "TIE_UNRESOLVED") throw e;
      throw e;
    }
    const published = [];
    const skipped = [];
    for (const a of awardees) {
      const view = publicViewOfCandidate(state, a.candidateId);
      if (!view?.visible) {
        skipped.push({ candidateId: a.candidateId, reason: view?.reason ?? "未获准公开" });
        continue;
      }
      const publicationId = `pub-${roundId}-${a.candidateId}`;
      if (state.publications[publicationId]) continue; // 幂等：已公示不重复
      const snapshot = buildPublicationSnapshot(state, a, view);
      this.#append("PUBLICATION_PUBLISHED", { publicationId, candidateId: a.candidateId, roundId, snapshot, at: this.#iso() }, actor);
      published.push(publicationId);
    }
    return { published, skipped };
  }

  /** 公示勘误：留存前后快照与批准，公众可清楚看到改了什么、谁批准。 */
  correctPublication({ publicationId, changes, reason, approvalId }, actor) {
    const state = this.state();
    const pub = state.publications[publicationId];
    if (!pub) fail("PUBLICATION_NOT_FOUND", `公示不存在：${publicationId}`);
    if (!reason || !reason.trim()) fail("CORRECTION_NO_REASON", "勘误必须说明理由");
    this.#requireApproval(state, approvalId, "publication_correction", publicationId);
    const beforeSnapshot = pub.snapshot;
    const afterSnapshot = { ...beforeSnapshot, ...changes, correctedFrom: beforeSnapshot.version };
    afterSnapshot.version = beforeSnapshot.version + 1;
    this.#append(
      "PUBLICATION_CORRECTED",
      { publicationId, beforeSnapshot, afterSnapshot, reason, approvalId, at: this.#iso() },
      actor
    );
  }

  retractPublication({ publicationId, reason, approvalId }, actor) {
    const state = this.state();
    if (!state.publications[publicationId]) fail("PUBLICATION_NOT_FOUND", `公示不存在：${publicationId}`);
    this.#requireApproval(state, approvalId, "publication_retraction", publicationId);
    this.#append("PUBLICATION_RETRACTED", { publicationId, reason, approvalId, at: this.#iso() }, actor);
  }

  publicationDiff(publicationId) {
    const state = this.state();
    const pub = state.publications[publicationId];
    if (!pub) fail("PUBLICATION_NOT_FOUND", `公示不存在：${publicationId}`);
    return {
      publicationId,
      status: pub.status,
      current: pub.snapshot,
      corrections: pub.corrections.map((c) => ({
        changedAt: c.at,
        approvedBy: state.approvals[c.approvalId]?.by ?? c.by,
        approvalId: c.approvalId,
        reason: c.reason,
        before: c.before,
        after: c.after,
        diff: shallowDiff(c.before, c.after),
      })),
    };
  }

  // -- 评委视图（按声明权限过滤） ------------------------------------------

  judgeViewForCandidate(judgeId, candidateId) {
    const state = this.state();
    const candidate = this.#requireCandidate(state, candidateId);
    const access = accessLevelOf(state, judgeId, candidateId);
    if (access === null) return { access: null, visible: false, reason: "尚未提交利益冲突声明" };
    if (access === COI.RECUSE) return { access, visible: false, reason: "已回避" };
    const base = {
      candidateId,
      categoryId: candidate.categoryId,
      deedsSummary: candidate.deedsSummary,
      contributionNote: candidate.contributionNote,
    };
    if (access === COI.RESTRICTED) {
      // 仅可查看脱敏材料：隐去身份与推荐来源
      return { access, visible: true, redacted: true, candidate: { ...base, rawName: "【脱敏】", affiliation: null, nominatorId: null } };
    }
    return {
      access,
      visible: true,
      redacted: false,
      candidate: { ...base, rawName: candidate.rawName, affiliation: candidate.affiliation, nominatorId: candidate.nominatorId },
      evidences: candidate.evidenceIds.map((id) => state.evidences[id]),
      sharedWorks: candidate.sharedWorkIds.map((id) => state.sharedWorks[id]),
    };
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function normalizeRules(rules) {
  if (!rules || typeof rules !== "object") fail("BAD_RULES", "规则为空或格式错误");
  const categories = rules.categories ?? [];
  const rounds = rules.rounds ?? [];
  // 草案阶段允许类别/轮次尚未齐备；openEdition 会做完整性把关
  for (const c of categories) {
    if (!c.id || !c.name) fail("BAD_RULES", "类别缺少 id 或 name");
    if (!Number.isInteger(c.quota) || c.quota < 0) fail("BAD_RULES", `类别名额无效：${c.id}`);
  }
  for (const r of rounds) {
    if (!r.id || !STAGES.includes(r.stage)) fail("BAD_RULES", `轮次 ${r?.id} 缺少 id 或合法阶段`);
  }
  return {
    categories: categories.map((c) => ({ id: c.id, name: c.name, quota: c.quota })),
    rounds: rounds.map((r) => ({
      id: r.id,
      name: r.name ?? r.id,
      stage: r.stage,
      eligibleCategories: r.eligibleCategories ?? categories.map((c) => c.id),
    })),
    scoreRange: rules.scoreRange ?? { min: 0, max: 100 },
    deadlines: rules.deadlines ?? {},
  };
}

function normalizeConsent(scope, allowedSections) {
  if (!["full", "deeds_only", "custom"].includes(scope)) fail("BAD_CONSENT_SCOPE", "公开范围类型无效");
  let sections;
  if (scope === "full") sections = Object.fromEntries(SECTION_KEYS.map((k) => [k, true]));
  else if (scope === "deeds_only") sections = { identity: false, category: true, deeds: true, evidenceSources: true };
  else sections = allowedSections ?? {};
  for (const key of SECTION_KEYS) {
    if (typeof sections[key] !== "boolean") fail("BAD_CONSENT_SECTIONS", `公开范围缺少布尔字段：${key}`);
  }
  return sections;
}

function quotaSnapshot(rules) {
  return Object.fromEntries(rules.categories.map((c) => [c.id, c.quota]));
}

function buildPublicationSnapshot(state, award, view) {
  return {
    version: 1,
    candidateId: award.candidateId,
    categoryId: award.categoryId,
    rank: award.rank,
    average: Number(award.average.toFixed(4)),
    publishedFrom: view.sections,
  };
}

function shallowDiff(before, after) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const out = {};
  for (const k of keys) {
    const b = before?.[k];
    const a = after?.[k];
    if (JSON.stringify(b) !== JSON.stringify(a)) out[k] = { before: b, after: a };
  }
  return out;
}
