var v = acquireVsCodeApi();
var sel = new Set();
var anchorRow = null;
var sortKey = "name",
  sortAsc = true;
var _totFiles = 0,
  _totDirs = 0;

function getPath(el) {
  return el.closest(".rw").dataset.path;
}

function parentRow(el) {
  var g = el.parentElement;
  while (g && g !== document.body) {
    if (g.classList.contains("grp")) {
      var p = g.previousElementSibling;
      if (p && p.classList.contains("rw") && p.classList.contains("dir")) return p;
    }
    g = g.parentElement;
  }
  return null;
}

function getAllDescendants(el) {
  var result = [],
    grp = el.nextElementSibling;
  if (!grp || !grp.classList.contains("grp")) return result;
  var kids = grp.querySelectorAll(".rw");
  for (var i = 0; i < kids.length; i++) result.push(kids[i]);
  return result;
}

function dedupPaths(s) {
  var arr = [...s],
    result = [];
  for (var i = 0; i < arr.length; i++) {
    var p = arr[i],
      parts = p.replace(/\\/g, "/").split("/"),
      covered = false;
    for (var j = parts.length - 2; j >= 0; j--) {
      if (s.has(parts.slice(0, j + 1).join("/"))) {
        covered = true;
        break;
      }
    }
    if (!covered) result.push(p);
  }
  return result;
}

function selectionBreakdown() {
  var dirs = 0,
    files = 0;
  var ps = dedupPaths(sel);
  for (var i = 0; i < ps.length; i++) {
    var row = document.querySelector('.rw[data-path="' + cssEsc(ps[i]) + '"]');
    if (!row) continue;
    if (row.classList.contains("dir")) {
      dirs++;
      var kids = getAllDescendants(row);
      for (var j = 0; j < kids.length; j++) {
        if (kids[j].classList.contains("dir")) dirs++;
        else files++;
      }
    } else {
      files++;
    }
  }
  return { dirs: dirs, files: files };
}

