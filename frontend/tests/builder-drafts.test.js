import test from "node:test";
import assert from "node:assert/strict";
import { makeConfig } from "../src/mock-fixtures.js";
import { configure, api, resetMock } from "../src/api.js";
import { t as translate, DICTIONARIES, LOCALES } from "../src/i18n/index.js";
import { createBlankDraft, createDraft, setChecklistName, toConfig, toDraftConfig, addCriterion } from "../src/components/builder-model.js";
import { validate } from "../src/components/builder-validate.js";
import { computePreview } from "../src/components/builder-preview.js";
import { sidebar, topBar } from "../src/components/builder-views.js";
import { CqaChecklistBuilder } from "../src/components/cqa-checklist-builder.js";

const NAMES = { name: "Новый чек-лист", sectionTitle: "Раздел 1" };

function chatDraft(over = {}) {
  const config = makeConfig("Чаты");
  return createDraft(config, config, { checklistId: 1, versionId: 13, versionNumber: 3, baseNumber: 2, ...over }, "ru");
}

function ctxFor(draft, over = {}) {
  const lists = [
    {
      id: 1,
      name: "Чаты",
      channels: ["agent chat"],
      defaultVersionId: 12,
      versions: [
        { id: 11, version: 1, status: "archived", isDefault: false, appliedCount: 412, firstAppliedAt: "2026-08-12T10:00:00+05:00", locked: true },
        { id: 12, version: 2, status: "active", isDefault: true, appliedCount: 1248, firstAppliedAt: "2026-10-01T10:00:00+05:00", locked: true },
        { id: 13, version: 3, status: "draft", isDefault: false, appliedCount: 0, firstAppliedAt: null, locked: false }
      ]
    },
    { id: 2, name: "Звонки", channels: ["voice call"], defaultVersionId: null, versions: [{ id: 21, version: 1, status: "draft", isDefault: false, appliedCount: 0, firstAppliedAt: null, locked: false }] }
  ];
  return {
    t: (key, params) => translate(key, params, "ru"),
    locale: "ru",
    draft,
    view: { validation: validate(draft), preview: computePreview(draft), changedCount: 0 },
    selectedKey: null,
    readOnly: false,
    roleReadOnly: false,
    locked: false,
    busy: false,
    busyName: null,
    viewing: false,
    viewed: null,
    newChannels: ["chat"],
    dirty: false,
    saveError: null,
    status: "draft",
    lists,
    current: lists[0],
    ...over
  };
}

test("draft payload keeps incomplete work: weights not 100, empty section, unnamed criterion", () => {
  const draft = chatDraft();
  draft.criteria[0].weight = "5";
  draft.criteria[1].name = "";
  draft.sections.push({ id: "section-9", title: "", labels: null, origTitle: null, touched: true });
  const { config, dropped } = toDraftConfig(draft);
  assert.equal(dropped, 0);
  assert.equal(config.criteria[0].weight, 5);
  assert.equal(config.criteria[1].title, "");
  assert.equal(config.sections.at(-1).id, "section-9");
  assert.equal(validate(draft).valid, false);
  assert.equal(validate(draft).draftValid, true);
});

test("draft payload drops only scale steps the server cannot parse and reports the count", () => {
  const draft = chatDraft();
  const scale = draft.criteria.find((c) => c.type === "scale");
  scale.steps = [
    { value: "0", description: "a" },
    { value: "5", description: "" },
    { value: "5", description: "dup" },
    { value: "x", description: "bad" },
    { value: "-1", description: "neg" },
    { value: "2.5", description: "frac" }
  ];
  const { config, dropped } = toDraftConfig(draft);
  const out = config.criteria.find((c) => c.id === scale.id);
  assert.deepEqual(out.scale_steps.map((s) => s.value), [0, 5]);
  assert.equal(out.max_step, 5);
  assert.equal(dropped, 4);
  assert.equal(toConfig(draft).criteria.find((c) => c.id === scale.id).scale_steps.length, 6);
});

test("new checklist starts clean: one default section, no criteria, no baseline", () => {
  const draft = createBlankDraft(NAMES, "ru", "2026-11-07T10:00:00Z");
  assert.equal(draft.isNew, true);
  assert.equal(draft.checklistId, null);
  assert.equal(draft.versionId, null);
  assert.equal(draft.versionNumber, 1);
  assert.equal(draft.baseNumber, null);
  assert.equal(draft.criteria.length, 0);
  assert.deepEqual(draft.sections.map((s) => s.title), ["Раздел 1"]);
  const config = toConfig(draft);
  assert.equal(config.name, "Новый чек-лист");
  assert.deepEqual(config.criteria, []);
  assert.equal(config.sections.length, 1);
  assert.equal(computePreview(draft).ok, false);
  assert.equal(computePreview(draft).reason, "empty");
});

