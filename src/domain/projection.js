import { hashValue } from "./crypto.js";

/**
 * 遴选状态投影：把追加写事件折叠成当前（或任一历史时刻的）状态。
 * 投影本身不做任何规则判断——所有“能不能做”的规则在服务层；
 * 这里只回答“发生过什么、现在是什么样”。
 */

export const STAGES = ["fact_check", "professional_review", "social_responsibility_review"];

export const COI = {
  RECUSE: "recuse", // 回避：不可查看、不可评分
  RESTRICTED: "restricted", // 限制：仅可查看脱敏材料，不可评分
  NONE: "none", // 已声明无利益冲突：完整查看与评分
};

const WORSE_SCOPE = { [COI.RECUS]: 3, [COI.RESTRICTED]: 2, [COI.NONE]: 1 };

export function createInitialState() {
  return {
    edition: {
      id: null,
      name: null,
      status: "draft", // draft | in_progress | closed
      rules: null,
      frozenAt: null,
      frozenBy: null,
      ruleVersions: [],
    },
    nominators: {},
    candidates: {},
    clusters: {},
    consents: {}, // 以身份簇为单位的公开授权
    evidences: {},
    sharedWorks: {},
    judges: {},
    assignments: {}, // roundId -> { judgeId: true }
    coiDeclarations: {},
    stageState: {}, // stage -> { status, openedAt, completedAt }
    stageVerdicts: {}, // `${stage}|${candidateId}` -> { verdict, by, at, note }
    rounds: {},
    ballots: {}, // cellId -> { current, history: [] }
    results: {}, // roundId -> 计票事件负载
    tieResolutions: {}, // roundId -> 决议事件负载
    publications: {},
    approvals: {},
    objection: null, // { startedAt, deadline, reviews: [] }
    withdrawals: {},
  };
}

function asMapRecord(obj, id, init) {
  if (!obj[id]) obj[id] = init();
  return obj[id];
}

