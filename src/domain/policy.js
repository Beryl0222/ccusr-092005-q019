import { ConsentSection, Stage } from "./events.js";
import {
  canonicalCandidateId,
  getCandidate,
  identityGroupCandidateIds,
} from "./projection.js";

/* ---------------- 利益冲突与查看/评分权限 ---------------- */

/**
 * 冲突判定候选集合：同一自然人身份组 + 该自然人所属团队 + 团队全部成员。
 * 任何一个方向命中（候选/身份/推荐单位/机构/团队成员）都构成回避。
 */
export function conflictScopeCandidateIds(state, candidateId) {
  const seed = identityGroupCandidateIds(state, candidateId);
  const ids = new Set(seed);
  // 个人 → 其所属团队
  for (const id of seed) {
    for (const link of state.teamLinks) {
      if (
        identityGroupCandidateIds(state, link.personCandidateId).includes(id)
      ) {
        ids.add(canonicalCandidateId(state, link.teamCandidateId));
      }
    }
  }
  // 团队 → 其全部成员（成员再展开身份组）
  for (const id of [...ids]) {
    for (const link of state.teamLinks) {
      if (canonicalCandidateId(state, link.teamCandidateId) === id) {
        for (const member of identityGroupCandidateIds(state, link.personCandidateId)) {
          ids.add(member);
        }
      }
    }
  }
  return [...ids];
}

/**
 * 评委与候选是否存在已声明的利益冲突。命中任一维度即冲突：
 * 与身份组内任一候选、任一推荐单位、任一机构冲突。
 * 身份归并（含跨类别关联）不解除冲突——医生在一个类别回避，
 * 则在其所有候选资格上均回避；团队成员冲突传导到整个团队。
 */
export function hasConflict(state, reviewerId, candidateId) {
  const groupIds = conflictScopeCandidateIds(state, candidateId);
  const nominatorIds = new Set(
    groupIds.map((id) => getCandidate(state, id)?.nominatorId).filter(Boolean)
  );
  const organizations = new Set(
    groupIds.map((id) => getCandidate(state, id)?.profile?.organization).filter(Boolean)
  );
  return state.cois.some((coi) => {
    if (coi.reviewerId !== reviewerId || coi.withdrawn) return false;
    const scope = coi.scope ?? {};
    if (
      scope.candidateId &&
      groupIds.includes(canonicalCandidateId(state, scope.candidateId))
    ) {
      return true;
    }
    if (scope.personId) {
      const targetPerson = getCandidate(state, candidateId)?.personId;
      if (targetPerson && scope.personId === targetPerson) return true;
      // 团队成员的自然人身份命中同样回避团队
      if (
        groupIds.some((id) => getCandidate(state, id)?.personId === scope.personId)
      ) {
        return true;
      }
    }
    if (scope.nominatorId && nominatorIds.has(scope.nominatorId)) return true;
    if (scope.organization && organizations.has(scope.organization)) return true;
    return false;
  });
}

/**
 * 评委对候选的权限：
 * - CONFLICT：回避，既不能查看受限材料，也不能评分；
 * - ALLOWED：正常查看与评分。
 */
export function accessFor(state, reviewerId, candidateId) {
  return hasConflict(state, reviewerId, candidateId) ? "CONFLICT" : "ALLOWED";
}

/* ---------------- 计票：弃权/回避不得折算成低分 ---------------- */

/**
 * 汇总某一轮、某候选的有效评分。
 * 规则：
 *  - 已回避（hasConflict=true）评委即便存在票也一律剔除（服务端本就禁止其投票）；
 *  - 弃权票 value=null，不计入分母、不按 0 分处理；
 *  - 结果同时返回应评/实评人数，便于核验代表性。
 */
export function tallyCandidate(state, roundId, candidateId) {
  const canonicalId = canonicalCandidateId(state, candidateId);
  const rows = state.scores.filter(
    (s) => s.roundId === roundId && canonicalCandidateId(state, s.candidateId) === canonicalId
  );
  const counted = [];
  const abstained = [];
  // 回避名单以评委名册为准：被回避者根本拿不到评分权，无论是否曾尝试提交
  const recused = Object.keys(state.reviewers).filter((reviewerId) =>
    hasConflict(state, reviewerId, canonicalId)
  );
  for (const row of rows) {
    if (hasConflict(state, row.reviewerId, canonicalId)) {
      if (!recused.includes(row.reviewerId)) recused.push(row.reviewerId);
      continue;
    }
    if (row.abstain) {
      abstained.push(row.reviewerId);
      continue;
    }
    counted.push(row);
  }
  const sum = counted.reduce((acc, row) => acc + row.value, 0);
  const mean = counted.length ? sum / counted.length : null;
  return {
    candidateId: canonicalId,
    validVotes: counted.length,
    abstainedReviewers: abstained,
    recusedReviewers: recused,
    mean,
    // 弃权/回避绝不产生 0 值；无有效票时为 null 而不是 0
    rankValue: mean,
  };
}