test("new checklist is independent of an existing draft", () => {
  const existing = chatDraft();
  const blank = createBlankDraft(NAMES, "ru", "2026-11-07T10:00:00Z");
  addCriterion(blank, "section-1", { name: "A", description: "" });
  assert.equal(blank.criteria.length, 1);
  assert.equal(existing.criteria.length, 8);
  assert.equal(blank.criteria[0].id, "01");
});

test("checklist name: empty and case-insensitive duplicates block both saves, valid names pass", () => {
  const draft = createBlankDraft(NAMES, "ru", "2026-11-07T10:00:00Z");
  const others = ["Чек-лист качества чатов", "Чек-лист качества звонков"];
  assert.equal(validate(draft, { otherNames: others }).draftValid, true);
  setChecklistName(draft, "   ");
  let v = validate(draft, { otherNames: others });
  assert.equal(v.draftValid, false);
  assert.ok(v.errors.some((e) => e.code === "listNameEmpty"));
  setChecklistName(draft, "ЧЕК-ЛИСТ КАЧЕСТВА ЧАТОВ ");
  v = validate(draft, { otherNames: others });
  assert.equal(v.draftValid, false);
  assert.ok(v.errors.some((e) => e.code === "listNameDup"));
  assert.equal(v.valid, false);
  setChecklistName(draft, "Чек-лист жалоб");
  assert.equal(validate(draft, { otherNames: others }).draftValid, true);
  assert.ok(validate(draft, { otherNames: others }).errors.some((e) => e.code === "noCriteria"));
});

test("existing checklists are not subject to the name rule", () => {
  const draft = chatDraft();
  assert.equal(validate(draft, { otherNames: ["Чаты"] }).draftValid, true);
});

test("top bar: save draft follows unsaved edits, ignores the weight gate, apply is explained", () => {
  const draft = chatDraft();
  draft.criteria[0].weight = "5";
  const clean = String(topBar(ctxFor(draft)));
  assert.match(clean, /data-action="save-draft"[^>]*disabled/);
  const edited = String(topBar(ctxFor(draft, { dirty: true })));
  assert.doesNotMatch(edited, /data-action="save-draft"[^>]*disabled/);
  assert.match(edited, /data-action="save"[^>]*disabled/);
  assert.match(edited, /Черновик нельзя применить или сделать активным/);
  assert.match(edited, /data-action="delete-draft"/);
  const viewer = String(topBar(ctxFor(draft, { dirty: true, roleReadOnly: true, readOnly: true })));
  assert.match(viewer, /data-action="save-draft"[^>]*disabled/);
  assert.doesNotMatch(viewer, /data-action="delete-draft"/);
  assert.doesNotMatch(viewer, /Черновик нельзя применить/);
  const memory = chatDraft({ versionId: null });
  assert.doesNotMatch(String(topBar(ctxFor(memory, { dirty: true }))), /data-action="delete-draft"/);
});

test("top bar: new checklist shows a name field, an inline error and an enabled draft button", () => {
  const draft = createBlankDraft(NAMES, "ru", "2026-11-07T10:00:00Z");
  const html1 = String(topBar(ctxFor(draft, { dirty: true })));
  assert.match(html1, /data-field="new-name"/);
  assert.doesNotMatch(html1, /data-action="save-draft"[^>]*disabled/);
  assert.match(html1, /data-action="save"[^>]*disabled/);
  setChecklistName(draft, "");
  const bad = String(topBar(ctxFor(draft, { dirty: true })));
  assert.match(bad, /data-name-error/);
  assert.match(bad, /data-action="save-draft"[^>]*disabled/);
});

test("top bar in view mode: Make active only for QA and only when not active", () => {
  const draft = chatDraft({ versionId: 11, versionNumber: 1 });
  const archived = { id: 11, version: 1, status: "archived", isDefault: false, appliedCount: 412, firstAppliedAt: "2026-08-12T10:00:00+05:00" };
  const active = { id: 12, version: 2, status: "active", isDefault: true, appliedCount: 1248, firstAppliedAt: "2026-10-01T10:00:00+05:00" };
  const a = String(topBar(ctxFor(draft, { viewing: true, readOnly: true, viewed: archived })));
  assert.match(a, /data-action="activate" data-version="11"/);
  assert.match(a, /Просмотр v1 · Архив/);
  assert.match(a, /412 диалогов/);
  assert.match(a, /data-action="duplicate"/);
  const b = String(topBar(ctxFor(draft, { viewing: true, readOnly: true, viewed: active })));
  assert.doesNotMatch(b, /data-action="activate"/);
  assert.match(b, /data-active-marker/);
  const c = String(topBar(ctxFor(draft, { viewing: true, readOnly: true, roleReadOnly: true, viewed: archived })));
  assert.doesNotMatch(c, /data-action="activate"/);
  assert.doesNotMatch(c, /data-action="duplicate"/);
});