export function reduce(state, event) {
  const p = event.payload;
  switch (event.type) {
    case "EDITION_OPENED":
      state.edition.id = p.editionId;
      state.edition.name = p.name;
      state.edition.status = "in_progress";
      break;

    case "RULES_DEFINED": {
      if (state.edition.rules) {
        state.edition.ruleVersions.push({ ...state.edition.rules });
      }
      state.edition.rules = { version: p.version, ...p.rules };
      break;
    }

    case "RULES_FROZEN":
      state.edition.frozenAt = p.at;
      state.edition.frozenBy = event.actor;
      break;

    case "EDITION_CLOSED":
      state.edition.status = "closed";
      break;

    case "NOMINATOR_REGISTERED":
      state.nominators[p.nominatorId] = { id: p.nominatorId, name: p.name, type: p.type };
      break;

    case "CANDIDATE_SUBMITTED":
      state.candidates[p.candidateId] = {
        id: p.candidateId,
        nominatorId: p.nominatorId,
        rawName: p.rawName,
        affiliation: p.affiliation ?? null,
        candidateType: p.candidateType, // person | team
        categoryId: p.categoryId,
        deedsSummary: p.deedsSummary ?? "",
        contributionNote: p.contributionNote ?? "",
        evidenceIds: [],
        sharedWorkIds: [],
        clusterId: null,
        status: "submitted",
        submittedAt: p.at,
        disqualified: null,
      };
      break;

    case "CANDIDATE_WITHDRAWN": {
      const c = state.candidates[p.candidateId];
      if (c) c.status = "withdrawn";
      state.withdrawals[p.candidateId] = { reason: p.reason, at: p.at };
      break;
    }

    case "IDENTITIES_MERGED": {
      const cluster = asMapRecord(state.clusters, p.clusterId, () => ({
        id: p.clusterId,
        canonicalCandidateId: p.canonicalCandidateId,
        memberIds: [],
        log: [],
      }));
      cluster.canonicalCandidateId = p.canonicalCandidateId;
      for (const id of p.memberCandidateIds) {
        if (!cluster.memberIds.includes(id)) cluster.memberIds.push(id);
        const c = state.candidates[id];
        if (c) c.clusterId = p.clusterId;
      }
      cluster.log.push({ action: "merge", members: p.memberCandidateIds.slice(), note: p.note, by: event.actor, at: p.at });
      break;
    }

    case "IDENTITY_UNLINKED": {
      const cluster = state.clusters[p.clusterId];
      if (cluster) {
        cluster.memberIds = cluster.memberIds.filter((id) => id !== p.candidateId);
        cluster.log.push({ action: "unlink", candidateId: p.candidateId, reason: p.reason, by: event.actor, at: p.at });
      }
      const c = state.candidates[p.candidateId];
      if (c && c.clusterId === p.clusterId) c.clusterId = null;
      break;
    }

    case "CONSENT_CONFIRMED": {
      // 授权以身份簇为单位：同一位医生被拆成多个候选时，一次确认覆盖全簇
      state.consents[p.clusterId] = {
        clusterId: p.clusterId,
        scope: p.scope, // full | deeds_only | custom
        allowedSections: p.allowedSections, // { identity, category, deeds, evidenceSources }
        contact: p.contact ?? null,
        confirmedAt: p.at,
      };
      break;
    }

    case "EVIDENCE_SUBMITTED": {
      state.evidences[p.evidenceId] = {
        id: p.evidenceId,
        candidateId: p.candidateId,
        kind: p.kind,
        source: p.source,
        title: p.title,
        originalHash: p.contentHash,
        currentHash: p.contentHash,
        version: 1,
        kind_tag: p.kindTag ?? "initial", // initial | supplement
        submittedAt: p.at,
        corrections: [],
      };
      const c = state.candidates[p.candidateId];
      if (c) c.evidenceIds.push(p.evidenceId);
      break;
    }

    case "EVIDENCE_CORRECTED": {
      const e = state.evidences[p.evidenceId];
      if (!e) break;
      e.corrections.push({
        version: e.version + 1,
        fromHash: e.currentHash,
        newHash: p.newContentHash,
        reason: p.reason,
        approvalId: p.approvalId ?? null,
        by: event.actor,
        at: p.at,
      });
      e.currentHash = p.newContentHash;
      e.version += 1;
      break;
    }

    case "SHARED_WORK_DECLARED": {
      state.sharedWorks[p.workId] = {
        id: p.workId,
        title: p.title,
        candidateIds: p.candidateIds.slice(),
        contributions: { ...p.contributions },
        countedFor: null,
      };
      for (const id of p.candidateIds) {
        state.candidates[id]?.sharedWorkIds.push(p.workId);
      }
      break;
    }

    case "SHARED_WORK_ALLOCATED": {
      const w = state.sharedWorks[p.workId];
      if (w) {
        w.countedFor = p.countedForCandidateId;
        w.allocatedAt = p.at;
        w.note = p.note ?? "";
      }
      break;
    }

    case "JUDGE_REGISTERED":
      state.judges[p.judgeId] = { id: p.judgeId, name: p.name, organization: p.organization };
      break;

    case "JUDGE_ASSIGNED":
      asMapRecord(state.assignments, p.roundId, Object);
      state.assignments[p.roundId][p.judgeId] = true;
      break;

    case "COI_DECLARED":
      state.coiDeclarations[p.declarationId] = {
        id: p.declarationId,
        judgeId: p.judgeId,
        targetType: p.targetType, // candidate | cluster | nominator
        targetId: p.targetId,
        scope: p.scope,
        relation: p.relation ?? "",
        at: p.at,
        status: "active",
      };
      break;

    case "COI_RELEASED": {
      const d = state.coiDeclarations[p.declarationId];
      if (d) {
        d.status = "released";
        d.release = { by: event.actor, reason: p.reason, at: p.at };
      }
      break;
    }

    case "STAGE_OPENED":
      state.stageState[p.stage] = { status: "open", openedAt: p.at, completedAt: null };
      break;

    case "STAGE_COMPLETED":
      if (state.stageState[p.stage]) {
        state.stageState[p.stage].status = "completed";
        state.stageState[p.stage].completedAt = p.at;
      }
      break;

    case "CANDIDATE_STAGE_VERDICT":
      state.stageVerdicts[`${p.stage}|${p.candidateId}`] = {
        verdict: p.verdict,
        by: event.actor,
        at: p.at,
        note: p.note ?? "",
      };
      break;

    case "CANDIDATE_DISQUALIFIED": {
      const c = state.candidates[p.candidateId];
      if (c) {
        c.disqualified = { reason: p.reason, approvalId: p.approvalId, effectiveFromRoundId: p.effectiveFromRoundId, at: p.at };
      }
      break;
    }

    case "ROUND_OPENED":
      state.rounds[p.roundId] = {
        ...state.rounds[p.roundId],
        id: p.roundId,
        status: "voting_open",
        openedAt: p.at,
        closedAt: null,
        countedAt: null,
      };
      break;

    case "ROUND_CLOSED":
      if (state.rounds[p.roundId]) {
        state.rounds[p.roundId].status = "closed";
        state.rounds[p.roundId].closedAt = p.at;
      }
      break;

    case "BALLOT_CAST": {
      const cellId = p.cellId;
      const cell = asMapRecord(state.ballots, cellId, () => ({
        id: cellId,
        roundId: p.roundId,
        judgeId: p.judgeId,
        candidateId: p.candidateId,
        history: [],
        current: null,
      }));
      if (cell.current) cell.history.push(cell.current);
      cell.current = {
        verdict: p.verdict, // score | abstain
        score: p.score ?? null,
        comment: p.comment ?? "",
        at: p.at,
      };
      break;
    }

    case "ROUND_COUNTED":
      state.results[p.roundId] = p;
      if (state.rounds[p.roundId]) {
        state.rounds[p.roundId].status = "counted";
        state.rounds[p.roundId].countedAt = p.at;
        state.rounds[p.roundId].ballotDigest = p.ballotDigest;
      }
      break;

    case "TIE_RESOLVED":
      (state.tieResolutions[p.roundId] ??= []).push(p);
      break;

    case "APPROVAL_GRANTED":
      state.approvals[p.approvalId] = {
        id: p.approvalId,
        action: p.action,
        targetId: p.targetId,
        reason: p.reason,
        by: event.actor,
        at: p.at,
      };
      break;

    case "OBJECTION_PERIOD_OPENED":
      state.objection = { startedAt: p.at, deadline: p.deadline, reviews: [] };
      break;

    case "OBJECTION_PERIOD_CLOSED":
      if (state.objection) state.objection.closedAt = p.at;
      break;

    case "EVIDENCE_REVIEW_OPENED":
      state.objection?.reviews.push({
        candidateId: p.candidateId,
        requestedBy: event.actor,
        at: p.at,
        scope: p.scope,
        conclusion: null,
        closedAt: null,
      });
      break;

    case "EVIDENCE_REVIEW_CLOSED": {
      const review = [...(state.objection?.reviews ?? [])]
        .reverse()
        .find((r) => r.candidateId === p.candidateId && r.conclusion === null);
      if (review) {
        review.conclusion = p.conclusion;
        review.closedAt = p.at;
      }
      break;
    }

    case "PUBLICATION_PUBLISHED":
      state.publications[p.publicationId] = {
        id: p.publicationId,
        candidateId: p.candidateId,
        roundId: p.roundId,
        snapshot: p.snapshot,
        publishedAt: p.at,
        status: "published",
        corrections: [],
      };
      break;

    case "PUBLICATION_CORRECTED": {
      const pub = state.publications[p.publicationId];
      if (pub) {
        pub.corrections.push({
          before: p.beforeSnapshot,
          after: p.afterSnapshot,
          reason: p.reason,
          approvalId: p.approvalId,
          by: event.actor,
          at: p.at,
        });
        pub.snapshot = p.afterSnapshot;
        pub.status = "corrected";
      }
      break;
    }

    case "PUBLICATION_RETRACTED": {
      const pub = state.publications[p.publicationId];
      if (pub) {
        pub.status = "retracted";
        pub.retraction = { reason: p.reason, approvalId: p.approvalId, by: event.actor, at: p.at };
      }
      break;
    }

    default:
      // 未知事件类型不阻止投影（向前兼容），但不计入任何状态
      break;
  }
  return state;
}

