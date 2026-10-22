(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.InvestmentLedger = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VERSION = 1;
  const STORAGE_KEY = "investment-ledger.v1";
  const RECOVERY_KEY = "investment-ledger.recovery.v1";
  const ASSETS = Object.freeze([
    Object.freeze({ id: "a500", name: "A500", color: "#d37c68", weight: 45 }),
    Object.freeze({ id: "sp500", name: "标普 500", color: "#7386b6", weight: 45 }),
    Object.freeze({ id: "gold", name: "黄金", color: "#c8a453", weight: 5 }),
    Object.freeze({ id: "btc", name: "BTC", color: "#ce965e", weight: 5 }),
  ]);
  const IDS = ASSETS.map(a => a.id);
  const KINDS = ["buy", "sell", "deposit", "withdraw", "income", "expense", "valuation"];
  const clone = value => JSON.parse(JSON.stringify(value));
  const mapAssets = fn => Object.fromEntries(ASSETS.map(a => [a.id, fn(a)]));
  const fail = message => { throw new Error(message); };
  const object = value => value && typeof value === "object" && !Array.isArray(value);
  const cents = (value, label = "金额", zero = true) => {
    if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) fail(`${label}必须是有效的${zero ? "非负" : "正"}金额`);
    return value;
  };
  const integer = (value, label) => {
    if (!Number.isSafeInteger(value)) fail(`${label}超出可记录范围`);
    return value;
  };
  const timestamp = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;
  function money(value, blankIsZero = false) {
    const raw = String(value ?? "").trim();
    if (!raw && blankIsZero) return 0;
    if (!/^\d+(?:\.\d{0,2})?$/.test(raw)) fail("金额请填写非负数字，最多两位小数");
    const [whole, fraction = ""] = raw.split(".");
    return cents(Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"))));
  }
  function percent(value) {
    if (value === "" || value == null) fail("请填写比例（0–100%）");
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 100 || Math.abs(n * 10 - Math.round(n * 10)) > 1e-8) {
      fail("比例和 PE 分位须在 0–100% 之间，最多一位小数");
    }
    return n;
  }
  function checkWeights(weights) {
    if (!object(weights)) fail("缺少分配比例");
    IDS.forEach(id => { if (typeof weights[id] !== "number") fail("分配比例格式不正确"); percent(weights[id]); });
    if (weights.gold !== 5 || weights.btc !== 5) fail("黄金和 BTC 的常用分配比例应各为 5%");
  }
  function checkPe(pe) {
    if (pe === null) return;
    if (!object(pe) || typeof pe.value !== "number" || !timestamp(pe.at)) fail("PE 数据格式不正确");
    percent(pe.value);
  }
  function checkActive(active) {
    if (!object(active) || IDS.some(id => typeof active[id] !== "boolean")) fail("买入开关格式不正确");
  }
  function checkValues(values) {
    if (!object(values)) fail("缺少资产市值");
    IDS.forEach(id => cents(values[id], "市值"));
  }
  function createData() {
    return {
      version: VERSION, currency: "CNY",
      settings: { weights: mapAssets(a => a.weight), pe: null, source: "new" },
      entries: [], undo: null,
    };
  }
  function allocate(budget, weights, active) {
    cents(budget, "本次预算"); checkWeights(weights); checkActive(active);
    const units = IDS.map(id => active[id] ? Math.round(weights[id] * 10) : 0);
    const sum = units.reduce((s, n) => s + n, 0);
    if (sum > 1000) fail("本次启用的比例合计不能超过 100%");
    const parts = [...units, 1000 - sum].map((weight, i) => {
      const exact = BigInt(budget) * BigInt(weight);
      return { i, amount: Number(exact / 1000n), remainder: Number(exact % 1000n) };
    });
    const left = budget - parts.reduce((s, p) => s + p.amount, 0);
    [...parts].sort((a, b) => b.remainder - a.remainder || a.i - b.i)
      .slice(0, left).forEach(p => { parts[p.i].amount++; });
    return { amounts: Object.fromEntries(IDS.map((id, i) => [id, parts[i].amount])), cash: parts[4].amount, percent: sum / 10 };
  }
  function checkContext(context) {
    if (!object(context)) fail("缺少交易数据快照");
    checkWeights(context.weights); checkActive(context.active); checkPe(context.pe);
    if (!object(context.market)) fail("缺少交易时市值快照");
    IDS.forEach(id => {
      const m = context.market[id];
      if (!object(m) || typeof m.estimated !== "boolean" || !(m.at === null || timestamp(m.at))) fail("市值快照格式不正确");
      cents(m.value, "快照市值");
    });
  }
  function checkEntry(entry) {
    if (!object(entry) || typeof entry.id !== "string" || !entry.id || entry.id.length > 100 ||
        !timestamp(entry.time) || !timestamp(entry.createdAt) || !KINDS.includes(entry.kind) ||
        typeof entry.note !== "string" || entry.note.length > 2000) fail("流水格式不正确");
    checkContext(entry.context);
    if (entry.kind === "buy") {
      if (!["new", "cash"].includes(entry.source)) fail("请选择资金来源");
      cents(entry.budget, "本次预算", false); checkValues(entry.amounts);
      const total = integer(IDS.reduce((s, id) => s + entry.amounts[id], 0), "买入合计");
      if (!total) fail("没有买入金额；新增资金可单独记为转入");
      if (total > entry.budget) fail("实际买入合计不能超过本次预算");
      if (IDS.some(id => !entry.context.active[id] && entry.amounts[id] !== 0)) fail("已跳过的资产不能填写买入金额");
      allocate(entry.budget, entry.context.weights, entry.context.active);
    } else if (entry.kind === "valuation") {
      checkValues(entry.values);
    } else {
      cents(entry.amount, "金额", false);
      if (entry.kind === "sell" && (!IDS.includes(entry.asset) || typeof entry.full !== "boolean")) fail("卖出资产或清仓状态不正确");
    }
  }
  function ordered(entries) {
    return entries.map((entry, index) => ({ entry, index }))
      .sort((a, b) => a.entry.time - b.entry.time || a.index - b.index).map(x => x.entry);
  }
  function replay(entries) {
    let cash = 0, deposits = 0, withdrawals = 0;
    const market = mapAssets(() => ({ value: 0, estimated: false, at: null }));
    const balances = {};
    for (const entry of ordered(entries)) {
      const beforeCash = cash;
      if (entry.kind === "buy") {
        if (entry.source === "new") { cash += entry.budget; deposits += entry.budget; }
        else if (entry.budget > cash) fail("本次预算超过该时间点的可用现金，请先记录资金转入或修改日期");
        IDS.forEach(id => {
          if (entry.amounts[id] > 0) {
            cash -= entry.amounts[id];
            market[id] = { value: integer(market[id].value + entry.amounts[id], "市值"), estimated: true, at: entry.time };
          }
        });
      } else if (entry.kind === "sell") {
        cash += entry.amount;
        market[entry.asset] = { value: entry.full ? 0 : Math.max(0, market[entry.asset].value - entry.amount), estimated: !entry.full, at: entry.time };
      } else if (entry.kind === "valuation") {
        IDS.forEach(id => { market[id] = { value: entry.values[id], estimated: false, at: entry.time }; });
      } else if (entry.kind === "deposit") {
        cash += entry.amount; deposits += entry.amount;
      } else if (entry.kind === "withdraw") {
        cash -= entry.amount; withdrawals += entry.amount;
      } else if (entry.kind === "income") cash += entry.amount;
      else if (entry.kind === "expense") cash -= entry.amount;
      [cash, deposits, withdrawals].forEach(n => integer(n, "资金合计"));
      if (cash < 0) fail("该操作会使历史现金余额不足，请先记录资金转入，或修改金额、日期");
      balances[entry.id] = { before: beforeCash, after: cash };
    }
    const invested = integer(deposits - withdrawals, "净投入");
    const marketValue = integer(IDS.reduce((s, id) => s + market[id].value, 0), "持仓市值");
    const assets = integer(cash + marketValue, "总资产");
    return { cash, deposits, withdrawals, invested, marketValue, assets, profit: integer(assets - invested, "总盈亏"), market,
      estimated: IDS.some(id => market[id].estimated), balances };
  }
  function validateData(data) {
    if (!object(data) || data.version !== VERSION || data.currency !== "CNY" || !object(data.settings) || !Array.isArray(data.entries)) {
      fail("请选择本投资账本导出的 v1 人民币备份文件");
    }
    checkWeights(data.settings.weights); checkPe(data.settings.pe);
    if (!["new", "cash"].includes(data.settings.source)) fail("资金来源设置不正确");
    const ids = new Set();
    data.entries.forEach(entry => {
      checkEntry(entry);
      if (ids.has(entry.id)) fail("流水编号重复，未保存这次操作");
      ids.add(entry.id);
    });
    if (data.undo !== null) {
      if (!object(data.undo) || !Number.isSafeInteger(data.undo.index) || data.undo.index < 0 || ids.has(data.undo.entry?.id)) fail("撤销记录格式不正确");
      checkEntry(data.undo.entry);
    }
    replay(data.entries);
    return clone(data);
  }
  function before(entries, time, editingId = null) {
    const index = entries.findIndex(e => e.id === editingId);
    return replay(entries.filter((e, i) => e.id !== editingId && (e.time < time || (e.time === time && (index < 0 || i < index)))));
  }
  function snapshot(settings, active, state) {
    return clone({ weights: settings.weights, active, pe: settings.pe, market: state.market });
  }
  function upsert(data, entry, editing = false) {
    const next = clone(data), index = next.entries.findIndex(e => e.id === entry.id);
    if (editing) {
      if (index < 0) fail("这笔流水已不存在");
      next.entries[index] = clone(entry);
    } else {
      if (index >= 0) fail("这笔操作已经保存，请勿重复提交");
      next.entries.push(clone(entry));
    }
    return validateData(next);
  }
  function remove(data, id) {
    const next = clone(data), index = next.entries.findIndex(e => e.id === id);
    if (index < 0) fail("这笔流水已不存在");
    next.undo = { entry: next.entries.splice(index, 1)[0], index };
    return validateData(next);
  }
  function undoDelete(data) {
    if (!data.undo) fail("没有可撤销的删除");
    const next = clone(data), removed = next.undo;
    next.entries.splice(Math.min(removed.index, next.entries.length), 0, removed.entry);
    next.undo = null;
    return validateData(next);
  }
  function prepareBuy(input, settings, entries, original = null) {
    const active = input.active;
    checkWeights(settings.weights); checkPe(settings.pe); checkActive(active);
    const context = original ? clone(original.context) : snapshot(settings, active, before(entries, input.time));
    // Preserve the old market snapshot; PE/weights change only when explicitly edited.
    context.weights = clone(settings.weights); context.active = clone(active); context.pe = clone(settings.pe);
    const base = { id: input.id, time: input.time, createdAt: original ? original.createdAt : input.createdAt, note: input.note || "", context };
    allocate(input.budget, settings.weights, active);
    checkValues(input.amounts);
    const total = IDS.reduce((s, id) => s + input.amounts[id], 0);
    if (!total && input.source === "new") return { ...base, kind: "deposit", amount: cents(input.budget, "转入金额", false) };
    if (!total) fail("没有买入金额，不生成空交易。可点击“仅保存比例与 PE”");
    return { ...base, kind: "buy", source: input.source, budget: input.budget, amounts: clone(input.amounts) };
  }

  return { VERSION, STORAGE_KEY, RECOVERY_KEY, ASSETS, IDS, clone, mapAssets, money, percent,
    createData, allocate, replay, ordered, before, snapshot, validateData, upsert, remove, undoDelete, prepareBuy };
});
