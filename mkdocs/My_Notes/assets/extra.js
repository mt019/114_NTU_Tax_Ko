(function () {
  // 取得右側 TOC 的可滾動容器
  function getTocScroller() {
    const side = document.querySelector(".md-sidebar--secondary");
    if (!side) return null;
    return (
      side.querySelector(".md-sidebar__scrollwrap") ||
      side.querySelector(".md-sidebar__inner") ||
      side
    );
  }

  // 取得當前 active 的 TOC 鏈接
  function getActiveLink(scroller) {
    if (!scroller) return null;
    return (
      scroller.querySelector(".md-nav__link--active") ||
      (function () {
        const li = scroller.querySelector(".md-nav__item--active > a.md-nav__link");
        return li || null;
      })()
    );
  }

  // 若 active 超出可視範圍，將其捲至中間
  function ensureActiveVisible() {
    const scroller = getTocScroller();
    const active = getActiveLink(scroller);
    if (!scroller || !active) return;

    const a = active.getBoundingClientRect();
    const c = scroller.getBoundingClientRect();
    const pad = 12; // 上下緩衝

    const outAbove = a.top < c.top + pad;
    const outBelow = a.bottom > c.bottom - pad;

    if (outAbove || outBelow) {
      const delta = (a.top - c.top) - (c.height / 2 - a.height / 2);
      scroller.scrollTo({ top: scroller.scrollTop + delta, behavior: "smooth" });
    }
  }

  // 用 rAF 節流，避免頻繁觸發
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      ensureActiveVisible();
    });
  }

  // 綁定：頁面滾動時檢查（Material 以 IntersectionObserver 改 active）
  window.addEventListener("scroll", schedule, { passive: true });

  // 綁定：右側 TOC 結構或 active class 變化時檢查
  function bindObserver() {
    const scroller = getTocScroller();
    if (!scroller) return;
    const nav = scroller.querySelector(".md-nav--secondary") || scroller;
    const mo = new MutationObserver(schedule);
    mo.observe(nav, { subtree: true, attributes: true, attributeFilter: ["class"] });
  }

  // 初次與延遲嘗試（應對 SPA 導航與延遲掛載）
  document.addEventListener("DOMContentLoaded", () => {
    schedule();
    bindObserver();
    // 再保險：首秒多次嘗試
    let tries = 6;
    const id = setInterval(() => {
      schedule();
      bindObserver();
      if (--tries <= 0) clearInterval(id);
    }, 200);
  });

  // Material 的即時導航事件（若啟用 navigation.instant 時更穩）
  document.addEventListener("navigation", schedule);
})();

(function () {
  const STORAGE_KEY = "md-nav-all-toc";

  function isEnabled() {
    return localStorage.getItem(STORAGE_KEY) === "1";
  }

  function setEnabled(val) {
    localStorage.setItem(STORAGE_KEY, val ? "1" : "0");
  }

  function getPrimarySidebar() {
    return document.querySelector(".md-sidebar--primary");
  }

  function getPrimaryInner() {
    const side = getPrimarySidebar();
    if (!side) return null;
    return (
      side.querySelector(".md-sidebar__scrollwrap") ||
      side.querySelector(".md-sidebar__inner") ||
      side
    );
  }

  function ensureToggleButton() {
    const inner = getPrimaryInner();
    if (!inner) return;
    let btn = inner.querySelector(".md-nav__toggle-all");
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "md-nav__toggle-all";
      btn.addEventListener("click", () => {
        setEnabled(!isEnabled());
        updateButtonState(btn);
        refreshAllToc();
      });
      inner.prepend(btn);
    }
    updateButtonState(btn);
  }

  function updateButtonState(btn) {
    btn.textContent = isEnabled() ? "隐藏小标题" : "显示小标题";
    btn.setAttribute("aria-pressed", isEnabled() ? "true" : "false");
  }

  function clearInjected() {
    document
      .querySelectorAll(".md-nav__list--alltoc, .md-nav--injected")
      .forEach((el) => el.remove());
    document
      .querySelectorAll(".md-nav__item[data-alltoc-injected='1']")
      .forEach((li) => li.removeAttribute("data-alltoc-injected"));
  }

  function getPageLinks() {
    const nav = getPrimarySidebar();
    if (!nav) return [];
    return Array.from(
      nav.querySelectorAll("a.md-nav__link[href]:not([href^='#'])")
    );
  }

  function isCurrentPage(link) {
    try {
      const a = new URL(link.href, location.origin);
      const b = new URL(location.href);
      return a.pathname === b.pathname;
    } catch (_) {
      return false;
    }
  }

  function extractH2Headings(doc) {
    const container =
      doc.querySelector(".md-content") ||
      doc.querySelector("article") ||
      doc;
    return Array.from(container.querySelectorAll("h2[id]")).map((h) => ({
      id: h.id,
      text: h.textContent.trim(),
    }));
  }

  function buildInjectedNav(headings, pageHref) {
    const nav = document.createElement("nav");
    nav.className = "md-nav md-nav--secondary md-nav--injected";
    const ul = document.createElement("ul");
    ul.className = "md-nav__list md-nav__list--alltoc";
    headings.forEach((h) => {
      if (!h.text) return;
      const li = document.createElement("li");
      li.className = "md-nav__item";
      const a = document.createElement("a");
      a.className = "md-nav__link";
      a.href = `${pageHref}#${encodeURIComponent(h.id)}`;
      a.textContent = h.text;
      li.appendChild(a);
      ul.appendChild(li);
    });
    nav.appendChild(ul);
    return nav;
  }

  async function fetchHeadingsForLink(link) {
    const href = link.href;
    const res = await fetch(href, { credentials: "same-origin" });
    if (!res.ok) return [];
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    return extractH2Headings(doc);
  }

  async function withConcurrency(items, limit, worker) {
    const queue = items.slice();
    const running = [];
    async function runOne() {
      if (!queue.length) return;
      const item = queue.shift();
      const p = worker(item);
      running.push(p);
      try {
        await p;
      } finally {
        running.splice(running.indexOf(p), 1);
      }
      await runOne();
    }
    for (let i = 0; i < Math.min(limit, queue.length); i++) {
      await runOne();
    }
    await Promise.all(running);
  }

  async function refreshAllToc() {
    clearInjected();
    if (!isEnabled()) return;

    const links = getPageLinks().filter((a) => !isCurrentPage(a));
    await withConcurrency(links, 4, async (link) => {
      const li = link.closest(".md-nav__item");
      if (!li || li.getAttribute("data-alltoc-injected") === "1") return;
      let headings = [];
      try {
        headings = await fetchHeadingsForLink(link);
      } catch (_) {
        headings = [];
      }
      if (!headings.length) return;
      const nav = buildInjectedNav(headings, link.href);
      li.appendChild(nav);
      li.setAttribute("data-alltoc-injected", "1");
    });
  }

  function init() {
    ensureToggleButton();
    refreshAllToc();
  }

  document.addEventListener("DOMContentLoaded", () => {
    init();
    let tries = 6;
    const id = setInterval(() => {
      init();
      if (--tries <= 0) clearInterval(id);
    }, 200);
  });

  document.addEventListener("navigation", init);
})();