// ---------------------------------------------------------------------------
// 查询选择器
// ---------------------------------------------------------------------------

export function rulesOf(state) {
  return state.edition.rules;
}

export function isFrozen(state) {
  return state.edition.frozenAt !== null;
}

export function categoryOf(state, categoryId) {
  return state.edition.rules?.categories.find((c) => c.id === categoryId) ?? null;
}

export function roundConfig(state, roundId) {
  return state.edition.rules?.rounds.find((r) => r.id === roundId) ?? null;
}

export function clusterOfCandidate(state, candidateId) {
  const cid = state.candidates[candidateId]?.clusterId;
  return cid ? state.clusters[cid] ?? null : null;
}

/** 候选对应的全部利益冲突声明（直连候选 / 身份簇 / 推荐单位） */
export function coiDeclarationsFor(state, judgeId, candidateId) {
  const candidate = state.candidates[candidateId];
  if (!candidate) return [];
  const clusterId = candidate.clusterId;
  return Object.values(state.coiDeclarations).filter(
    (d) =>
      d.judgeId === judgeId &&
      d.status === "active" &&
      ((d.targetType === "candidate" && d.targetId === candidateId) ||
        (d.targetType === "cluster" && clusterId && d.targetId === clusterId) ||
        (d.targetType === "nominator" && d.targetId === candidate.nominatorId))
  );
}