test("sidebar: every version of every checklist is an open button, the current one has aria-current", () => {
  const draft = chatDraft();
  const html1 = String(sidebar(ctxFor(draft)));
  for (const id of [11, 12, 13, 21]) assert.match(html1, new RegExp(`data-action="open-version" data-version="${id}"`));
  assert.equal((html1.match(/aria-current="true"/g) || []).length, 1);
  const viewed = String(sidebar(ctxFor(draft, { viewing: true, readOnly: true, viewed: ctxFor(draft).lists[0].versions[0] })));
  assert.match(viewed, /data-version="11" data-focus-id="ver-11" aria-current="true"/);
  assert.doesNotMatch(viewed, /data-editing/);
  assert.doesNotMatch(html1, /data-version-row="21"[^]*?data-action="activate"/);
  const foreign = html1.slice(html1.indexOf('data-version-row="21"'));
  assert.doesNotMatch(foreign, /data-action="(activate|duplicate)"/);
});

test("sidebar: archived rows offer Make active to QA only, drafts never", () => {
  const draft = chatDraft();
  const qa = String(sidebar(ctxFor(draft)));
  assert.match(qa, /data-action="activate" data-version="11"/);
  assert.doesNotMatch(qa, /data-action="activate" data-version="13"/);
  assert.doesNotMatch(qa, /data-action="activate" data-version="21"/);
  const lists = ctxFor(draft).lists;
  const view = String(sidebar(ctxFor(draft, { viewing: true, readOnly: true, viewed: lists[0].versions[0] })));
  assert.match(view, /data-draft-note/);
  const viewer = String(sidebar(ctxFor(draft, { roleReadOnly: true })));
  assert.doesNotMatch(viewer, /data-action="activate"/);
  assert.doesNotMatch(viewer, /data-draft-note/);
});

test("sidebar: New checklist is enabled for QA, disabled for viewers; the unsaved entry carries a badge and a draft row", () => {
  const draft = chatDraft();
  assert.doesNotMatch(String(sidebar(ctxFor(draft))), /data-action="new-checklist"[^>]*disabled/);
  assert.match(String(sidebar(ctxFor(draft, { roleReadOnly: true }))), /data-action="new-checklist"[^>]*disabled/);
  const blank = createBlankDraft(NAMES, "ru", "2026-11-07T10:00:00Z");
  const out = String(sidebar(ctxFor(blank, { current: null, newChannels: ["call"] })));
  assert.match(out, /data-new-block/);
  assert.match(out, /новый/);
  assert.match(out, /data-field="new-channel" data-channel="call"[^>]*checked/);
  assert.match(out, /data-version-row="new"/);
  assert.equal((out.match(/data-checklist-title/g) || []).length, 1);
  assert.equal((out.match(/data-action="open-checklist"/g) || []).length, 2);
});

test("mock: draft-first checklist, update, finalize validation, delete, role gate", async () => {
  configure({ mock: true, role: "reviewer" });
  resetMock();
  const before = await api.listChecklists();
  const blank = { name: "Жалобы", sections: [{ id: "section-1", title: "Раздел 1" }], criteria: [] };
  const made = await api.createChecklistDraft(blank, { channels: ["voice call"] });
  assert.equal(made.status, "draft");
  assert.equal(made.version, 1);
  const lists = await api.listChecklists();
  assert.equal(lists.length, before.length + 1);
  const mine = lists.find((c) => c.id === made.checklistId);
  assert.equal(mine.defaultVersionId, null);
  assert.deepEqual(mine.channels, ["voice call"]);
  assert.deepEqual(lists.slice(0, before.length), before);
  await assert.rejects(() => api.finalizeVersion(made.id), (e) => e.status === 422);
  await assert.rejects(() => api.saveChecklistVersion(mine.id, blank), (e) => e.status === 422);
  await assert.rejects(() => api.setActiveVersion(mine.id, made.id), (e) => e.status === 422);
  const cfg = makeConfig("Жалобы");
  cfg.criteria[0].weight = 3;
  const updated = await api.updateDraft(made.id, cfg);
  assert.equal(updated.warnings.length, 1);
  const dup = makeConfig("Жалобы");
  dup.criteria[1].id = dup.criteria[0].id;
  await assert.rejects(() => api.updateDraft(made.id, dup), (e) => e.status === 422);
  await assert.rejects(() => api.deleteDraft(before[0].defaultVersionId), (e) => e.status === 409);
  await api.deleteDraft(made.id);
  assert.equal((await api.listChecklists()).length, before.length);
  await assert.rejects(() => api.deleteDraft(made.id), (e) => e.status === 404);
  configure({ mock: true, role: "operator" });
  resetMock();
  await assert.rejects(() => api.createChecklistDraft(blank), (e) => e.code === "role_forbidden");
  await assert.rejects(() => api.deleteDraft(13), (e) => e.code === "role_forbidden");
  configure({ mock: true });
  resetMock();
});

