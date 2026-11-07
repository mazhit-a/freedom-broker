import test from "node:test";
import assert from "node:assert/strict";
import { configure, api } from "../src/api.js";
import { mapListResponse, mapOverview } from "../src/mappers.js";

const LIVE = process.env.CQA_LIVE_BASE;
const skip = LIVE ? false : "set CQA_LIVE_BASE to a server started on a COPY of cqa.db";

async function raw(path) {
  const response = await fetch(LIVE.replace(/\/+$/, "") + path);
  const text = await response.text();
  assert.equal(response.status, 200, path);
  assert.ok(!/audio_url|powerplatform|sig=|api-version/.test(text), `no recording url in ${path}`);
  return JSON.parse(text);
}

function live() {
  configure({ mock: false, baseUrl: LIVE });
}

test("live list: every row maps from the fresh payload", { skip }, async () => {
  const body = await raw("/conversations?envelope=1");
  const mapped = mapListResponse(body);
  assert.equal(mapped.total, body.total);
  assert.equal(mapped.items.length, body.items.length);
  assert.equal(mapped.evaluated, body.evaluated);
  assert.ok(!JSON.stringify(mapped).includes("audio_url"));
  mapped.items.forEach((item, i) => {
    const source = body.items[i];
    assert.equal(item.pk, source.id);
    assert.equal(item.id, source.conversation_id);
    assert.equal(item.operator, "Оператор A");
    assert.ok(["chat", "call"].includes(item.channel), item.id);
    assert.equal(item.hasAudio, source.has_audio);
    if (source.eval_status === "failed" || source.evaluation_id === null) {
      assert.equal(item.total, null);
    } else {
      assert.equal(item.total, source.final_total, `${item.id} shows the final total`);
      assert.equal(item.originalTotal, source.total);
    }
    if (item.evaluated && !item.failed) {
      assert.equal(typeof item.gross, "boolean", item.id);
      assert.ok(Array.isArray(item.sections), item.id);
      const scored = item.sections.filter((s) => s.id !== "gross");
      assert.equal(scored.length, 3, `${item.id} has three scored sections`);
      if (item.total !== null) {
        const sum = scored.reduce((acc, s) => acc + (s.effectivePoints ?? 0), 0);
        assert.ok(Math.abs(sum - item.total) < 0.05, `${item.id} sections sum ${sum} vs total ${item.total}`);
      }
      assert.match(item.versionLabel, /^v\d+$/);
      assert.ok(item.confidence === null || ["high", "medium", "low"].includes(item.confidence.level), item.id);
    }
  });
  assert.equal(mapped.items.filter((i) => i.gross === true).length, mapped.items.filter((i) => body.items.find((b) => b.id === i.pk).gross_violation === true).length);
});

test("live adapter: paging, search, sort and filters go to the server", { skip }, async () => {
  live();
  const first = await api.listConversations({ limit: 50 });
  const second = await api.listConversations({ limit: 50, offset: 50 });
  assert.equal(first.total, 65);
  assert.equal(first.items.length, 50);
  assert.equal(second.items.length, 15);
  assert.equal(new Set([...first.items, ...second.items].map((i) => i.pk)).size, 65);

  const hit = await api.listConversations({ q: "p4-ru-005", limit: 50 });
  assert.ok(hit.items.some((i) => i.id === "p4-ru-005"));
  assert.ok(hit.total < 65);

  const asc = await api.listConversations({ sort: "total", limit: 50 });
  const totals = asc.items.map((i) => i.total).filter((v) => v !== null);
  assert.deepEqual(totals, [...totals].sort((a, b) => a - b));
  const desc = await api.listConversations({ sort: "-total", limit: 50 });
  const dtotals = desc.items.map((i) => i.total).filter((v) => v !== null);
  assert.deepEqual(dtotals, [...dtotals].sort((a, b) => b - a));

  const gross = await api.listConversations({ gross: true, limit: 50 });
  assert.equal(gross.total, 8);
  assert.ok(gross.items.every((i) => i.gross === true));

  const calls = await api.listConversations({ channel: "call", limit: 50 });
  assert.ok(calls.items.length > 0 && calls.items.every((i) => i.channel === "call" && i.hasAudio));

  const changed = await api.listConversations({ appealStatus: "changed" });
  assert.ok(changed.items.every((i) => i.appealStatus === "changed"));
  const resolved = await api.listConversations({ appealStatus: "confirmed" });
  assert.ok(resolved.items.every((i) => i.appealStatus === "confirmed"));
});

test("live overview: mapped KPIs, distribution and per-criterion equal the payload", { skip }, async () => {
  const body = await raw("/stats/overview");
  const list = await raw("/conversations?envelope=1");
  const o = mapOverview(body);
  assert.equal(o.kpis.avgScore, body.kpis.avg);
  assert.equal(o.kpis.evaluatedCount, body.kpis.evaluated);
  assert.equal(o.kpis.evaluatedCount + o.kpis.notCalculated, list.total);
  assert.equal(o.distribution.reduce((a, b) => a + b.count, 0), o.kpis.evaluatedCount);
  assert.equal(o.distribution.length, 10);
  assert.equal(o.kpis.chats + o.kpis.calls, o.kpis.evaluatedCount);
  assert.equal(o.kpis.grossCount, list.items.filter((i) => i.gross_violation === true).length);
  const finals = list.items.map((i) => i.final_total).filter((v) => v !== null);
  assert.ok(Math.abs(o.kpis.avgScore - finals.reduce((a, b) => a + b, 0) / finals.length) < 0.01);
  assert.equal(o.perCriterion.length, body.per_criterion.length);
  assert.ok(o.perCriterion.every((c) => typeof c.avgPercent === "number" && c.applicableCount > 0));
  assert.equal(o.byLanguage.reduce((a, b) => a + b.count, 0), o.kpis.evaluatedCount);
  assert.equal(o.byChannel.reduce((a, b) => a + b.count, 0), o.kpis.evaluatedCount);
  assert.equal(o.attentionTotal, body.attention_total);

  live();
  const viaAdapter = await api.getOverview({});
  assert.deepEqual(viaAdapter, o);
  const ru = await api.getOverview({ language: "RU", channel: "chat" });
  assert.ok(ru.kpis.evaluatedCount <= o.kpis.evaluatedCount);
  assert.equal(ru.kpis.calls, 0);
});