/**
 * 评委对某候选的有效权限级别。
 * 无任何声明 → null（尚未声明，默认无权，符合“声明决定权限”）。
 */
export function accessLevelOf(state, judgeId, candidateId) {
  const decs = coiDeclarationsFor(state, judgeId, candidateId);
  if (decs.length === 0) return null;
  return decs.map((d) => d.scope).reduce((a, b) => (WORSE_SCOPE[b] > WORSE_SCOPE[a] ? b : a));
}

export function assignedJudges(state, roundId) {
  return Object.keys(state.assignments[roundId] ?? {});
}

/** 某轮次中实际参选的候选（在轮次类别范围内、未撤回、未被取消资格）。 */
export function candidatesInRound(state, roundId) {
  const cfg = roundConfig(state, roundId);
  if (!cfg) return [];
  const roundOrder = (id) => state.edition.rules.rounds.findIndex((r) => r.id === id);
  const currentOrder = roundOrder(roundId);
  return Object.values(state.candidates).filter((c) => {
    if (c.status === "withdrawn") return false;
    if (c.disqualified && currentOrder >= roundOrder(c.disqualified.effectiveFromRoundId)) {
      return false; // 取消资格自指定轮次起生效（含其后所有轮次）
    }
    if (cfg.eligibleCategories && cfg.eligibleCategories.length > 0) {
      return cfg.eligibleCategories.includes(c.categoryId);
    }
    return true;
  });
}

/** 选票摘要哈希：计票时固化，异议期可重算比对，证明选票未被暗改。 */
export function ballotDigest(state, roundId) {
  const cells = Object.values(state.ballots)
    .filter((b) => b.roundId === roundId)
    .map((b) => ({
      judgeId: b.judgeId,
      candidateId: b.candidateId,
      verdict: b.current.verdict,
      score: b.current.score,
      castAt: b.current.at,
      revisions: b.history.length,
    }))
    .sort((a, b) => a.judgeId.localeCompare(b.judgeId) || a.candidateId.localeCompare(b.candidateId));
  return hashValue({ roundId, cells });
}

export function consentForCandidate(state, candidateId) {
  const cluster = clusterOfCandidate(state, candidateId);
  if (cluster) return state.consents[cluster.id] ?? null;
  // 未归并的候选以单候选簇处理：构造合成簇 id
  return state.consents[`solo:${candidateId}`] ?? null;
}

export function publicViewOfCandidate(state, candidateId) {
  const c = state.candidates[candidateId];
  if (!c) return null;
  const consent = consentForCandidate(state, candidateId);
  if (!consent) return { visible: false, reason: "候选本人尚未确认公开范围" };
  const allow = consent.allowedSections;
  const cat = categoryOf(state, c.categoryId);
  const view = { visible: true, sections: {} };

  if (allow.identity) {
    if (consent.scope === "deeds_only") {
      view.sections.identity = { name: "应本人要求隐去姓名", affiliation: "应本人要求隐去机构" };
    } else {
      view.sections.identity = { name: c.rawName, affiliation: c.affiliation };
    }
  } else if (consent.scope === "deeds_only") {
    // 隐名公开：身份段保留，但内容脱敏
    view.sections.identity = { name: "应本人要求隐去姓名", affiliation: "应本人要求隐去机构" };
  }
  if (allow.category) view.sections.category = { categoryId: c.categoryId, name: cat?.name ?? c.categoryId };
  if (allow.deeds) view.sections.deeds = c.deedsSummary;
  if (allow.evidenceSources) {
    view.sections.evidenceSources = c.evidenceIds
      .map((id) => state.evidences[id])
      .map((e) => ({ kind: e.kind, source: e.source, title: e.title, version: e.version }));
  }
  return view;
}
