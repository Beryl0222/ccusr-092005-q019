import { loadSeed } from "./seed.js";

/**
 * 把领域样例（规则、机构、拆分提名、证明来源、共同成果、评委）
 * 引导进一个全新的遴选服务：定义规则 → 开始（冻结）→ 登记与提交。
 *
 * 归并、回避声明、阶段评议、投票、公示等后续动作不在引导范围内，
 * 由调用方按流程推进（见 test/scenario.test.js）。
 */
export async function bootstrapFromSeed(service, seedInput) {
  const seed = seedInput ?? (await loadSeed());
  const records = seed.records;
  const byId = (id) => records.find((r) => r.id === id);
  const summary = {
    editionId: seed.editionId,
    rules: null,
    nominators: [],
    candidates: [],
    evidences: [],
    sharedWorks: [],
    judges: [],
  };

  for (const record of records) {
    if (record.kind === "rules") {
      summary.rules = service.defineRules(
        { version: record.version, rules: record.rules },
        "secretariat"
      );
    }
  }
  if (!summary.rules) throw new Error("领域样例缺少 rules 记录");

  service.openEdition({ editionId: seed.editionId, name: seed.project }, "secretariat");

  for (const record of records) {
    switch (record.kind) {
      case "nominator":
        service.registerNominator(
          { nominatorId: record.id, name: record.name, type: record.type },
          "secretariat"
        );
        summary.nominators.push(record.id);
        break;
      case "judge":
        service.registerJudge(
          { judgeId: record.id, name: record.name, organization: record.organization },
          "secretariat"
        );
        summary.judges.push(record.id);
        break;
    }
  }

  for (const record of records) {
    if (record.kind !== "candidate") continue;
    service.submitCandidate(
      {
        candidateId: record.id,
        nominatorId: record.nominatorId,
        rawName: record.rawName,
        affiliation: record.affiliation,
        candidateType: record.candidateType,
        categoryId: record.categoryId,
        deedsSummary: record.deedsSummary,
        contributionNote: record.contributionNote,
      },
      record.nominatorId
    );
    summary.candidates.push(record.id);
  }

  for (const record of records) {
    if (record.kind !== "evidence") continue;
    if (!byId(record.candidateId)) throw new Error(`证明 ${record.id} 引用了不存在的候选`);
    service.submitEvidence(
      {
        evidenceId: record.id,
        candidateId: record.candidateId,
        kind: record.evidenceKind ?? record.evidence_type, // evidenceKind 为标准字段，兼容基线 evidence_type
        source: record.source,
        title: record.title,
        contentHash: record.contentHash,
        kindTag: record.kindTag ?? "initial",
      },
      "secretariat"
    );
    summary.evidences.push(record.id);
  }

  for (const record of records) {
    if (record.kind !== "sharedWork") continue;
    service.declareSharedWork(
      {
        workId: record.id,
        title: record.title,
        candidateIds: record.candidateIds,
        contributions: record.contributions,
      },
      "secretariat"
    );
    summary.sharedWorks.push(record.id);
  }

  return summary;
}