function cssEsc(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function updateUI() {
  var all = document.querySelectorAll(".rw");
  for (var i = 0; i < all.length; i++) {
    var el = all[i],
      p = getPath(el),
      ck = el.querySelector(".ck");
    var on = sel.has(p);
    ck.classList.toggle("on", on);
    ck.classList.toggle("part", false);
    el.classList.toggle("sel", on);
  }
  var dirs = document.querySelectorAll(".rw.dir");
  for (var i = 0; i < dirs.length; i++) {
    var d = dirs[i],
      dp = getPath(d);
    if (sel.has(dp)) continue;
    var kids = getAllDescendants(d);
    if (!kids.length) continue;
    var any = false,
      all2 = true;
    for (var j = 0; j < kids.length; j++) {
      if (sel.has(getPath(kids[j]))) any = true;
      else all2 = false;
    }
    if (any && all2) {
      d.querySelector(".ck").classList.add("on");
      d.classList.add("sel");
    } else if (any) {
      d.querySelector(".ck").classList.add("part");
    }
  }
  var bd = selectionBreakdown(),
    parts = [];
  parts.push(bd.files + "/" + _totFiles + " files");
  parts.push(bd.dirs + "/" + _totDirs + " dirs");
  document.getElementById("cnt").textContent = parts.join("  ");
  document.getElementById("bSel").disabled = bd.dirs + bd.files === 0;
  document.getElementById("bDel").disabled = bd.dirs + bd.files === 0;
}

function toggleRow(el) {
  var p = getPath(el);
  anchorRow = el;
  if (sel.has(p)) {
    sel.delete(p);
    unselDescendants(el);
  } else {
    sel.add(p);
    var prw = parentRow(el);
    if (prw) {
      var pp = getPath(prw);
      if (sel.has(pp)) {
        sel.delete(pp);
        var ds = getAllDescendants(prw);
        for (var i = 0; i < ds.length; i++) sel.add(getPath(ds[i]));
      }
    }
    selDescendants(el);
  }
  updateUI();
}

function selRange(fromEl, toEl) {
  var rows = document.querySelectorAll(".rw");
  var a = Array.prototype.indexOf.call(rows, fromEl),
    b = Array.prototype.indexOf.call(rows, toEl);
  if (a < 0 || b < 0) return;
  if (a > b) {
    var t = a;
    a = b;
    b = t;
  }
  for (var i = a; i <= b; i++) {
    var r = rows[i],
      p = getPath(r);
    if (!sel.has(p)) sel.add(p);
  }
}

function selDescendants(el) {
  var kids = getAllDescendants(el);
  for (var i = 0; i < kids.length; i++) sel.add(getPath(kids[i]));
}
function unselDescendants(el) {
  var kids = getAllDescendants(el);
  for (var i = 0; i < kids.length; i++) sel.delete(getPath(kids[i]));
}

function selOne(e) {
  e.stopPropagation();
  toggleRow(e.currentTarget.closest(".rw"));
}

function selRow(e, el) {
  if (e.target.closest(".cb")) return;
  if (e.shiftKey && anchorRow) {
    selRange(anchorRow, el);
    updateUI();
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    toggleRow(el);
  } else {
    sel.clear();
    var all = document.querySelectorAll(".rw");
    for (var i = 0; i < all.length; i++) {
      all[i].classList.remove("sel");
      all[i].querySelector(".ck").classList.remove("on", "part");
    }
    toggleRow(el);
  }
  updateUI();
}

function togDir(e, el) {
  if (e.ctrlKey || e.metaKey || e.shiftKey) {
    selRow(e, el);
    return;
  }
  var nx = el.nextElementSibling;
  if (!nx || !nx.classList.contains("grp")) return;
  var ar = el.querySelector(".ar"),
    hd = nx.style.display !== "none";
  nx.style.display = hd ? "none" : "";
  if (ar) ar.textContent = hd ? "\u25B6" : "\u25BC";
}

// ── Toolbar actions ──────────────────────────────────────────────

function extAll() {
  document.getElementById("s").className = "st";
  document.getElementById("s").textContent = "Extracting all files\u2026";
  v.postMessage({ c: "extAll" });
}

function testArchive() {
  document.getElementById("s").className = "st";
  document.getElementById("s").textContent = "Testing archive integrity\u2026";
  v.postMessage({ c: "test" });
}

function extSel() {
  var ps = dedupPaths(sel);
  if (!ps.length) return;
  var flat = true;
  var dirs = document.querySelectorAll(".rw.dir");
  for (var i = 0; i < dirs.length; i++) {
    if (sel.has(getPath(dirs[i]))) {
      flat = false;
      break;
    }
  }
  document.getElementById("s").className = "st";
  document.getElementById("s").textContent = "Extracting " + ps.length + " item(s)\u2026";
  v.postMessage({ c: "extSel", paths: ps, flat: flat });
}

function delSel() {
  var ps = dedupPaths(sel);
  if (!ps.length) return;
  setLoading(true);
  document.getElementById("s").className = "st";
  document.getElementById("s").textContent = "Deleting " + ps.length + " item(s)\u2026";
  v.postMessage({ c: "delSel", paths: ps });
}

function setLoading(on) {
  var o = document.getElementById("loading");
  if (on) {
    if (!o) {
      o = document.createElement("div");
      o.id = "loading";
      o.innerHTML =
        "<div style=text-align:center;padding:40px;color:var(--vscode-descriptionForeground)><div class=sp style=margin:0 auto 10px></div>Working\u2026</div>";
      o.style.cssText =
        "position:fixed;inset:0;z-index:998;background:var(--vscode-sideBar-background);display:flex;align-items:center;justify-content:center";
      document.body.appendChild(o);
    }
    o.style.display = "flex";
    document.getElementById("bSel").disabled = true;
    document.getElementById("bDel").disabled = true;
  } else {
    if (o) o.style.display = "none";
    document.getElementById("bSel").disabled = false;
    document.getElementById("bDel").disabled = false;
  }
}

function expandAll() {
  var grps = document.querySelectorAll(".grp"),
    ars = document.querySelectorAll(".rw.dir .ar");
  for (var i = 0; i < grps.length; i++) grps[i].style.display = "";
  for (var i = 0; i < ars.length; i++) {
    var p = ars[i].parentElement;
    if (p.nextElementSibling && p.nextElementSibling.classList.contains("grp"))
      ars[i].textContent = "\u25BC";
  }
}
function collapseAll() {
  var grps = document.querySelectorAll(".grp"),
    ars = document.querySelectorAll(".rw.dir .ar");
  for (var i = 0; i < grps.length; i++) grps[i].style.display = "none";
  for (var i = 0; i < ars.length; i++) ars[i].textContent = "\u25B6";
}

// ── Sort ─────────────────────────────────────────────────────────

function doSort(key) {
  if (sortKey === key) {
    sortAsc = !sortAsc;
  } else {
    sortKey = key;
    sortAsc = true;
  }
  document.getElementById("sortName").className = "sort-lbl" + (sortKey === "name" ? " on" : "");
  document.getElementById("sortSize").className = "sort-lbl" + (sortKey === "size" ? " on" : "");
  var grps = document.querySelectorAll(".grp");
  for (var i = 0; i < grps.length; i++) {
    var children = [],
      el = grps[i];
    // Gather immediate .rw children after this grp's parent dir
    var allKids = el.querySelectorAll(":scope > .rw");
    for (var j = 0; j < allKids.length; j++) children.push(allKids[j]);
    children.sort(function (a, b) {
      var av = a.dataset[key] || "",
        bv = b.dataset[key] || "";
      if (key === "size") {
        av = parseInt(av) || 0;
        bv = parseInt(bv) || 0;
      }
      var cmp = av < bv ? -1 : av > bv ? 1 : 0;
      if (cmp === 0) cmp = (a.dataset.name || "").localeCompare(b.dataset.name || "");
      return sortAsc ? cmp : -cmp;
    });
    // Dirs before files
    children.sort(function (a, b) {
      var ad = a.classList.contains("dir") ? 0 : 1,
        bd = b.classList.contains("dir") ? 0 : 1;
      // Stable sort: preserve order from previous sort
      return ad - bd;
    });
    for (var j = 0; j < children.length; j++) el.appendChild(children[j]);
  }
  // Also sort top-level rows under .tree
  var tree = document.querySelector(".tree");
  if (tree) {
    var top = [];
    for (var j = 0; j < tree.children.length; j++) {
      var c = tree.children[j];
      if (c.classList.contains("rw")) top.push(c);
    }
    top.sort(function (a, b) {
      var av = a.dataset[key] || "",
        bv = b.dataset[key] || "";
      if (key === "size") {
        av = parseInt(av) || 0;
        bv = parseInt(bv) || 0;
      }
      var cmp = av < bv ? -1 : av > bv ? 1 : 0;
      if (cmp === 0) cmp = (a.dataset.name || "").localeCompare(b.dataset.name || "");
      return sortAsc ? cmp : -cmp;
    });
    top.sort(function (a, b) {
      var ad = a.classList.contains("dir") ? 0 : 1,
        bd = b.classList.contains("dir") ? 0 : 1;
      return ad - bd;
    });
    // Collect groups that follow rows
    var ordered = [];
    for (var j = 0; j < top.length; j++) {
      ordered.push(top[j]);
      var g = top[j].nextElementSibling;
      if (g && g.classList.contains("grp")) ordered.push(g);
    }
    tree.innerHTML = "";
    for (var j = 0; j < ordered.length; j++) tree.appendChild(ordered[j]);
  }
  var lbl = document.getElementById("sortLbl");
  if (lbl) lbl.textContent = sortKey + " " + (sortAsc ? "\u2191" : "\u2193");
}

// ── Preview ──────────────────────────────────────────────────────

function previewFile(el) {
  var p = getPath(el);
  if (el.classList.contains("dir")) {
    togDir({}, el);
    return;
  }
  v.postMessage({ c: "preview", path: p });
}

// ── Search ───────────────────────────────────────────────────────

function fuzzyMatch(s, q) {
  var qi = 0,
    ql = q.length;
  for (var i = 0; i < s.length && qi < ql; i++) {
    if (s[i] === q[qi]) qi++;
  }
  return qi === ql;
}

function doSearch(v) {
  var raw = v.trim();
  var isRegex = raw.length > 2 && raw[0] === "/" && raw.lastIndexOf("/") === raw.length - 1;
  var q = isRegex ? raw.slice(1, -1) : raw.toLowerCase();
  var allNm = document.querySelectorAll(".nm");
  for (var i = 0; i < allNm.length; i++) {
    if (allNm[i].dataset.orig) allNm[i].textContent = allNm[i].dataset.orig;
  }
  if (!raw) {
    var allRows2 = document.querySelectorAll(".rw");
    for (var i = 0; i < allRows2.length; i++) allRows2[i].style.display = "";
    var allGrps2 = document.querySelectorAll(".grp");
    for (var i = 0; i < allGrps2.length; i++)
      allGrps2[i].style.display = allGrps2[i].dataset.wasOpen || "";
    return;
  }
  var matchSet = new Set(),
    allRows = document.querySelectorAll(".rw");
  for (var i = 0; i < allRows.length; i++) {
    var el = allRows[i],
      nm = el.querySelector(".nm");
    var name = nm ? nm.textContent : "",
      p = getPath(el),
      hit = false;
    if (isRegex) {
      try {
        var re = new RegExp(q, "i");
        if (re.test(name) || re.test(p)) hit = true;
      } catch {}
    } else {
      if (fuzzyMatch(name.toLowerCase(), q) || fuzzyMatch(p.toLowerCase(), q)) hit = true;
    }
    if (hit) {
      matchSet.add(el);
      if (nm) {
        if (!nm.dataset.orig) nm.dataset.orig = nm.textContent;
        var txt = nm.dataset.orig;
        if (isRegex) {
          try {
            var re2 = new RegExp("(" + q + ")", "gi");
            nm.innerHTML = escHtml(txt).replace(re2, "<mark>$1</mark>");
          } catch (e) {
            nm.textContent = txt;
          }
        } else {
          var lower = txt.toLowerCase(),
            pos = [],
            qi = 0;
          for (var ci = 0; ci < lower.length && qi < q.length; ci++) {
            if (lower[ci] === q[qi]) {
              pos.push(ci);
              qi++;
            }
          }
          var result = "",
            last = 0;
          for (var pi = 0; pi < pos.length; pi++) {
            result +=
              escHtml(txt.substring(last, pos[pi])) +
              "<mark>" +
              escHtml(txt.charAt(pos[pi])) +
              "</mark>";
            last = pos[pi] + 1;
          }
          nm.innerHTML = result + escHtml(txt.substring(last));
        }
      }
    }
  }
  var keep = new Set(matchSet);
  var it = matchSet.values(),
    nxt;
  while ((nxt = it.next()) && !nxt.done) {
    var prw = parentRow(nxt.value);
    while (prw) {
      keep.add(prw);
      prw = parentRow(prw);
    }
  }
  for (var i = 0; i < allRows.length; i++)
    allRows[i].style.display = keep.has(allRows[i]) ? "" : "none";
  var grps = document.querySelectorAll(".grp");
  for (var i = 0; i < grps.length; i++) {
    var prev = grps[i].previousElementSibling;
    grps[i].style.display = prev && keep.has(prev) ? "" : "none";
    if (prev) {
      var ar = prev.querySelector(".ar");
      if (ar) ar.textContent = keep.has(prev) ? "\u25BC" : "\u25B6";
    }
  }
}

function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Messages ─────────────────────────────────────────────────────

window.addEventListener("message", function (e) {
  var s = document.getElementById("s");
  if (e.data.c === "ok") {
    setLoading(false);
    s.className = "st ok";
    s.textContent = e.data.t;
  } else if (e.data.c === "err") {
    setLoading(false);
    s.className = "st er";
    s.textContent = e.data.t;
  } else if (e.data.c === "del-ok") {
    setLoading(false);
    s.className = "st ok";
    s.textContent = e.data.t;
  } else if (e.data.c === "props") {
    _totFiles = e.data.files;
    _totDirs = e.data.dirs;
    var p = document.getElementById("props");
    if (p)
      p.innerHTML =
        "<b>" +
        escHtml(e.data.name) +
        "</b><br>" +
        "Format: <b>" +
        escHtml(e.data.format) +
        "</b> | " +
        "Items: <b>" +
        e.data.count +
        "</b> | " +
        "Files: <b>" +
        e.data.files +
        "</b> | " +
        "Dirs: <b>" +
        e.data.dirs +
        "</b> | " +
        "Size: <b>" +
        escHtml(e.data.size) +
        "</b>";
  } else if (e.data.c === "log") {
    v.postMessage({ c: "log", msg: e.data.msg });
  }
});

// ── Keyboard ─────────────────────────────────────────────────────

document.addEventListener("keydown", function (e) {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if ((e.ctrlKey || e.metaKey) && e.key === "a") {
    e.preventDefault();
    var all = document.querySelectorAll(".rw");
    for (var i = 0; i < all.length; i++) sel.add(getPath(all[i]));
    updateUI();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "c" && sel.size > 0) {
    e.preventDefault();
    var ps = dedupPaths(sel),
      flat = true,
      dirs = document.querySelectorAll(".rw.dir");
    for (var i = 0; i < dirs.length; i++) {
      if (sel.has(getPath(dirs[i]))) {
        flat = false;
        break;
      }
    }
    v.postMessage({ c: "copy", paths: ps, flat: flat });
    showToast("Copied " + ps.length + " item(s)", true);
  }
  if (e.key === "Enter" && sel.size > 0) {
    e.preventDefault();
    extSel();
  }
  if (e.key === "Escape") {
    sel.clear();
    updateUI();
  }
  if (e.key === " " && anchorRow) {
    e.preventDefault();
    toggleRow(anchorRow);
  }
  if (e.key === "Delete" && sel.size > 0) {
    e.preventDefault();
    delSel();
  }
  if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    var rows = Array.prototype.filter.call(document.querySelectorAll(".rw"), function (r) {
      return r.style.display !== "none";
    });
    if (!rows.length) return;
    var idx = anchorRow ? Array.prototype.indexOf.call(rows, anchorRow) : -1;
    if (idx < 0) idx = 0;
    if (e.key === "ArrowDown") idx = Math.min(idx + 1, rows.length - 1);
    else idx = Math.max(idx - 1, 0);
    anchorRow = rows[idx];
    anchorRow.scrollIntoView({ block: "nearest" });
    if (!e.shiftKey) {
      sel.clear();
      updateUI();
    }
    toggleRow(anchorRow);
  }
});