test("mock: activation archives the previous active version, also when rolling back", async () => {
  configure({ mock: true, role: "reviewer" });
  resetMock();
  const [chat] = await api.listChecklists();
  const statuses = async () => (await api.listChecklists())[0].versions.map((v) => v.status);
  assert.deepEqual(await statuses(), ["archived", "active", "draft"]);
  await api.setActiveVersion(chat.id, 11);
  assert.deepEqual(await statuses(), ["active", "archived", "draft"]);
  await api.setActiveVersion(chat.id, 12);
  assert.deepEqual(await statuses(), ["archived", "active", "draft"]);
  await assert.rejects(() => api.setActiveVersion(chat.id, 13), (e) => e.status === 422);
  configure({ mock: true });
  resetMock();
});

function stubBuilder(over = {}) {
  const el = Object.create(CqaChecklistBuilder.prototype);
  Object.assign(el, { _dirty: true, _draft: chatDraft(), _status: "draft", _mode: "edit", _locale: "ru", _view: { validation: { draftValid: true } }, _lists: [] }, over);
  el.t = (key, params) => translate(key, params, "ru");
  el.getAttribute = (name) => (name === "role" ? "reviewer" : null);
  el.hasAttribute = () => true;
  return el;
}

test("unsaved guard: clean passes, save-as-draft saves then proceeds, discard proceeds, cancel stays", async () => {
  const seen = [];
  const make = (choice, saved = true) => {
    const el = stubBuilder();
    el.askConfirm = async (detail) => {
      seen.push(detail);
      return choice;
    };
    el.doSaveDraft = async (opts) => {
      seen.push({ saveDraft: opts });
      return saved;
    };
    return el;
  };
  const clean = make(true);
  clean._dirty = false;
  assert.equal(await clean.confirmLeave(), true);
  assert.equal(seen.length, 0);
  assert.equal(await make("extra").confirmLeave(), true);
  assert.deepEqual(seen[1], { saveDraft: { leaving: true } });
  assert.equal(seen[0].extraLabel, "Сохранить черновик");
  assert.equal(seen[0].confirmLabel, "Отбросить и продолжить");
  assert.equal(await make("extra", false).confirmLeave(), false);
  assert.equal(await make(true).confirmLeave(), true);
  assert.equal(await make(false).confirmLeave(), false);
});

test("unsaved guard offers no save-as-draft when the checklist name is invalid", async () => {
  const el = stubBuilder({ _view: { validation: { draftValid: false } } });
  let detail = null;
  el.askConfirm = async (d) => {
    detail = d;
    return false;
  };
  await el.confirmLeave();
  assert.equal(detail.extraLabel, null);
});

test("every new builder key exists in all locales and the KZ/EN confirm texts are filled", () => {
  const keys = Object.keys(DICTIONARIES.ru).filter((k) => /^builder\.(saveDraft|deleteDraft|applyDraftReason|new\.|view\.|confirm\.(activate|delete|cancel|descriptionNoDraft)|toast\.draft|err\.(listName|noCriteria)|side\.draftNote|pv\.empty)/.test(k));
  assert.ok(keys.length >= 25);
  for (const locale of LOCALES) for (const key of keys) assert.ok(DICTIONARIES[locale][key], `${locale}:${key}`);
  assert.equal(translate("builder.toast.draftSaved", {}, "ru"), "Черновик сохранён · не применён");
  assert.equal(translate("builder.confirm.activateDescription", { version: "v1" }, "ru"), "Новые оценки будут идти по v1; прошлые оценки не изменятся.");
});
