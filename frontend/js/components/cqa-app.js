const ROLES = ["QA", "Reviewer"];

const template = document.createElement("template");
template.innerHTML = `
<style>
:host { display: block; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1c2430; min-height: 100vh; background: #f4f5f7; }
header { display: flex; align-items: center; gap: 24px; padding: 12px 24px; background: #12263f; color: #fff; }
.brand { font-weight: 700; font-size: 18px; letter-spacing: 0.5px; }
nav { display: flex; gap: 8px; flex: 1; }
nav a { color: #cfd8e6; text-decoration: none; padding: 6px 12px; border-radius: 6px; }
nav a.active { background: #274769; color: #fff; }
.roles { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.roles button { border: 1px solid #5d7899; background: transparent; color: #cfd8e6; padding: 5px 12px; border-radius: 6px; cursor: pointer; }
.roles button.active { background: #fff; color: #12263f; border-color: #fff; }
main { padding: 20px 24px; }
.placeholder { background: #fff; border: 1px dashed #b8c2d1; border-radius: 8px; padding: 32px; color: #55637a; }
</style>
<header>
  <div class="brand">CQA</div>
  <nav></nav>
  <div class="roles"><span>Role</span><span class="role-buttons"></span></div>
</header>
<main></main>
`;

class CqaApp extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.appendChild(template.content.cloneNode(true));
    this.role = ROLES[0];
    try {
      const saved = window.localStorage.getItem("cqa.role");
      if (ROLES.includes(saved)) this.role = saved;
    } catch (err) {
      this.role = ROLES[0];
    }
    this.onHash = () => this.render();
  }

  connectedCallback() {
    window.addEventListener("hashchange", this.onHash);
    this.render();
  }

  disconnectedCallback() {
    window.removeEventListener("hashchange", this.onHash);
  }

  route() {
    const hash = window.location.hash.replace(/^#/, "") || "/conversations";
    const parts = hash.split("/").filter(Boolean);
    if (parts[0] === "conversations" && parts[1]) {
      return { name: "conversation", id: parts[1] };
    }
    return { name: "conversations" };
  }

  setRole(role) {
    this.role = role;
    try {
      window.localStorage.setItem("cqa.role", role);
    } catch (err) {
      this.role = role;
    }
    this.render();
  }

  renderChrome(route) {
    const nav = this.shadowRoot.querySelector("nav");
    nav.innerHTML = "";
    const link = document.createElement("a");
    link.href = "#/conversations";
    link.textContent = "Conversations";
    if (route.name === "conversations" || route.name === "conversation") link.className = "active";
    nav.appendChild(link);

    const holder = this.shadowRoot.querySelector(".role-buttons");
    holder.innerHTML = "";
    for (const role of ROLES) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = role === "QA" ? "QA user" : "Reviewer";
      button.dataset.role = role;
      if (role === this.role) button.className = "active";
      button.addEventListener("click", () => this.setRole(role));
      holder.appendChild(button);
    }
  }

  render() {
    const route = this.route();
    this.renderChrome(route);
    const main = this.shadowRoot.querySelector("main");
    const key = route.name + ":" + (route.id || "");
    if (route.name === "conversations") {
      let list = main.querySelector("cqa-conversations-list");
      if (!list) {
        main.innerHTML = "";
        list = document.createElement("cqa-conversations-list");
        main.appendChild(list);
      }
      list.setAttribute("role", this.role);
      this.currentKey = key;
      return;
    }
    if (this.currentKey === key) return;
    this.currentKey = key;
    main.innerHTML = "";
    const box = document.createElement("div");
    box.className = "placeholder";
    box.textContent = "Conversation " + route.id + ": the conversation card is not available yet.";
    const back = document.createElement("div");
    const anchor = document.createElement("a");
    anchor.href = "#/conversations";
    anchor.textContent = "Back to the list";
    back.appendChild(anchor);
    box.appendChild(back);
    main.appendChild(box);
  }
}

customElements.define("cqa-app", CqaApp);
