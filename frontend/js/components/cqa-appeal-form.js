import { api } from "../api.js";

export const formStyles = `
.overlay { position: fixed; inset: 0; background: rgba(18, 38, 63, 0.45); display: flex; align-items: center; justify-content: center; z-index: 50; }
.dialog { background: #fff; border-radius: 8px; padding: 18px 20px; width: min(520px, 92vw); box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3); }
.dialog h4 { margin: 0 0 10px; font-size: 16px; }
.dform { display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
.dform label { display: flex; flex-direction: column; gap: 4px; font-weight: 600; color: #3a4658; }
.dform textarea, .dform select { font: inherit; font-weight: 400; padding: 6px 8px; border: 1px solid #b8c2d1; border-radius: 6px; }
.dform textarea { min-height: 70px; resize: vertical; }
.dform .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dform .err { color: #8a1f1f; background: #fdecec; border: 1px solid #e5a3a3; border-radius: 6px; padding: 6px 10px; white-space: pre-wrap; }
button.btn { padding: 6px 14px; border: 1px solid #274769; background: #274769; color: #fff; border-radius: 6px; cursor: pointer; font: inherit; }
button.btn.alt { background: #fff; color: #274769; }
button.btn:disabled { opacity: 0.5; cursor: default; }
`;

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function answerOptions(def) {
  const options = [];
  if (!def) return options;
  if (def.type === "scale") {
    for (const step of def.scale_steps || []) {
      options.push({ value: String(step.value), label: step.value + " - " + step.descriptor });
    }
  } else {
    options.push({ value: "yes", label: "Yes" });
    options.push({ value: "no", label: "No" });
  }
  if (def.na_allowed && def.type !== "flag") options.push({ value: "na", label: "N/A" });
  return options;
}

export function openAppealDialog(host, { evaluationId, criterionId, title, role }, onDone) {
  const overlay = make("div", "overlay");
  overlay.dataset.dialog = "appeal";
  const dialog = make("div", "dialog");
  dialog.appendChild(make("h4", "", "Appeal: " + criterionId + " " + (title || "")));
  const form = make("div", "dform");
  const label = make("label", "", "Comment (why the result is wrong)");
  const comment = make("textarea");
  comment.className = "appeal-comment";
  label.appendChild(comment);
  const err = make("div", "err");
  err.hidden = true;
  const row = make("div", "row");
  const submit = make("button", "btn", "Submit appeal");
  submit.type = "button";
  submit.className = "btn appeal-submit";
  const cancel = make("button", "btn alt", "Cancel");
  cancel.type = "button";
  row.append(submit, cancel);
  form.append(label, err, row);
  dialog.appendChild(form);
  overlay.appendChild(dialog);
  host.appendChild(overlay);
  const close = () => overlay.remove();
  cancel.addEventListener("click", close);
  submit.addEventListener("click", async () => {
    err.hidden = true;
    if (!comment.value.trim()) {
      err.textContent = "A comment is required.";
      err.hidden = false;
      return;
    }
    submit.disabled = true;
    try {
      await api.createAppeal(evaluationId, { criterion_id: criterionId, comment: comment.value.trim(), role });
      close();
      onDone();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      submit.disabled = false;
    }
  });
  comment.focus();
}

export function buildDecisionForm({ appeal, def, role }, onDone) {
  const form = make("div", "dform decision");
  form.dataset.appeal = appeal.id;
  const mode = make("div", "row");
  const confirm = make("button", "btn confirm", "Confirm");
  confirm.type = "button";
  const change = make("button", "btn alt change", "Change");
  change.type = "button";
  mode.append(confirm, change);
  const changeBox = make("div", "dform");
  changeBox.hidden = true;
  const selLabel = make("label", "", "New answer");
  const select = make("select");
  select.className = "new-answer";
  for (const o of answerOptions(def)) {
    const opt = make("option", "", o.label);
    opt.value = o.value;
    select.appendChild(opt);
  }
  selLabel.appendChild(select);
  changeBox.appendChild(selLabel);
  const reasonLabel = make("label", "", "Reason (required)");
  const reason = make("textarea");
  reason.className = "reason";
  reasonLabel.appendChild(reason);
  const err = make("div", "err");
  err.hidden = true;
  const send = make("button", "btn send", "Save decision");
  send.type = "button";
  send.disabled = true;
  form.append(mode, changeBox, reasonLabel, err, send);
  let decision = null;
  const refresh = () => {
    changeBox.hidden = decision !== "change";
    confirm.className = "btn confirm" + (decision === "confirm" ? "" : " alt");
    change.className = "btn change" + (decision === "change" ? "" : " alt");
    send.disabled = !decision || !reason.value.trim();
  };
  confirm.addEventListener("click", () => {
    decision = "confirm";
    refresh();
  });
  change.addEventListener("click", () => {
    decision = "change";
    refresh();
  });
  reason.addEventListener("input", refresh);
  send.addEventListener("click", async () => {
    err.hidden = true;
    if (!reason.value.trim()) {
      err.textContent = "A reason is required.";
      err.hidden = false;
      return;
    }
    send.disabled = true;
    const payload = { decision, reason: reason.value.trim(), role };
    if (decision === "change") payload.new_answer = select.value;
    try {
      await api.decideAppeal(appeal.id, payload);
      onDone();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      refresh();
    }
  });
  return form;
}
