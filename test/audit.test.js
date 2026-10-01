import test from "node:test";
import { readFile } from "node:fs/promises";

import { assert, setup, expectError, Errors } from "./helpers/setup.js";
import { ConsentSection } from "../src/index.js";

import { project } from "../src/domain/projection.js";

// 复用公示测试中的完整局面构造
import { sealTwoRounds } from "./helpers/scenario.js";

test("审计：复现已封存轮次，选票指纹与名次完全一致", () => {
  const { api } = sealTwoRounds();
  const replay = api.audit.replayRound("E1", "R_PRO");
  assert.equal(replay.scoreSetHashMatches, true);
  assert.equal(replay.rankingsMatch, true);
  assert.ok(replay.winners.includes("li-tech"));
  assert.ok(replay.winners.includes("team-1"));
  // 4 名评委中 r-coi 对张、团队均回避；选票清单可逐张复核
  const teamBallots = replay.ballots.filter((b) => b.candidateId === "team-1");
  assert.equal(teamBallots.length, 2, "回避评委没有选票");

  const replaySoc = api.audit.replayRound("E1", "R_SOC");
  assert.equal(replaySoc.scoreSetHashMatches, true);
  assert.ok(replaySoc.winners.includes("zhang-service"));
});

test("审计：折叠到封存时点可精确复现历史轮次状态", () => {
  const { api } = sealTwoRounds();
  // 以第一张社会轮选票的序号为界：此前专业轮已封存所依据的状态可独立复现
  const firstSocScore = api.store.events.find(
    (e) => e.type === "SCORE_SUBMITTED" && e.data.roundId === "R_SOC"
  );
  assert.ok(firstSocScore);
  const historical = api.audit.replayAt(firstSocScore.seq);
  assert.equal(
    historical.scores.filter((s) => s.roundId === "R_SOC").length,
    0,
    "社会轮开始前的时点：尚无社会轮选票"
  );
  assert.ok(historical.scores.some((s) => s.roundId === "R_PRO"));
  // R_PRO 的封存不依赖时点：复现只计 R_PRO 选票，不受后来社会轮分数影响
  const rounds = api.audit.listRounds("E1");
  assert.equal(rounds.length, 2);
  const replayPro = api.audit.replayRound("E1", "R_PRO");
  assert.equal(replayPro.ballotCount, replayPro.ballots.length);
  assert.ok(replayPro.ballots.every((b) => ["li-tech", "zhang-tech", "team-1"].includes(b.candidateId)));
  const current = project(api.store.events);
  assert.ok(current.scores.some((s) => s.roundId === "R_SOC"));
});

test("审计：暗改任一历史选票都会在复现时暴露", () => {
  const { api } = sealTwoRounds();
  // 找到李医生一张 95 分票并偷偷改成 100
  const idx = api.store.events.findIndex(
    (e) => e.type === "SCORE_SUBMITTED" && e.data.candidateId === "li-tech"
  );
  assert.ok(idx >= 0);
  api.store.events[idx].data = { ...api.store.events[idx].data, value: 100 };
  // 哈希链立即失效
  assert.throws(() => api.audit.verifyIntegrity(), (e) => e.code === Errors.TAMPERED);
  // 即使绕过链校验，重算的选票指纹也对不上封存指纹
  const replay = api.audit.replayRound("E1", "R_PRO");
  assert.equal(replay.scoreSetHashMatches, false);
});

test("审计：删除一张选票同样被发现", () => {
  const { api } = sealTwoRounds();
  const idx = api.store.events.findIndex((e) => e.type === "SCORE_SUBMITTED");
  api.store.events.splice(idx, 1);
  assert.throws(() => api.audit.verifyIntegrity(), (e) => e.code === Errors.TAMPERED);
});

test("审计：勘误前后改变了什么、由谁批准均可逐条说明", () => {
  const { api } = sealTwoRounds();
  api.selection.advanceStage("E1", "PUBLICITY", "组委会");
  api.publicity.publish("E1", "R_PRO", "秘书处");
  api.selection.advanceStage("E1", "OBJECTION", "组委会");
  api.publicity.fileObjection(
    { objectionId: "obj-9", editionId: "E1", candidateId: "li-tech", grounds: "职称表述有误" },
    "李医生本人"
  );
  api.publicity.correctPublication(
    {
      editionId: "E1",
      candidateId: "li-tech",
      section: ConsentSection.BASIC,
      after: { name: "李医生", title: "主任医师" },
      reason: "obj-9：职称已于年初晋升，公示沿用旧衔",
      approver: "组委会主任",
      objectionId: "obj-9",
    },
    "秘书处"
  );
  api.publicity.decideObjection(
    { objectionId: "obj-9", decision: "UPHELD", note: "属实，已更正为主任医师" },
    "异议复核组"
  );
  const [c] = api.audit.publicationCorrections("E1");
  assert.equal(c.before.title, "医师");
  assert.equal(c.after.title, "主任医师");
  assert.equal(c.approver, "组委会主任");
  assert.equal(c.objectionId, "obj-9");
  assert.ok(c.approvedAt);
});

test("审计：证据链保留原件哈希与每次更正理由", () => {
  const { api } = sealTwoRounds();
  api.clock.set("2026-03-20T00:00:00.000Z");
  api.selection.amendEvidence(
    { evidenceId: "ev-team-1", content: "原件-team-1（补页码）", reason: "补正页码", label: "修订版1" },
    "推荐机构"
  );
  const trail = api.audit.evidenceTrail("ev-team-1");
  assert.equal(trail.versions.length, 2);
  assert.notEqual(trail.originalHash, trail.currentHash);
  assert.equal(trail.versions[0].label, "原件");
  assert.equal(trail.versions[1].reason, "补正页码");
});

test("审计：身份归并轨迹覆盖跨类别多条提名", () => {
  const { api } = sealTwoRounds();
  const trail = api.audit.identityTrail("p-zhang");
  assert.equal(trail.links.length, 2);
  const categories = trail.links.map((l) => l.category).sort();
  assert.deepEqual(categories, ["个人技术奖", "社会服务奖"]);
  assert.equal(trail.links.every((l) => l.mergedAway === false), true);
  assert.ok(trail.links.every((l) => l.log[0].basis === "证件号哈希一致"));
});

test("落盘重载后审计结果一致，篡改文件无法载入", async () => {
  const { api } = sealTwoRounds();
  const path = `/tmp/honors-audit-${Date.now()}.json`;
  await api.store.persist(path);

  const { EventStore } = await import("../src/core/eventStore.js");
  const { AuditService } = await import("../src/services/auditService.js");
  const reloaded = await EventStore.fromFile(path);
  const audit = new AuditService(reloaded);
  assert.equal(audit.replayRound("E1", "R_PRO").scoreSetHashMatches, true);

  // 篡改文件
  const raw = JSON.parse(await readFile(path, "utf8"));
  raw[5].data.tampered = true;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, JSON.stringify(raw));
  await assert.rejects(() => EventStore.fromFile(path), (e) => e.code === Errors.TAMPERED);
});