/** 生成轮次排名；返回含并列标记的有序数组，并列不由计票单方面打破。 */
export function rankRound(state, roundId, candidateIds) {
  const tallies = candidateIds.map((id) => tallyCandidate(state, roundId, id));
  tallies.sort((a, b) => {
    if (a.mean === null && b.mean === null) return 0;
    if (a.mean === null) return 1;
    if (b.mean === null) return -1;
    return b.mean - a.mean;
  });
  const ranked = tallies.map((t, index) => ({ ...t, ordinal: index + 1, tiedWith: [] }));
  for (let i = 0; i < ranked.length; i += 1) {
    for (let j = i + 1; j < ranked.length; j += 1) {
      if (ranked[i].mean !== null && ranked[j].mean === ranked[i].mean) {
        ranked[i].tiedWith.push(ranked[j].candidateId);
        ranked[j].tiedWith.push(ranked[i].candidateId);
      }
    }
  }
  return ranked;
}

/**
 * 按类别配额产出入选名单。存在未处置并列且并列跨越配额线时，
 * 返回 unresolvedTies，必须先走冻结规则或委员会裁定，禁止偷偷按分数/顺序截断。
 */
export function allocateQuotas(state, roundId, rankings, quotas) {
  const winners = [];
  const unresolvedTies = [];
  const byCategory = new Map();
  for (const row of rankings) {
    const candidate = getCandidate(state, row.candidateId);
    const key = candidate.category;
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(row);
  }
  for (const [category, rows] of byCategory) {
    const quota = quotas[category] ?? 0;
    // 只有在本轮实际收到有效票的候选才参与配额分配；
    // 全票弃权/无人评分的类别不在本轮产出入选者。
    const scored = rows.filter((r) => r.mean !== null);
    for (let i = 0; i < scored.length; i += 1) {
      const row = scored[i];
      if (i < quota) {
        winners.push(row.candidateId);
        continue;
      }
      // 配额线上：若与末位入选者并列，则不能直接淘汰
      const lastWinner = scored[quota - 1];
      if (lastWinner && row.mean === lastWinner.mean) {
        unresolvedTies.push({
          category,
          quota,
          tiedCandidateIds: [lastWinner.candidateId, row.candidateId],
        });
      }
    }
  }
  return { winners, unresolvedTies };
}

/* ---------------- 公示：只展示候选本人授权的内容 ---------------- */

const SECTION_BUILDERS = {
  [ConsentSection.BASIC]: (state, id) => {
    const c = getCandidate(state, id);
    return { name: c.profile?.name ?? null, title: c.profile?.title ?? null };
  },
  [ConsentSection.NOMINATOR]: (state, id) => ({
    nominator: state.nominators[getCandidate(state, id).nominatorId]?.name ?? null,
  }),
  [ConsentSection.ACHIEVEMENTS]: (state, id) => ({
    achievements: Object.values(state.achievements)
      .filter((a) => a.candidateIds.map((x) => canonicalCandidateId(state, x)).includes(canonicalCandidateId(state, id)))
      .map((a) => ({ id: a.id, title: a.title, summary: a.summary })),
  }),
  [ConsentSection.EVIDENCE_SOURCES]: (state, id) => ({
    evidenceSources: Object.values(state.evidences)
      .filter((e) => canonicalCandidateId(state, e.candidateId) === canonicalCandidateId(state, id))
      .filter((e) => e.state === "VERIFIED")
      .map((e) => ({ type: e.evidenceType, source: e.source, hash: e.versions.at(-1).hash })),
  }),
  [ConsentSection.CONTRIBUTION]: (state, id) => ({
    contributions: Object.values(state.achievements)
      .map((a) => ({
        achievementId: a.id,
        title: a.title,
        credit: a.credits[canonicalCandidateId(state, id)]?.contribution ?? null,
      }))
      .filter((x) => x.credit),
  }),
};

/** 依据授权白名单构造公示快照；未授权板块一律不出现。 */
export function buildPublicationContent(state, candidateIds) {
  return candidateIds.map((id) => {
    const canonicalId = canonicalCandidateId(state, id);
    const consent = state.consents[canonicalId];
    const allowed = new Set(consent?.sections ?? []);
    const sections = {};
    for (const section of Object.values(ConsentSection)) {
      if (allowed.has(section)) {
        sections[section] = SECTION_BUILDERS[section](state, canonicalId);
      }
    }
    return {
      candidateId: canonicalId,
      category: getCandidate(state, canonicalId).category,
      sections,
      omittedSections: Object.values(ConsentSection).filter((s) => !allowed.has(s)),
    };
  });
}

/** 公示内容不含机构等未授权字段（basic 只放姓名/职务）。 */
export function assertPublicationSanity(content) {
  for (const entry of content) {
    if (entry.sections.basic && "organization" in entry.sections.basic) {
      return false;
    }
  }
  return true;
}
