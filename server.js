import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "cyanotype-negative-room.json");
const port = Number(process.env.PORT || 3040);

// 闭环工艺顺序：涂布 → 晾干 → 曝光 → 冲洗 → 复晒 → 入盒
const PIPELINE = ["涂布", "晾干", "曝光", "冲洗", "复晒", "入盒"];
const STATUS_AFTER = { 涂布: "待晾干", 晾干: "待曝光", 曝光: "待冲洗", 冲洗: "待复晒", 入盒: "已交付" };
const STATUSES = ["待涂布", "待晾干", "待曝光", "待冲洗", "待复晒", "待入盒", "修补中", "已交付"];
const CREATE_FIELDS = [
  ["code", "底片编号（唯一）", true],
  ["plateSize", "玻璃板尺寸", false],
  ["chemicalBatch", "药液批次", false],
  ["exposure", "曝光时间", false],
  ["waterSource", "冲洗水源（可在冲洗前补录）", false],
  ["box", "预排盒位（入盒时确认）", false]
];

const seed = {
  items: [
    {
      id: "CN-SEED-001",
      code: "CN-001",
      plateSize: "18x24cm",
      chemicalBatch: "B-0620",
      exposure: "8分钟",
      waterSource: "井水过滤",
      box: "蓝盒A-03",
      status: "已交付",
      steps: [
        { at: "2026-06-18T09:00:00.000Z", step: "涂布", note: "感光液均匀涂布" },
        { at: "2026-06-18T11:00:00.000Z", step: "晾干", note: "阴干两小时" },
        { at: "2026-06-20T10:00:00.000Z", step: "曝光", note: "阴天补时2分钟" },
        { at: "2026-06-20T10:30:00.000Z", step: "冲洗", note: "井水过滤冲洗" },
        { at: "2026-06-20T15:00:00.000Z", step: "复晒", note: "复晒稳定，无缺陷", defect: null },
        { at: "2026-06-21T03:50:30.042Z", step: "入盒", note: "放入蓝盒A-03", box: "蓝盒A-03" }
      ],
      repairs: [],
      history: [],
      deliveredAt: "2026-06-21T03:50:30.042Z",
      logs: [
        { at: "2026-06-18T09:00:00.000Z", step: "涂布", note: "感光液均匀涂布" },
        { at: "2026-06-20T10:00:00.000Z", step: "曝光", note: "阴天补时2分钟" },
        { at: "2026-06-21T03:50:30.042Z", step: "入盒", note: "入盒 蓝盒A-03，交付闭环" }
      ]
    },
    {
      id: "CN-SEED-002",
      code: "CN-002",
      plateSize: "13x18cm",
      chemicalBatch: "B-0624",
      exposure: "6分钟",
      waterSource: "山泉水",
      box: "",
      status: "修补中",
      steps: [
        { at: "2026-06-24T09:00:00.000Z", step: "涂布", note: "" },
        { at: "2026-06-24T10:30:00.000Z", step: "晾干", note: "" },
        { at: "2026-06-24T14:00:00.000Z", step: "曝光", note: "" },
        { at: "2026-06-24T14:40:00.000Z", step: "冲洗", note: "" },
        { at: "2026-06-25T09:00:00.000Z", step: "复晒", note: "边缘泛白", defect: "边缘泛白" }
      ],
      repairs: [],
      defect: "边缘泛白",
      history: [],
      logs: [
        { at: "2026-06-25T09:00:00.000Z", step: "复晒", note: "复晒发现缺陷：边缘泛白，转入修补" }
      ]
    },
    {
      id: "CN-SEED-003",
      code: "CN-003",
      plateSize: "18x24cm",
      chemicalBatch: "B-0624",
      exposure: "10分钟",
      waterSource: "",
      box: "",
      status: "待冲洗",
      steps: [
        { at: "2026-06-26T09:00:00.000Z", step: "涂布", note: "" },
        { at: "2026-06-26T11:00:00.000Z", step: "晾干", note: "" },
        { at: "2026-06-27T10:00:00.000Z", step: "曝光", note: "" }
      ],
      repairs: [],
      history: [],
      logs: [{ at: "2026-06-27T10:00:00.000Z", step: "曝光", note: "曝光完成" }]
    },
    {
      id: "CN-SEED-004",
      code: "CN-004",
      plateSize: "24x30cm",
      chemicalBatch: "B-0628",
      exposure: "12分钟",
      waterSource: "井水过滤",
      box: "蓝盒B-02",
      status: "待入盒",
      steps: [
        { at: "2026-06-28T09:00:00.000Z", step: "涂布", note: "" },
        { at: "2026-06-28T11:00:00.000Z", step: "晾干", note: "" },
        { at: "2026-06-29T10:00:00.000Z", step: "曝光", note: "" },
        { at: "2026-06-29T10:40:00.000Z", step: "冲洗", note: "" },
        { at: "2026-06-30T09:30:00.000Z", step: "复晒", note: "复晒合格", defect: null }
      ],
      repairs: [],
      history: [
        {
          archivedAt: "2026-07-02T08:00:00.000Z",
          reason: "已交付后更换盒位，原交付失效",
          box: "蓝盒A-01",
          deliveredAt: "2026-06-30T10:00:00.000Z",
          steps: [
            { at: "2026-06-28T09:00:00.000Z", step: "涂布", note: "" },
            { at: "2026-06-28T11:00:00.000Z", step: "晾干", note: "" },
            { at: "2026-06-29T10:00:00.000Z", step: "曝光", note: "" },
            { at: "2026-06-29T10:40:00.000Z", step: "冲洗", note: "" },
            { at: "2026-06-30T09:30:00.000Z", step: "复晒", note: "复晒合格", defect: null },
            { at: "2026-06-30T10:00:00.000Z", step: "入盒", note: "放入蓝盒A-01", box: "蓝盒A-01" }
          ]
        }
      ],
      logs: [
        { at: "2026-06-30T10:00:00.000Z", step: "入盒", note: "入盒 蓝盒A-01，交付闭环" },
        { at: "2026-07-02T08:00:00.000Z", step: "交付失效", note: "盒位由 蓝盒A-01 更换为 蓝盒B-02，原交付立即失效，回到待入盒；旧履历已归档" }
      ]
    },
    {
      id: "CN-SEED-005",
      code: "CN-005",
      plateSize: "13x18cm",
      chemicalBatch: "B-0701",
      exposure: "8分钟",
      waterSource: "",
      box: "",
      status: "待涂布",
      steps: [],
      repairs: [],
      history: [],
      logs: [{ at: "2026-07-01T09:00:00.000Z", step: "建档", note: "创建底片，进入闭环流程" }]
    }
  ]
};

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  db.items.forEach(normalize);
  return db;
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId() { return "id" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// 串行化所有写操作：同一底片的并发提交在锁内按最新状态校验，仅首次成功生效
let chain = Promise.resolve();
function withLock(task) {
  const run = chain.then(task);
  chain = run.catch(() => {});
  return run;
}

function normalize(item) {
  item.steps ||= [];
  item.logs ||= [];
  item.repairs ||= [];
  item.history ||= [];
  if (!STATUSES.includes(item.status)) item.status = "待涂布";
  return item;
}
// 当前允许提交的步骤：已交付闭环为空；修补中只能修补；否则取流水线中第一个未完成步骤
function allowedNext(item) {
  if (item.status === "已交付") return [];
  if (item.status === "修补中") return ["修补"];
  const done = new Set(item.steps.map(s => s.step));
  const next = PIPELINE.find(step => !done.has(step));
  return next ? [next] : [];
}
function computeStats(items) {
  const stats = Object.fromEntries(STATUSES.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function summarize(item) {
  return { ...item, allowed: allowedNext(item), logCount: item.logs.length, historyCount: item.history.length };
}
function findItem(db, key) {
  return db.items.find(x => x.id === key || x.code === key);
}

// 工艺步骤状态机：返回 { error, status } 表示拒绝（状态不变），否则就地推进
function recordStep(item, input) {
  const step = String(input.step || "").trim();
  const note = String(input.note || "").trim();
  const at = new Date().toISOString();
  const allowed = allowedNext(item);
  if (allowed.length === 0) {
    return { status: 409, error: `底片 ${item.code} 已交付闭环，不能再提交工艺步骤` };
  }
  if (!allowed.includes(step)) {
    return { status: 409, error: `跳步或重复提交无效，仅保留首次成功记录；当前应提交：${allowed.join(" / ")}` };
  }
  if (step === "冲洗") {
    const waterSource = String(input.waterSource || "").trim();
    if (!item.waterSource && !waterSource) {
      return { status: 400, error: "冲洗前必须记录水源，未记录水源不得继续" };
    }
    if (waterSource) item.waterSource = waterSource;
  }
  if (step === "复晒") {
    const defect = String(input.defect || "").trim();
    item.steps.push({ at, step, note, defect: defect || null });
    if (defect) {
      item.defect = defect;
      item.status = "修补中";
      item.logs.push({ at, step, note: note || `复晒发现缺陷：${defect}，转入修补` });
    } else {
      item.status = "待入盒";
      item.logs.push({ at, step, note: note || "复晒完成，无缺陷，待入盒" });
    }
    return { ok: true };
  }
  if (step === "修补") {
    const repair = String(input.repair || "").trim();
    if (!repair) {
      return { status: 400, error: "修补确认必须填写修补记录，确认后才可入盒" };
    }
    item.repairs.push({ at, repair, note });
    item.repair = repair;
    item.status = "待入盒";
    item.logs.push({ at, step, note: note || `修补确认：${repair}，可入盒` });
    return { ok: true };
  }
  if (step === "入盒") {
    const box = String(input.box || "").trim() || item.box;
    if (!box) {
      return { status: 400, error: "入盒前必须指定存放盒位" };
    }
    item.box = box;
    item.steps.push({ at, step, note, box });
    item.status = "已交付";
    item.deliveredAt = at;
    item.logs.push({ at, step, note: note || `入盒 ${box}，交付闭环` });
    return { ok: true };
  }
  item.steps.push({ at, step, note });
  item.status = STATUS_AFTER[step];
  item.logs.push({ at, step, note: note || `${step}完成` });
  return { ok: true };
}

// 字段改录：状态只能由工艺闭环驱动；已交付底片更换盒位立即失效并回到待入盒
function applyPatch(item, input) {
  const at = new Date().toISOString();
  const changes = [];
  for (const key of ["plateSize", "chemicalBatch", "exposure", "waterSource"]) {
    if (input[key] !== undefined) {
      const value = String(input[key]).trim();
      if (value !== (item[key] || "")) {
        item[key] = value;
        changes.push(key);
      }
    }
  }
  if (changes.length) item.logs.push({ at, step: "改录", note: `更新${changes.join("、")}` });
  if (input.box !== undefined) {
    const newBox = String(input.box).trim();
    if (newBox && newBox !== item.box) {
      if (item.status === "已交付") {
        item.history.unshift({
          archivedAt: at,
          reason: "已交付后更换盒位，原交付失效",
          box: item.box,
          deliveredAt: item.deliveredAt || null,
          steps: item.steps
        });
        item.steps = item.steps.filter(s => s.step !== "入盒");
        item.status = "待入盒";
        item.deliveredAt = null;
        item.logs.push({ at, step: "交付失效", note: `盒位由 ${item.box} 更换为 ${newBox}，原交付立即失效，回到待入盒；旧履历已归档` });
        item.box = newBox;
      } else {
        item.logs.push({ at, step: "改录", note: `盒位由 ${item.box || "未定"} 调整为 ${newBox}` });
        item.box = newBox;
      }
    }
  }
  return item;
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古法蓝晒底片闭环台</title>
  <style>
    :root { --bg:#edf1f6; --panel:#fff; --ink:#1c2530; --muted:#5d6b7a; --line:#c9d6e2; --accent:#1f4e79; --accent-soft:#dbe7f3; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#5d6b7a; } button:disabled { opacity:.5; cursor:not-allowed; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .cardhead { display:flex; justify-content:space-between; align-items:center; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--accent); color:var(--accent); border-radius:999px; padding:3px 10px; font-size:12px; font-weight:700; white-space:nowrap; }
    .chips { display:flex; flex-wrap:wrap; gap:6px; } .chip { border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; color:var(--muted); }
    .chip.done { background:var(--accent-soft); border-color:var(--accent); color:var(--accent); font-weight:700; } .chip.warn { background:#f6e3de; border-color:var(--warn); color:var(--warn); font-weight:700; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:110px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .hint { margin-top:10px; color:var(--muted); font-size:12px; } .actions { display:flex; gap:8px; flex-wrap:wrap; }
    details.history { border-top:1px dashed var(--line); padding-top:8px; font-size:13px; } details.history summary { cursor:pointer; color:var(--muted); }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古法蓝晒底片闭环台</h1><div class="meta">涂布 → 晾干 → 曝光 → 冲洗 → 复晒 → 入盒 · 编号唯一 · 跳步或重复提交仅保留首次成功记录</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>建档新底片</h2><div id="createFields"></div><button type="submit">建档</button><div class="hint">每张底片编号唯一，重复编号将被拒绝</div></form>
      <form id="stepForm" style="margin-top:14px"><h2>提交工艺步骤</h2><label>选择底片</label><select id="itemSelect"></select><div class="hint" id="nextHint"></div><label>工艺步骤</label><select id="stepSelect"></select><div id="stepFields"></div><label>备注</label><input name="note" placeholder="选填"><button type="submit" id="stepSubmit">提交记录</button><div class="hint">同一底片并发提交仅首次生效；冲洗前须记录水源；复晒发现缺陷须先修补确认才可入盒</div></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"></select><input id="search" placeholder="搜索编号 / 批次 / 盒位"><span class="meta" id="archivedInfo"></span></div>
      <div class="grid" id="cards"></div>
    </section>
  </main>
  <script>
    var STATUSES = ${JSON.stringify(STATUSES)};
    var PIPELINE = ${JSON.stringify(PIPELINE)};
    var CREATE_FIELDS = ${JSON.stringify(CREATE_FIELDS)};
    var items = [];
    var createForm = document.querySelector('#createForm');
    var stepForm = document.querySelector('#stepForm');
    var itemSelect = document.querySelector('#itemSelect');
    var stepSelect = document.querySelector('#stepSelect');
    var stepFields = document.querySelector('#stepFields');
    var nextHint = document.querySelector('#nextHint');
    var cards = document.querySelector('#cards');
    var statsEl = document.querySelector('#stats');
    var statusFilter = document.querySelector('#statusFilter');
    var searchInput = document.querySelector('#search');
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    async function api(path, options) {
      var res = await fetch(path, options && options.body ? Object.assign({}, options, { headers: { 'Content-Type': 'application/json' } }) : options);
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    function findItem(key) { return items.find(function (i) { return i.id === key || i.code === key; }); }
    function currentItem() { return findItem(itemSelect.value); }
    function renderStatic() {
      document.querySelector('#createFields').innerHTML = CREATE_FIELDS.map(function (f) {
        return '<label>' + f[1] + '</label><input name="' + f[0] + '"' + (f[2] ? ' required' : '') + '>';
      }).join('');
      statusFilter.innerHTML = '<option value="">全部状态</option>' + STATUSES.map(function (s) { return '<option>' + s + '</option>'; }).join('');
    }
    function renderStepForm() {
      var item = currentItem();
      if (!item) { stepSelect.innerHTML = ''; stepFields.innerHTML = ''; nextHint.textContent = '暂无底片，请先建档'; return; }
      var allowed = item.allowed || [];
      nextHint.textContent = allowed.length ? '当前状态「' + item.status + '」，下一步应提交：' + allowed.join(' / ') : '已交付闭环，无后续步骤';
      stepSelect.innerHTML = allowed.map(function (s) { return '<option>' + s + '</option>'; }).join('');
      renderStepFields();
    }
    function renderStepFields() {
      var item = currentItem();
      if (!item) { stepFields.innerHTML = ''; return; }
      var step = stepSelect.value;
      var out = '';
      if (step === '冲洗') out += '<label>冲洗水源' + (item.waterSource ? '（已记录：' + esc(item.waterSource) + '，可改录）' : '（未记录，必填）') + '</label><input name="waterSource" placeholder="如：井水过滤">';
      if (step === '复晒') out += '<label>缺陷描述（填写则转入修补，留空为合格）</label><input name="defect" placeholder="如：边缘泛白">';
      if (step === '修补') out += '<label>修补记录（必填，确认后才可入盒）</label><input name="repair" placeholder="如：边角重涂并复验">';
      if (step === '入盒') out += '<label>存放盒位（必填）</label><input name="box" value="' + esc(item.box || '') + '" placeholder="如：蓝盒A-03">';
      stepFields.innerHTML = out;
    }
    function cardHtml(item) {
      var done = (item.steps || []).map(function (s) { return s.step; });
      var chips = PIPELINE.map(function (s) {
        return '<span class="chip' + (done.indexOf(s) !== -1 ? ' done' : '') + '">' + s + '</span>';
      }).join('');
      if (item.status === '修补中' || (item.repairs && item.repairs.length)) {
        chips += '<span class="chip ' + (item.status === '修补中' ? 'warn' : 'done') + '">修补</span>';
      }
      var lines = [['尺寸', item.plateSize], ['药液批次', item.chemicalBatch], ['曝光', item.exposure], ['水源', item.waterSource || '未记录'], ['盒位', item.box || '未定']].map(function (kv) {
        return '<div><b>' + kv[0] + '</b> ' + esc(kv[1]) + '</div>';
      }).join('');
      var defect = item.defect ? '<div class="warn">缺陷：' + esc(item.defect) + '</div>' : '';
      var repair = item.repair ? '<div>修补：' + esc(item.repair) + '</div>' : '';
      var next = (item.allowed && item.allowed.length) ? '<div class="meta">下一步：' + item.allowed.join(' / ') + '</div>' : '<div class="meta">已交付闭环</div>';
      var logs = (item.logs || []).slice(-4).map(function (l) { return '<div>' + esc(l.step) + '：' + esc(l.note) + '</div>'; }).join('');
      var history = (item.history && item.history.length)
        ? '<details class="history"><summary>旧履历 ' + item.history.length + ' 段（不计入当前统计）</summary>' + item.history.map(function (h) {
            return '<div class="meta">' + esc(String(h.archivedAt || '').slice(0, 10)) + ' · 原盒位 ' + esc(h.box) + ' · ' + esc(h.reason || '') + '</div>';
          }).join('') + '</details>'
        : '';
      var boxBtn = item.status === '已交付' ? '<button type="button" class="secondary" data-boxchange="' + esc(item.id) + '">更换盒位</button>' : '';
      return '<article class="card"><div class="cardhead"><h3>' + esc(item.code) + '</h3><span class="pill">' + esc(item.status) + '</span></div><div class="chips">' + chips + '</div>' + lines + defect + repair + next + '<div class="actions">' + boxBtn + '<button type="button" class="secondary" data-note="' + esc(item.id) + '">追加备注</button></div><div class="logs meta">' + (logs || '暂无记录') + '</div>' + history + '</article>';
    }
    function bindCardActions() {
      document.querySelectorAll('[data-boxchange]').forEach(function (btn) {
        btn.onclick = async function () {
          var item = findItem(btn.dataset.boxchange);
          var box = prompt('已交付底片更换盒位将立即失效并回到待入盒，旧履历归档可查。\\n请输入新盒位：', item.box || '');
          if (box && box.trim() && box.trim() !== item.box) {
            try { await api('/api/items/' + encodeURIComponent(item.id), { method: 'PATCH', body: JSON.stringify({ box: box.trim() }) }); await load(); }
            catch (err) { alert(err.message); }
          }
        };
      });
      document.querySelectorAll('[data-note]').forEach(function (btn) {
        btn.onclick = async function () {
          var item = findItem(btn.dataset.note);
          var note = prompt('追加备注');
          if (note) {
            try { await api('/api/items/' + encodeURIComponent(item.id) + '/logs', { method: 'POST', body: JSON.stringify({ step: '备注', note: note }) }); await load(); }
            catch (err) { alert(err.message); }
          }
        };
      });
    }
    function render() {
      var prev = itemSelect.value;
      itemSelect.innerHTML = items.map(function (i) { return '<option value="' + esc(i.id) + '">' + esc(i.code) + ' · ' + esc(i.status) + '</option>'; }).join('');
      if (prev && findItem(prev)) itemSelect.value = prev;
      renderStepForm();
      statsEl.innerHTML = STATUSES.map(function (s) {
        return '<div class="stat"><span>' + s + '</span><strong>' + items.filter(function (i) { return i.status === s; }).length + '</strong></div>';
      }).join('');
      var archived = items.reduce(function (n, i) { return n + (i.history ? i.history.length : 0); }, 0);
      document.querySelector('#archivedInfo').textContent = archived ? '已归档旧履历 ' + archived + ' 段（不计入当前统计）' : '';
      var status = statusFilter.value;
      var q = searchInput.value.trim();
      var visible = items.filter(function (i) { return (!status || i.status === status) && (!q || JSON.stringify(i).indexOf(q) !== -1); });
      cards.innerHTML = visible.map(cardHtml).join('') || '<div class="panel meta">暂无匹配底片</div>';
      bindCardActions();
    }
    async function load() { items = await api('/api/items'); render(); }
    createForm.onsubmit = async function (event) {
      event.preventDefault();
      var btn = createForm.querySelector('button');
      btn.disabled = true;
      try {
        await api('/api/items', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) });
        createForm.reset();
        await load();
      } catch (err) { alert(err.message); }
      btn.disabled = false;
    };
    stepForm.onsubmit = async function (event) {
      event.preventDefault();
      var item = currentItem();
      if (!item) return;
      var btn = document.querySelector('#stepSubmit');
      btn.disabled = true;
      try {
        var payload = Object.fromEntries(new FormData(stepForm).entries());
        payload.step = stepSelect.value;
        await api('/api/items/' + encodeURIComponent(item.id) + '/steps', { method: 'POST', body: JSON.stringify(payload) });
        stepForm.reset();
        await load();
      } catch (err) { alert(err.message); await load(); }
      btn.disabled = false;
    };
    itemSelect.onchange = renderStepForm;
    stepSelect.onchange = renderStepFields;
    statusFilter.onchange = render;
    searchInput.oninput = render;
    document.querySelector('#reload').onclick = load;
    renderStatic();
    load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/api/items") {
      const db = await loadDb();
      return send(res, 200, db.items.map(summarize));
    }
    if (req.method === "GET" && url.pathname === "/api/stats") {
      const db = await loadDb();
      return send(res, 200, computeStats(db.items));
    }
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      return await withLock(async () => {
        const db = await loadDb();
        const code = String(input.code || "").trim();
        if (!code) return send(res, 400, { error: "底片编号必填" });
        if (db.items.some(x => x.code === code)) {
          return send(res, 409, { error: `编号 ${code} 已存在：每张底片编号唯一` });
        }
        const at = new Date().toISOString();
        const item = normalize({
          id: newId(),
          code,
          plateSize: String(input.plateSize || "").trim(),
          chemicalBatch: String(input.chemicalBatch || "").trim(),
          exposure: String(input.exposure || "").trim(),
          waterSource: String(input.waterSource || "").trim(),
          box: String(input.box || "").trim(),
          status: "待涂布",
          steps: [],
          repairs: [],
          history: [],
          logs: [{ at, step: "建档", note: "创建底片，进入闭环流程" }]
        });
        db.items.unshift(item);
        await saveDb(db);
        return send(res, 201, summarize(item));
      });
    }
    const stepMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/steps$/);
    if (stepMatch && req.method === "POST") {
      const input = await body(req);
      return await withLock(async () => {
        const db = await loadDb();
        const item = findItem(db, decodeURIComponent(stepMatch[1]));
        if (!item) return send(res, 404, { error: "item_not_found" });
        const result = recordStep(item, input);
        if (result.error) return send(res, result.status, { error: result.error });
        await saveDb(db);
        return send(res, 201, summarize(item));
      });
    }
    const logMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (logMatch && req.method === "POST") {
      const input = await body(req);
      return await withLock(async () => {
        const db = await loadDb();
        const item = findItem(db, decodeURIComponent(logMatch[1]));
        if (!item) return send(res, 404, { error: "item_not_found" });
        item.logs.push({ at: new Date().toISOString(), step: String(input.step || "备注"), note: String(input.note || "") });
        await saveDb(db);
        return send(res, 201, summarize(item));
      });
    }
    const patchMatch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patchMatch && req.method === "PATCH") {
      const input = await body(req);
      if (input.status !== undefined) {
        return send(res, 400, { error: "状态由工艺闭环驱动，不能直接修改" });
      }
      return await withLock(async () => {
        const db = await loadDb();
        const item = findItem(db, decodeURIComponent(patchMatch[1]));
        if (!item) return send(res, 404, { error: "item_not_found" });
        for (const key of ["id", "code", "steps", "logs", "history", "repairs"]) delete input[key];
        applyPatch(item, input);
        await saveDb(db);
        return send(res, 200, summarize(item));
      });
    }
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("古法蓝晒底片闭环台 listening on http://localhost:" + port));