// ── Double-click → preview ───────────────────────────────────────

document.addEventListener("dblclick", function (e) {
  var el = e.target.closest(".rw");
  if (el && !e.target.closest(".cb")) previewFile(el);
});

// ── Context menu ─────────────────────────────────────────────────

document.addEventListener("contextmenu", function (e) {
  if (sel.size > 0) {
    e.preventDefault();
    var el = e.target.closest(".rw");
    var dirPath = "";
    if (el) {
      if (el.classList.contains("dir")) dirPath = getPath(el);
      else {
        var p = getPath(el);
        var i = p.lastIndexOf("/");
        dirPath = i > 0 ? p.substring(0, i) : "";
      }
    }
    var ps = dedupPaths(sel);
    showCtxMenu(e.clientX, e.clientY, ps, dirPath);
  }
});

// ── Context menu ─────────────────────────────────────────────────

function showCtxMenu(x, y, ps, dirPath) {
  var m = document.getElementById("ctxmenu");
  if (!m) {
    m = document.createElement("div");
    m.id = "ctxmenu";
    m.style.cssText =
      "position:fixed;z-index:1000;background:var(--vscode-menu-background,var(--vscode-sideBar-background));border:1px solid var(--vscode-menu-border,var(--vscode-sideBarSectionHeader-border));border-radius:3px;padding:2px 0;min-width:160px;font-size:calc(var(--vscode-font-size)*0.92);box-shadow:0 2px 8px rgba(0,0,0,.2)";
    document.body.appendChild(m);
  }
  m.style.left = x + "px";
  m.style.top = y + "px";
  m.style.display = "";
  m.innerHTML =
    '<div class=cmi onclick="ctxCopy()">Copy</div>' +
    '<div class=cmi onclick="ctxExt()">Extract Selected</div>' +
    '<div class=cmi onclick="ctxDel()">Delete</div>' +
    '<div class=cmi style="color:var(--vscode-descriptionForeground)">' +
    ps.length +
    " item(s)</div>";
  window._ctxPs = ps;
  window._ctxDir = dirPath;
  function hide(e) {
    var m = document.getElementById("ctxmenu");
    if (m && !m.contains(e.target)) {
      m.style.display = "none";
      document.removeEventListener("mousedown", hide, true);
    }
  }
  document.addEventListener("mousedown", hide, true);
}
function ctxCopy() {
  var ps = window._ctxPs;
  if (!ps) return;
  document.getElementById("ctxmenu").style.display = "none";
  var flat = true,
    dirs = document.querySelectorAll(".rw.dir");
  for (var i = 0; i < dirs.length; i++) {
    if (sel.has(getPath(dirs[i]))) {
      flat = false;
      break;
    }
  }
  v.postMessage({ c: "copy", paths: ps, flat: flat });
  showToast("Copied " + ps.length + " item(s)", true);
}
function ctxExt() {
  document.getElementById("ctxmenu").style.display = "none";
  extSel();
}
function ctxDel() {
  document.getElementById("ctxmenu").style.display = "none";
  delSel();
}

// ── Toast ────────────────────────────────────────────────────────

function showToast(msg, ok) {
  var t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.style.cssText =
      "position:fixed;top:12px;left:50%;transform:translateX(-50%);padding:6px 20px;border-radius:4px;font-size:calc(var(--vscode-font-size)*0.92);z-index:999;pointer-events:none;transition:opacity .3s;opacity:0";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.background = ok
    ? "var(--vscode-terminal-ansiGreen)"
    : "var(--vscode-inputValidation-errorBackground)";
  t.style.color = ok
    ? "var(--vscode-editor-background)"
    : "var(--vscode-inputValidation-errorForeground)";
  t.style.opacity = "1";
  clearTimeout(t._tid);
  t._tid = setTimeout(function () {
    t.style.opacity = "0";
  }, 1800);
}
