(function () {
  "use strict";
  const L = window.InvestmentLedger;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = n => "¥ " + (n / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rawMoney = n => (n / 100).toFixed(2);
  const sum = amounts => L.IDS.reduce((s, id) => s + amounts[id], 0);
  const nameOf = id => L.ASSETS.find(a => a.id === id)?.name || "";
  const allActive = () => L.mapAssets(() => true);
  const pad = n => String(n).padStart(2, "0");
  const dateInput = time => { const d = new Date(time); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const timeInput = time => { const d = new Date(time); return `${dateInput(time)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const shortDate = time => time ? new Date(time).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) : "未更新";
  const fullDate = time => new Date(time).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const uid = () => window.crypto.randomUUID();
  const labels = { buy: "买入", sell: "卖出", deposit: "资金转入", withdraw: "资金取出", income: "分红 / 利息", expense: "独立费用", valuation: "更新市值" };
  let data = L.createData(), panel = null, saving = false, historyLimit = 20, storageBlocked = false;

  function notice(message, error = false) {
    $("notice").textContent = message;
    $("notice").className = "notice" + (error ? " error" : "");
    $("notice").hidden = false;
  }
  function formError(message = "") {
    $("form-error").textContent = message;
    $("form-error").hidden = !message;
  }
  function persist(next, recovering = false) {
    if (storageBlocked && !recovering) throw new Error("原账本读取失败。请先导出原始数据，或导入有效备份，避免覆盖原账本。");
    const validated = L.validateData(next);
    // Write a single complete document before changing the in-memory state.
    window.localStorage.setItem(L.STORAGE_KEY, JSON.stringify(validated));
    data = validated;
    storageBlocked = false;
    renderHome();
  }
  function renderHome() {
    const state = L.replay(data.entries);
    $("total-assets").textContent = fmt(state.assets);
    $("invested").textContent = fmt(state.invested);
    $("cash").textContent = fmt(state.cash);
    $("market-value").textContent = fmt(state.marketValue);
    $("capital-detail").textContent = `转入 ${fmt(state.deposits)} · 取出 ${fmt(state.withdrawals)}`;
    $("profit").textContent = (state.profit > 0 ? "+" : state.profit < 0 ? "−" : "") + fmt(Math.abs(state.profit));
    $("profit").className = state.profit > 0 ? "positive" : state.profit < 0 ? "negative" : "";
    $("profit-badge").hidden = !state.estimated;
    const times = L.IDS.map(id => state.market[id].at).filter(Boolean);
    const oldest = times.length ? Math.min(...times) : null;
    $("market-status").textContent = !times.length ? "暂无持仓" : `${state.estimated ? "含交易后估算" : "已手动确认"} · ${shortDate(oldest)} 起更新`;
    $("profit-status").textContent = state.estimated ? "含估算市值，更新后可确认盈亏" : oldest ? `市值 ${shortDate(oldest)} 起更新 · 非实时` : "市值 + 现金 − 净投入";
    $("holdings").innerHTML = L.ASSETS.map(a => {
      const m = state.market[a.id], share = state.assets > 0 ? (m.value / state.assets * 100).toFixed(1) : "0.0";
      const status = m.at ? `${m.estimated ? "估算 · " : ""}${shortDate(m.at)} 更新` : "暂无持仓";
      return `<div class="asset-row"><div class="asset-name"><i class="asset-dot" style="background:${a.color}"></i><div><b>${a.name}</b><small>${status}</small></div></div><div class="asset-money">${fmt(m.value)}<small>${share}%</small></div></div>`;
    }).join("");
    const w = data.settings.weights, pe = data.settings.pe;
    $("plan-summary").textContent = `常用分配 · A500 ${w.a500}% / 标普 ${w.sp500}% / 黄金 5% / BTC 5%`;
    $("pe-summary").textContent = pe ? `A500 PE 分位 ${pe.value}% · ${shortDate(pe.at)} 填写` : "A500 PE 分位未填写";
    $("undo-delete").hidden = !data.undo;
    try { $("recover").hidden = !window.localStorage.getItem(L.RECOVERY_KEY); } catch { $("recover").hidden = true; }
    renderHistory(state);
  }
  function detailLine(label, value) { return `<div class="detail-line"><span>${esc(label)}</span><span>${esc(value)}</span></div>`; }
  function renderHistory(state) {
    const entries = L.ordered(data.entries).reverse();
    $("history-count").textContent = entries.length ? `${entries.length} 笔` : "";
    $("load-more").hidden = entries.length <= historyLimit;
    if (!entries.length) {
      $("history").innerHTML = '<div class="empty"><b>从第一笔资金开始</b><p>记一笔买入，或者先把资金转入现金。</p></div>';
      return;
    }
    $("history").innerHTML = entries.slice(0, historyLimit).map(e => {
      const c = e.context, b = state.balances[e.id];
      let title = labels[e.kind], subtitle = "", value = e.amount, details = "";
      if (e.kind === "buy") {
        title = e.source === "new" ? "转入并买入" : "使用现金买入";
        subtitle = L.ASSETS.filter(a => e.amounts[a.id] > 0).map(a => a.name).join(" · ");
        value = sum(e.amounts);
        details += detailLine(e.source === "new" ? "本次转入" : "本次预算", fmt(e.budget));
        L.ASSETS.filter(a => e.amounts[a.id] > 0).forEach(a => { details += detailLine(`买入 ${a.name}`, fmt(e.amounts[a.id])); });
        details += detailLine("本次留现金", fmt(e.budget - value));
      } else if (e.kind === "sell") {
        title = `${e.full ? "清仓" : "卖出"} ${nameOf(e.asset)}`;
        subtitle = "实际到账";
      } else if (e.kind === "valuation") {
        value = sum(e.values); subtitle = "确认四项市值";
        L.ASSETS.forEach(a => { details += detailLine(a.name, fmt(e.values[a.id])); });
      }
      details += detailLine("现金变化", `${fmt(b.before)} → ${fmt(b.after)}`);
      details += '<p class="detail-heading">记录时的数据快照</p>';
      details += detailLine("常用分配", `A500 ${c.weights.a500}% · 标普 ${c.weights.sp500}% · 黄金 5% · BTC 5%`);
      details += detailLine("本次启用", L.ASSETS.filter(a => c.active[a.id]).map(a => a.name).join("、") || "全部留现金");
      details += detailLine("A500 PE 分位", c.pe ? `${c.pe.value}% · ${fullDate(c.pe.at)} 填写` : "未填写");
      L.ASSETS.forEach(a => {
        const m = c.market[a.id];
        details += detailLine(`${a.name} 最近市值`, `${fmt(m.value)} · ${m.at ? `${m.estimated ? "估算 / " : ""}${fullDate(m.at)}` : "未更新"}`);
      });
      return `<details class="history-item"><summary><span class="history-date">${shortDate(e.time)}</span><span class="history-label">${title}<small>${subtitle || fullDate(e.time)}</small></span><span class="history-amount">${fmt(value)}</span></summary><div class="history-detail">${detailLine("记录时间", fullDate(e.time))}${details}${e.note ? `<p class="detail-note">备注：${esc(e.note)}</p>` : ""}<div class="detail-actions"><button type="button" data-edit="${esc(e.id)}">编辑</button><button type="button" class="delete-button" data-delete="${esc(e.id)}">删除</button></div></div></details>`;
    }).join("");
  }
  function peFields(settings) {
    return `<div class="pe-fields"><label class="field" for="pe-value">A500 PE 历史分位 <span>选填 · %</span><input id="pe-value" type="number" inputmode="decimal" min="0" max="100" step="0.1" placeholder="未填写" value="${settings.pe ? settings.pe.value : ""}"></label><label class="field" for="pe-date">PE 填写日期<input id="pe-date" type="date" value="${dateInput(settings.pe ? settings.pe.at : Date.now())}"></label></div>`;
  }
  function extras(entry) {
    return `<details class="extra"><summary>日期与备注${entry ? " · 编辑历史记录" : ""}</summary><label class="field" for="entry-time">记录时间<input id="entry-time" type="datetime-local" value="${timeInput(entry ? entry.time : Date.now())}"></label><label class="field" for="entry-note">备注 <span>选填</span><textarea id="entry-note" maxlength="2000" placeholder="当时的想法、成交说明等">${esc(entry?.note || "")}</textarea></label></details>`;
  }
  function weightsFields(settings, active, amounts, simple = false) {
    return `<div class="buy-grid-head"><span>${simple ? "资产" : "本次买入"}</span><span>分配比例</span><span>${simple ? "" : "实际买入 / 元"}</span></div>` + L.ASSETS.map(a => {
      const checked = active[a.id], fixed = ["gold", "btc"].includes(a.id);
      return `<div class="buy-row"><label for="use-${a.id}">${simple ? "" : `<input id="use-${a.id}" type="checkbox"${checked ? " checked" : ""}>`}<i class="asset-dot" style="background:${a.color}"></i>${a.name}</label><div class="percent-field"><input id="weight-${a.id}" aria-label="${a.name}分配比例" type="number" inputmode="decimal" min="0" max="100" step="0.1" value="${settings.weights[a.id]}"${fixed ? ' readonly title="启用时默认分配 5%，本次可跳过"' : ""}></div>${simple ? '<span class="muted">常用比例</span>' : `<input id="buy-amount-${a.id}" aria-label="${a.name}实际买入金额" type="number" inputmode="decimal" min="0" step="0.01" value="${rawMoney(amounts[a.id])}"${checked ? "" : " disabled"}>`}</div>`;
    }).join("");
  }
  function openPanel(kind, entry = null) {
    formError();
    const settings = entry ? { ...L.clone(data.settings), weights: L.clone(entry.context.weights), pe: L.clone(entry.context.pe) } : L.clone(data.settings);
    panel = { kind, original: entry, id: entry ? entry.id : uid(), createdAt: entry ? entry.createdAt : Date.now(), settings };
    const titles = { buy: "记一笔买入", sell: "记一笔卖出", valuation: "更新持仓市值", cash: "其他资金收支", settings: "常用比例与 PE" };
    $("editor-title").textContent = entry ? `编辑 · ${labels[entry.kind]}` : titles[kind];
    let fields = "";
    if (kind === "buy") {
      const source = entry ? entry.source : settings.source;
      fields += `<div class="source-tabs"><label><input id="source-new" type="radio" name="source" value="new"${source === "new" ? " checked" : ""}>新增资金并买入</label><label><input id="source-cash" type="radio" name="source" value="cash"${source === "cash" ? " checked" : ""}>使用现有现金</label></div>`;
      fields += `<label class="field" for="buy-budget">本次可分配金额 / 元<input class="budget-input" id="buy-budget" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="0.00" value="${entry ? rawMoney(entry.budget) : ""}"></label><p id="available-cash" class="hint"></p>`;
      fields += weightsFields(settings, entry ? entry.context.active : allActive(), entry ? entry.amounts : L.mapAssets(() => 0));
      fields += '<p class="hint" style="margin-top:8px">取消勾选即可跳过；调整预算或比例会重新生成金额。实际成交可手动修改。</p><div class="buy-summary"><div><span>本次买入合计</span><b id="buy-total">¥ 0.00</b></div><div><span>本次留现金</span><b id="buy-cash">¥ 0.00</b></div></div><p class="hint" id="allocation-hint"></p>';
    } else if (kind === "sell") {
      fields += `<label class="field" for="sell-asset">卖出资产<select id="sell-asset">${L.ASSETS.map(a => `<option value="${a.id}"${entry?.asset === a.id ? " selected" : ""}>${a.name}</option>`).join("")}</select></label><p class="hint" id="sell-market"></p><label class="field" for="entry-amount">实际到账金额 / 元<input class="budget-input" id="entry-amount" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="0.00" value="${entry ? rawMoney(entry.amount) : ""}"></label><label class="check-line"><input id="sell-full" type="checkbox"${entry?.full ? " checked" : ""}>全部卖出，将该资产市值记为零</label><p class="hint">到账金额包含已扣手续费；部分卖出后，市值暂按金额估算。</p>`;
    } else if (kind === "valuation") {
      const market = L.before(data.entries, entry ? entry.time : Date.now(), entry?.id).market;
      fields += '<p class="hint">填写当前人民币市值，清仓资产填 0。确认后替换交易产生的估算值。</p><div class="two-fields">' + L.ASSETS.map(a => `<label class="field" for="value-${a.id}">${a.name} / 元<input id="value-${a.id}" type="number" inputmode="decimal" min="0" step="0.01" value="${rawMoney(entry ? entry.values[a.id] : market[a.id].value)}"></label>`).join("") + "</div>";
    } else if (kind === "cash") {
      fields += `<label class="field" for="cash-kind">资金类型<select id="cash-kind">${["deposit", "withdraw", "income", "expense"].map(k => `<option value="${k}"${entry?.kind === k ? " selected" : ""}>${labels[k]}</option>`).join("")}</select></label><p id="cash-kind-hint" class="hint"></p><label class="field" for="entry-amount">实际金额 / 元<input class="budget-input" id="entry-amount" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="0.00" value="${entry ? rawMoney(entry.amount) : ""}"></label>`;
    } else if (kind === "settings") {
      fields += weightsFields(settings, allActive(), L.mapAssets(() => 0), true);
      fields += '<p class="hint" style="margin-top:10px">这里只保存常用比例。每次买入时，可单独跳过任意资产；PE 仅记录，不自动调整。</p>';
    }
    fields += peFields(settings);
    if (kind !== "settings") fields += extras(entry);
    if (entry) fields += '<p class="hint">编辑只影响本笔记录；当时的市值快照保留，不修改当前常用设置。</p>';
    $("form-fields").innerHTML = fields;
    $("save-entry").textContent = kind === "settings" ? "保存设置" : entry ? "保存修改" : "保存这笔记录";
    $("save-entry").disabled = false;
    $("save-settings").hidden = kind !== "buy" || Boolean(entry);
    $("editor").hidden = false;
    if (kind === "buy") updateBuy(false);
    else refreshHints();
    $("editor").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function closePanel() { panel = null; $("editor").hidden = true; formError(); }
  function readTime() {
    const time = new Date($("entry-time").value).getTime();
    if (!Number.isSafeInteger(time) || time <= 0) throw new Error("请填写有效的记录时间");
    if (time > Date.now() + 60000) throw new Error("记录时间不能晚于现在");
    return time;
  }
  function readSettings() {
    const settings = L.clone(panel.settings);
    if (panel.kind === "buy" || panel.kind === "settings") settings.weights = L.mapAssets(a => L.percent($("weight-" + a.id).value));
    const value = $("pe-value").value;
    if (value === "") settings.pe = null;
    else {
      const v = L.percent(value), date = $("pe-date").value;
      const at = settings.pe && dateInput(settings.pe.at) === date ? settings.pe.at : new Date(date + "T12:00:00").getTime();
      if (!Number.isFinite(at)) throw new Error("请填写 PE 的填写日期");
      settings.pe = { value: v, at };
    }
    if (panel.kind === "buy") settings.source = $("source-cash").checked ? "cash" : "new";
    return settings;
  }
  function readActive() { return L.mapAssets(a => $("use-" + a.id).checked); }
  function readBuy() {
    return { id: panel.id, time: readTime(), createdAt: panel.createdAt, note: $("entry-note").value.trim(),
      budget: L.money($("buy-budget").value), source: $("source-cash").checked ? "cash" : "new",
      active: readActive(), amounts: L.mapAssets(a => $("use-" + a.id).checked ? L.money($("buy-amount-" + a.id).value, true) : 0) };
  }
  function updateBuy(regenerate) {
    if (!panel || panel.kind !== "buy") return;
    formError();
    try {
      const active = readActive();
      L.ASSETS.forEach(a => {
        $("buy-amount-" + a.id).disabled = !active[a.id];
        if (!active[a.id]) $("buy-amount-" + a.id).value = "0.00";
      });
      const settings = readSettings(), budget = L.money($("buy-budget").value, true);
      const allocation = L.allocate(budget, settings.weights, active);
      if (regenerate) L.ASSETS.forEach(a => { $("buy-amount-" + a.id).value = rawMoney(allocation.amounts[a.id]); });
      const amounts = L.mapAssets(a => active[a.id] ? L.money($("buy-amount-" + a.id).value, true) : 0);
      const total = sum(amounts), remainder = budget - total;
      $("buy-total").textContent = fmt(total);
      $("buy-cash").textContent = remainder >= 0 ? fmt(remainder) : "超出预算";
      $("allocation-hint").textContent = `本次启用 ${allocation.percent}% · 未使用的预算全部留作现金`;
      const state = L.before(data.entries, readTime(), panel.original?.id);
      $("available-cash").textContent = `该时间点可用现金 ${fmt(state.cash)}${settings.source === "new" ? " · 此次预算会计入新增投入" : " · 不增加净投入"}`;
      if (remainder < 0) throw new Error("实际买入合计不能超过本次预算");
      if (settings.source === "cash" && budget > state.cash) throw new Error("本次预算超过该时间点的可用现金");
      $("save-entry").disabled = budget <= 0;
    } catch (error) {
      formError(error.message);
      $("save-entry").disabled = true;
    }
  }
  function refreshHints() {
    if (!panel) return;
    if (panel.kind === "sell") {
      try {
        const state = L.before(data.entries, readTime(), panel.original?.id), m = state.market[$("sell-asset").value];
        $("sell-market").textContent = `当前记录市值 ${fmt(m.value)}${m.estimated ? "（估算）" : ""}，卖出按实际到账记录。`;
      } catch (error) { formError(error.message); }
    } else if (panel.kind === "cash") {
      const hints = { deposit: "从账本外转入，会增加净投入与现金。", withdraw: "从账本取出，会减少净投入与现金，不改变投资盈亏。", income: "现金分红、利息等，增加现金与盈亏，不增加投入。", expense: "单独扣除的费用，减少现金与盈亏。买卖金额中已扣的手续费不要重复记录。" };
      $("cash-kind-hint").textContent = hints[$("cash-kind").value];
    }
  }
  function saveOnlySettings() {
    try {
      const next = L.clone(data); next.settings = readSettings(); persist(next);
      formError(); notice("常用比例与 PE 已保存，历史记录不受影响。");
      if (panel.kind === "settings") closePanel();
      else panel.settings = L.clone(data.settings);
    } catch (error) { formError(error.message); }
  }
  function saveEntry(event) {
    event.preventDefault();
    if (!panel || saving) return;
    if (panel.kind === "settings") { saveOnlySettings(); return; }
    saving = true;
    $("save-entry").disabled = true;
    try {
      const settings = readSettings(), time = readTime(), original = panel.original;
      const state = L.before(data.entries, time, original?.id);
      let entry;
      if (panel.kind === "buy") entry = L.prepareBuy(readBuy(), settings, data.entries, original);
      else {
        const context = original ? L.clone(original.context) : L.snapshot(settings, allActive(), state);
        context.pe = L.clone(settings.pe);
        entry = { id: panel.id, time, createdAt: panel.createdAt, kind: panel.kind, note: $("entry-note").value.trim(), context };
        if (panel.kind === "valuation") entry.values = L.mapAssets(a => L.money($("value-" + a.id).value));
        else {
          entry.amount = L.money($("entry-amount").value);
          if (panel.kind === "sell") { entry.asset = $("sell-asset").value; entry.full = $("sell-full").checked; }
          if (panel.kind === "cash") entry.kind = $("cash-kind").value;
        }
      }
      const next = L.upsert(data, entry, Boolean(original));
      if (!original) next.settings = settings;
      persist(next);
      closePanel();
      notice(original ? "这笔记录已更新，账本已重新计算。" : entry.kind === "deposit" && panel === null ? "资金已转入现金。" : "记录已保存。");
    } catch (error) {
      formError(error.message);
      $("save-entry").disabled = false;
    } finally { saving = false; }
  }

  ["buy", "sell", "valuation", "cash", "settings"].forEach(kind => $("open-" + kind).addEventListener("click", () => openPanel(kind)));
  $("close-editor").addEventListener("click", closePanel);
  $("entry-form").addEventListener("submit", saveEntry);
  $("save-settings").addEventListener("click", saveOnlySettings);
  $("entry-form").addEventListener("input", e => {
    if (!panel) return;
    if (panel.kind === "buy") updateBuy(e.target.id === "buy-budget" || e.target.id.startsWith("weight-"));
    else formError();
  });
  $("entry-form").addEventListener("change", e => {
    if (!panel) return;
    if (panel.kind === "buy") updateBuy(e.target.id.startsWith("use-"));
    else refreshHints();
  });
  $("history").addEventListener("click", e => {
    const edit = e.target.closest("[data-edit]"), del = e.target.closest("[data-delete]");
    if (edit) {
      const entry = data.entries.find(x => x.id === edit.dataset.edit);
      if (entry) openPanel(["deposit", "withdraw", "income", "expense"].includes(entry.kind) ? "cash" : entry.kind, entry);
    } else if (del) {
      if (!window.confirm("删除这笔记录并重新计算账本？可撤销最近一次删除。")) return;
      try { persist(L.remove(data, del.dataset.delete)); closePanel(); notice("记录已删除，可点击“撤销删除”恢复。"); }
      catch (error) { notice(error.message, true); }
    }
  });
  $("undo-delete").addEventListener("click", () => {
    try { persist(L.undoDelete(data)); closePanel(); notice("已恢复删除的记录。"); }
    catch (error) { notice(error.message, true); }
  });
  $("load-more").addEventListener("click", () => { historyLimit += 20; renderHistory(L.replay(data.entries)); });
  function download(text, filename) {
    const link = document.createElement("a"), url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $("export").addEventListener("click", () => {
    try {
      const raw = storageBlocked ? window.localStorage.getItem(L.STORAGE_KEY) : JSON.stringify(data, null, 2);
      download(raw || "{}", `投资账本${storageBlocked ? "-原始数据" : ""}-${dateInput(Date.now())}.json`);
      notice("完整备份已导出，包含流水、市值和常用设置。");
    } catch (error) { notice("备份导出失败：" + error.message, true); }
  });
  $("import").addEventListener("click", () => $("import-file").click());
  function replaceWithBackup(next) {
    const prior = window.localStorage.getItem(L.STORAGE_KEY) || JSON.stringify(data);
    window.localStorage.setItem(L.RECOVERY_KEY, prior);
    persist(next, true);
    closePanel();
  }
  $("import-file").addEventListener("change", async () => {
    const file = $("import-file").files[0];
    if (!file) return;
    try {
      const next = L.validateData(JSON.parse(await file.text()));
      if (!window.confirm(`导入备份中的 ${next.entries.length} 笔记录并替换当前账本？导入前的数据会保留一份本地恢复副本。`)) return;
      replaceWithBackup(next);
      notice("完整备份已恢复。需要时可恢复导入前数据。");
    } catch (error) { notice("未导入，当前账本保持原样：" + error.message, true); }
    finally { $("import-file").value = ""; }
  });
  $("recover").addEventListener("click", () => {
    try {
      const next = L.validateData(JSON.parse(window.localStorage.getItem(L.RECOVERY_KEY)));
      if (!window.confirm("恢复上次替换前的账本？当前数据也会保留为恢复副本。")) return;
      replaceWithBackup(next); notice("已恢复替换前的数据。");
    } catch (error) { notice("恢复失败：" + error.message, true); }
  });

  try {
    const saved = window.localStorage.getItem(L.STORAGE_KEY);
    if (saved) data = L.validateData(JSON.parse(saved));
  } catch (error) {
    storageBlocked = true;
    notice("无法读取原账本，已停止写入以保留原数据。可先导出原始数据，或导入有效备份。原因：" + error.message, true);
  }
  renderHome();
})();
