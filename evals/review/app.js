(function () {
  "use strict";

  var state = { dataset: null, checklist: null, original: {}, current: 0, filter: "all", focus: null, fileName: "dataset.json" };

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "class") el.className = attrs[k];
      else if (k === "text") el.textContent = attrs[k];
      else if (k.indexOf("on") === 0) el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) el.setAttribute(k, attrs[k] === true ? "" : attrs[k]);
    });
    (children || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return el;
  }

  function $(id) { return document.getElementById(id); }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function norm(s) { return String(s || "").replace(/\s+/g, " ").trim().toLowerCase(); }

  function storageKey() { return "evalReview:" + (state.dataset && state.dataset.hash); }
  function save() {
    try {
      var snap = {};
      state.dataset.cases.forEach(function (c) { snap[c.id] = { expected: c.expected, status: c.review.status }; });
      localStorage.setItem(storageKey(), JSON.stringify(snap));
    } catch (e) {}
  }
  function restore() {
    try {
      var raw = localStorage.getItem(storageKey());
      if (!raw) return false;
      var snap = JSON.parse(raw);
      state.dataset.cases.forEach(function (c) {
        if (snap[c.id]) { c.expected = snap[c.id].expected; c.review.status = snap[c.id].status; }
      });
      return true;
    } catch (e) { return false; }
  }

  function parseFlag(text) {
    var m = /^([a-z_]+):([^:]+):([\s\S]*)$/.exec(text);
    return m ? { kind: m[1], cid: m[2], msg: m[3] } : { kind: "other", cid: "-", msg: text };
  }

  function criteria() {
    if (state.checklist && state.checklist.criteria) return state.checklist.criteria;
    var ids = {};
    state.dataset.cases.forEach(function (c) { Object.keys(c.expected).forEach(function (k) { ids[k] = 1; }); });
    return Object.keys(ids).sort().map(function (id) { return { id: id, title: "", description: "", type: "yes_no", na_allowed: true, scale_steps: [] }; });
  }

  function answerOptions(c) {
    var out = [];
    if (c.type === "scale") {
      c.scale_steps.map(function (s) { return s.value; }).sort(function (a, b) { return b - a; }).forEach(function (v) { out.push(v); });
    } else { out.push("yes"); out.push("no"); }
    if (c.na_allowed && c.type !== "flag") out.push("na");
    return out;
  }

  function sameAnswer(a, b) { return String(a) === String(b); }

  function localWarnings(c, item, messages) {
    var w = [];
    var byIndex = {};
    messages.forEach(function (m) { byIndex[m.message_index] = m; });
    if (!answerOptions(c).some(function (o) { return sameAnswer(o, item.answer); })) w.push("answer is not legal under the checklist");
    if (!item.rationale || !item.rationale.trim()) w.push("rationale is empty");
    (item.evidence || []).forEach(function (e) {
      var m = byIndex[e.message_index];
      if (!m) w.push("evidence message " + e.message_index + " does not exist");
      else if (!e.quote || norm(m.text).indexOf(norm(e.quote)) === -1) w.push("quote is not in message " + e.message_index);
    });
    var r = item.checked_range;
    if (r) {
      if (!byIndex[r.from] || !byIndex[r.to] || r.from > r.to) w.push("checked_range is invalid");
    }
    if (item.answer === "na" && !(item.na_reason && item.na_reason.trim())) w.push("na_reason is required for na");
    if (item.answer === "no" && c.type === "yes_no" && !r) w.push("checked_range is required for no");
    if (item.answer !== "na" && item.answer !== "no" && !(item.evidence || []).length && !(c.type === "flag" && item.answer === "no") && !(c.type === "scale" && Number(item.answer) === 0 && r)) w.push("at least one evidence item is needed");
    return w;
  }

  function currentCase() { return state.dataset.cases[state.current]; }

  function changed(c) { return JSON.stringify(c.expected) !== JSON.stringify(state.original[c.id]); }

  function setStatus(c, status) {
    if (status === "accepted" && changed(c)) status = "edited";
    c.review.status = status;
    save();
    renderList();
    renderProgress();
    renderStatus();
  }

  function renderProgress() {
    var cases = state.dataset ? state.dataset.cases : [];
    var done = cases.filter(function (c) { return c.review.status !== "pending"; }).length;
    var count = function (s) { return cases.filter(function (c) { return c.review.status === s; }).length; };
    $("progressText").textContent = cases.length
      ? done + " of " + cases.length + " reviewed (accepted " + count("accepted") + ", edited " + count("edited") + ", rejected " + count("rejected") + ", pending " + count("pending") + ")"
      : "No dataset loaded";
    $("progressBar").style.width = cases.length ? (100 * done / cases.length) + "%" : "0";
  }

  function visible(c) {
    var f = state.filter;
    if (f === "all") return true;
    if (f === "flagged") return c.review.flags.length > 0;
    return c.review.status === f;
  }

  function renderList() {
    var box = $("items");
    box.textContent = "";
    state.dataset.cases.forEach(function (c, i) {
      if (!visible(c) && i !== state.current) return;
      var badges = [h("span", { class: "badge " + c.review.status, text: c.review.status })];
      if (c.review.flags.length) badges.unshift(h("span", { class: "badge flags", text: c.review.flags.length + " flags" }));
      var item = h("div", { class: "item" + (i === state.current ? " active" : ""), tabindex: "0", role: "button", onclick: function () { select(i); }, onkeydown: function (e) { if (e.key === "Enter") select(i); } }, [
        h("span", { text: c.id + " " + c.split + " " + c.tags.channel }),
        h("span", {}, badges)
      ]);
      box.appendChild(item);
    });
  }

  function select(i) { state.current = i; state.focus = null; renderList(); renderDetail(); }

  function renderStatus() {
    var c = currentCase();
    var el = $("statusLine");
    if (el) el.textContent = "Status: " + c.review.status + (changed(c) ? " (expected result differs from the generated one)" : "");
  }

  function highlight() {
    var c = currentCase();
    var item = state.focus ? c.expected[state.focus] : null;
    document.querySelectorAll(".msg").forEach(function (row) {
      var idx = Number(row.getAttribute("data-index"));
      var ev = item && (item.evidence || []).some(function (e) { return e.message_index === idx; });
      var inr = item && item.checked_range && idx >= item.checked_range.from && idx <= item.checked_range.to;
      row.classList.toggle("evidence", !!ev);
      row.classList.toggle("inrange", !!inr);
    });
    document.querySelectorAll(".crit").forEach(function (el) { el.classList.toggle("focus", el.getAttribute("data-cid") === state.focus); });
  }

  function renderConversation(c) {
    var box = h("div", { class: "card conv" }, [h("strong", { text: "Conversation " + c.id }), h("div", { class: "muted", text: c.conversation.channel + " | " + c.conversation.language + " | " + c.conversation.messages.length + " messages" })]);
    c.conversation.messages.forEach(function (m) {
      box.appendChild(h("div", { class: "msg " + m.speaker, "data-index": String(m.message_index) }, [
        h("span", { class: "i", text: "#" + m.message_index }),
        h("span", { class: "t", title: String(m.timestamp_raw), text: m.offset_seconds === null ? String(m.timestamp_raw) : m.offset_seconds + "s" }),
        h("span", { class: "s", text: m.speaker }),
        h("span", { text: m.text })
      ]));
    });
    return box;
  }

  function flagNode(f) {
    var p = parseFlag(f);
    return h("div", { class: "flag " + p.kind }, [h("strong", { text: p.kind + " " }), p.msg]);
  }

  function renderCriterion(c, crit) {
    var item = c.expected[crit.id];
    var messages = c.conversation.messages;
    var card = h("div", { class: "card crit", "data-cid": crit.id, onclick: function () { state.focus = crit.id; highlight(); } });
    if (!item) {
      card.appendChild(h("h3", { text: crit.id + " " + crit.title }));
      card.appendChild(h("div", { class: "flag local", text: "no expected result for this criterion" }));
      return card;
    }
    var warnBox = h("div", {});
    function refresh() {
      warnBox.textContent = "";
      localWarnings(crit, item, messages).forEach(function (w) { warnBox.appendChild(h("div", { class: "flag local", text: "check " + w })); });
      card.classList.toggle("changed", JSON.stringify(item) !== JSON.stringify(state.original[c.id][crit.id]));
      renderStatus();
      save();
      highlight();
    }
    card.appendChild(h("h3", { text: crit.id + " " + crit.title + " (" + crit.type + (crit.weight ? ", weight " + crit.weight : "") + ")" }));
    if (crit.description) card.appendChild(h("div", { class: "desc", text: crit.description }));
    if (crit.na_allowed && crit.na_condition) card.appendChild(h("div", { class: "desc", text: "N/A when: " + crit.na_condition }));
    if (crit.type === "scale") {
      card.appendChild(h("details", {}, [h("summary", { text: "Scale steps" })].concat(crit.scale_steps.slice().sort(function (a, b) { return b.value - a.value; }).map(function (s) { return h("div", { class: "desc", text: s.value + ": " + s.descriptor }); }))));
    }
    c.review.flags.map(parseFlag).filter(function (p) { return p.cid === crit.id; }).forEach(function (p) { card.appendChild(flagNode(p.kind + ":" + p.cid + ":" + p.msg)); });

    var select = h("select", { "aria-label": "Answer for criterion " + crit.id });
    var options = answerOptions(crit);
    if (!options.some(function (o) { return sameAnswer(o, item.answer); })) options.unshift(item.answer);
    options.forEach(function (o) {
      var opt = h("option", { value: String(o), text: String(o) });
      if (sameAnswer(o, item.answer)) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener("change", function () {
      item.answer = crit.type === "scale" && select.value !== "na" ? Number(select.value) : select.value;
      refresh();
    });
    card.appendChild(h("div", { class: "row" }, [h("label", {}, ["Answer ", select])]));

    var rationale = h("textarea", { "aria-label": "Rationale " + crit.id });
    rationale.value = item.rationale || "";
    rationale.addEventListener("input", function () { item.rationale = rationale.value; refresh(); });
    card.appendChild(h("div", {}, [h("div", { class: "muted", text: "Rationale (Russian)" }), rationale]));

    var evBox = h("div", {});
    function renderEvidence() {
      evBox.textContent = "";
      item.evidence = item.evidence || [];
      item.evidence.forEach(function (e, i) {
        var idx = h("input", { type: "number", "aria-label": "Evidence message index" });
        idx.value = e.message_index === null || e.message_index === undefined ? "" : e.message_index;
        idx.addEventListener("input", function () { e.message_index = idx.value === "" ? null : Number(idx.value); refresh(); });
        var q = h("input", { type: "text", "aria-label": "Evidence quote" });
        q.value = e.quote || "";
        q.addEventListener("input", function () { e.quote = q.value; refresh(); });
        evBox.appendChild(h("div", { class: "ev" }, [idx, q, h("button", { type: "button", text: "Remove", onclick: function () { item.evidence.splice(i, 1); renderEvidence(); refresh(); } })]));
      });
    }
    renderEvidence();
    card.appendChild(h("div", {}, [h("div", { class: "muted", text: "Evidence (message index and exact quote)" }), evBox, h("button", { type: "button", text: "Add evidence", onclick: function () { item.evidence.push({ message_index: 0, quote: "" }); renderEvidence(); refresh(); } })]));

    var useRange = h("input", { type: "checkbox", "aria-label": "Use checked range" });
    useRange.checked = !!item.checked_range;
    var from = h("input", { type: "number", "aria-label": "Range from" });
    var to = h("input", { type: "number", "aria-label": "Range to" });
    from.value = item.checked_range ? item.checked_range.from : "";
    to.value = item.checked_range ? item.checked_range.to : "";
    function syncRange() {
      if (!useRange.checked) item.checked_range = null;
      else item.checked_range = { from: from.value === "" ? 0 : Number(from.value), to: to.value === "" ? 0 : Number(to.value) };
      from.disabled = to.disabled = !useRange.checked;
      refresh();
    }
    from.disabled = to.disabled = !useRange.checked;
    [useRange, from, to].forEach(function (el) { el.addEventListener("input", syncRange); });
    card.appendChild(h("div", { class: "row" }, [h("label", {}, [useRange, " checked_range from "]), from, " to ", to]));

    var naReason = h("input", { type: "text", "aria-label": "na reason" });
    naReason.value = item.na_reason || "";
    naReason.style.width = "100%";
    naReason.addEventListener("input", function () { item.na_reason = naReason.value === "" ? null : naReason.value; refresh(); });
    card.appendChild(h("div", {}, [h("div", { class: "muted", text: "na_reason" }), naReason]));
    card.appendChild(warnBox);
    refresh();
    return card;
  }

  function renderDetail() {
    var c = currentCase();
    var box = $("detail");
    box.textContent = "";
    var tags = c.tags;
    var head = h("div", { class: "card" }, [
      h("div", { class: "row" }, [
        h("strong", { text: c.id }),
        h("span", { class: "tags" }, [h("span", { text: "split " + c.split }), h("span", { text: "channel " + tags.channel }), h("span", { text: "language " + tags.language }), h("span", { text: "length " + tags.length }), h("span", { text: "topic " + tags.topic }), h("span", { text: "hard " + (tags.hard.join(", ") || "none") })])
      ]),
      h("div", { class: "row" }, [
        h("button", { class: "accept", type: "button", text: "Accept", onclick: function () { setStatus(c, "accepted"); } }),
        h("button", { class: "reject", type: "button", text: "Reject", onclick: function () { setStatus(c, "rejected"); } }),
        h("button", { type: "button", text: "Mark pending", onclick: function () { setStatus(c, "pending"); } }),
        h("button", { type: "button", text: "Reset edits", onclick: function () { c.expected = clone(state.original[c.id]); save(); renderDetail(); renderStatus(); } }),
        h("button", { type: "button", text: "Previous", onclick: function () { if (state.current > 0) select(state.current - 1); } }),
        h("button", { type: "button", text: "Next", onclick: function () { if (state.current < state.dataset.cases.length - 1) select(state.current + 1); } })
      ]),
      h("div", { id: "statusLine", class: "muted" })
    ]);
    var caseFlags = c.review.flags.map(parseFlag).filter(function (p) { return p.cid === "-"; });
    if (caseFlags.length) {
      head.appendChild(h("div", {}, [h("div", { class: "muted", text: "Case flags" })].concat(caseFlags.map(function (p) { return flagNode(p.kind + ":-:" + p.msg); }))));
    }
    box.appendChild(head);
    var left = renderConversation(c);
    var right = h("div", {}, criteria().map(function (crit) { return renderCriterion(c, crit); }));
    box.appendChild(h("div", { class: "cols" }, [left, right]));
    renderStatus();
    highlight();
  }

  function load(text, name) {
    var data;
    try { data = JSON.parse(text); } catch (e) { alert("Not valid JSON: " + e.message); return; }
    if (!data || !Array.isArray(data.cases)) { alert("File has no cases list"); return; }
    data.cases.forEach(function (c) { c.review = c.review || { status: "pending", flags: [] }; c.review.flags = c.review.flags || []; });
    state.dataset = data;
    state.fileName = name || "dataset.json";
    state.original = {};
    data.cases.forEach(function (c) { state.original[c.id] = clone(c.expected); });
    var restored = restore();
    state.current = 0;
    $("download").disabled = false;
    renderList();
    renderProgress();
    renderDetail();
    if (restored) $("progressText").textContent += " (progress restored from this browser)";
  }

  function download() {
    var out = JSON.stringify(state.dataset, null, 2) + "\n";
    var blob = new Blob([out], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = h("a", { href: url, download: state.fileName.replace(/\.json$/, "") + ".reviewed.json" });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function readFile(input, cb) {
    var file = input.files && input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () { cb(String(reader.result), file.name); };
    reader.readAsText(file);
  }

  if (window.CHECKLIST_V2) state.checklist = window.CHECKLIST_V2;
  $("file").addEventListener("change", function () { readFile($("file"), load); });
  $("checklist").addEventListener("change", function () {
    readFile($("checklist"), function (text) {
      try { state.checklist = JSON.parse(text); } catch (e) { alert("Checklist is not valid JSON"); return; }
      if (state.dataset) renderDetail();
    });
  });
  $("filter").addEventListener("change", function () { state.filter = $("filter").value; if (state.dataset) renderList(); });
  $("download").addEventListener("click", download);
})();
