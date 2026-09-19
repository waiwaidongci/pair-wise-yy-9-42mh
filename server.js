import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "cyanotype-negative-room.json");
const port = Number(process.env.PORT || 3040);

// 闭环工艺步骤：必须依次完成，不可跳步；重复提交只保留首次成功记录
const STEPS = ["涂布", "晾干", "曝光", "冲洗", "复晒", "入盒"];
const STATUSES = ["工艺中", "修补中", "待入盒", "已交付"];
const EDITABLE = ["plateSize", "chemicalBatch", "exposure", "waterSource", "box"];

const seed = {
  items: [
    {
      id: "CN-001",
      code: "CN-001",
      plateSize: "18x24cm",
      chemicalBatch: "B-0620",
      exposure: "8分钟",
      waterSource: "井水过滤",
      box: "蓝盒A-03",
      status: "待入盒",
      stepIndex: 5,
      defect: "边角显影不均",
      repair: "边角重涂",
      steps: [
        { step: "涂布", at: "2026-06-18T09:00:00.000Z", note: "双涂层，避光操作" },
        { step: "晾干", at: "2026-06-18T21:00:00.000Z", note: "避光阴干" },
        { step: "曝光", at: "2026-06-20T02:00:00.000Z", note: "阴天补时2分钟" },
        { step: "冲洗", at: "2026-06-20T04:00:00.000Z", note: "井水过滤，冲洗15分钟" },
        { step: "复晒", at: "2026-06-21T02:00:00.000Z", note: "发现边角显影不均" }
      ],
      logs: [
        { at: "2026-06-18T09:00:00.000Z", step: "建档", note: "创建底片" },
        { at: "2026-06-20T02:00:00.000Z", step: "曝光", note: "阴天补时2分钟" },
        { at: "2026-06-21T02:00:00.000Z", step: "复晒", note: "发现边角显影不均" },
        { at: "2026-06-21T03:00:00.000Z", step: "修补", note: "边角重涂" }
      ],
      archive: []
    }
  ]
};

function now() { return new Date().toISOString(); }
function newId() { return "CN-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// 旧数据迁移：把历史 status/steps 结构升级为闭环模型，历史信息并入 logs 保留可查
function normalizeItem(item) {
  let changed = false;
  if (!item.id) { item.id = item.code || newId(); changed = true; }
  if (!Array.isArray(item.logs)) { item.logs = []; changed = true; }
  if (!Array.isArray(item.archive)) { item.archive = []; changed = true; }
  if (!Array.isArray(item.steps)) { item.steps = []; changed = true; }
  if (item.defect === undefined) { item.defect = null; changed = true; }
  if (item.repair === undefined) { item.repair = null; changed = true; }
  if (typeof item.stepIndex === "number" && STATUSES.includes(item.status)) return changed;

  const legacySteps = item.steps;
  const statusMap = { "待曝光": ["工艺中", 0], "冲洗中": ["工艺中", 3], "待入盒": ["待入盒", 5], "已交付": ["已交付", 6] };
  const mapped = statusMap[item.status];
  const stepIndex = mapped ? mapped[1] : Math.min(legacySteps.filter(s => STEPS.includes(s.step)).length, 4);
  for (const s of legacySteps) {
    item.logs.push({
      at: s.at || now(),
      step: s.step || "工艺",
      note: [s.developStatus, s.defect && "缺陷:" + s.defect, s.repair && "修补:" + s.repair, s.note].filter(Boolean).join("；") || "历史步骤迁移"
    });
    if (s.repair && !item.repair) item.repair = s.repair;
  }
  item.steps = STEPS.slice(0, stepIndex).map(step => {
    const log = item.logs.find(l => l.step === step);
    return { step, at: (log && log.at) || now(), note: (log && log.note) || "历史记录迁移" };
  });
  item.stepIndex = stepIndex;
  item.status = mapped ? mapped[0] : "工艺中";
  return true;
}

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await saveDb(seed);
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  db.items ||= [];
  let changed = false;
  for (const item of db.items) changed = normalizeItem(item) || changed;
  if (changed) await saveDb(db);
  return db;
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }

// 写操作串行化：同一时刻只有一个变更生效，并发重复提交会在校验阶段被拒绝
let queue = Promise.resolve();
function withLock(fn) {
  const run = queue.then(fn);
  queue = run.then(() => {}, () => {});
  return run;
}

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
function findItem(db, key) {
  return db.items.find(x => x.id === key || x.code === key);
}
function computeStats(items) {
  const stats = Object.fromEntries(STATUSES.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function summarize(item) {
  return { ...item, nextStep: STEPS[item.stepIndex] || null, logCount: (item.logs || []).length };
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古法蓝晒底片闭环台</title>
  <style>
    :root { --bg:#eef2f4; --panel:#fff; --ink:#1d2530; --muted:#5f6b76; --line:#c9d4dc; --accent:#1f4e79; --cyan:#0e6e8c; --warn:#9b4937; --ok:#2f6b3a; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:400px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#5f6b76; }
    button:disabled { opacity:.5; cursor:not-allowed; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border-radius:999px; padding:3px 10px; font-size:12px; color:#fff; background:#5f6b76; }
    .pill.工艺中 { background:var(--cyan); } .pill.修补中 { background:var(--warn); } .pill.待入盒 { background:#8a6d1f; } .pill.已交付 { background:var(--ok); }
    .chips { display:flex; flex-wrap:wrap; gap:4px; } .chip { border:1px solid var(--line); border-radius:999px; padding:2px 8px; font-size:12px; color:var(--muted); }
    .chip.done { background:var(--accent); border-color:var(--accent); color:#fff; } .chip.next { border-color:var(--accent); color:var(--accent); font-weight:700; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:110px; overflow:auto; } .warn { color:var(--warn); font-weight:700; } .ok { color:var(--ok); font-weight:700; }
    #msg { min-height:20px; font-size:14px; } .row { display:flex; gap:8px; } .row input { flex:1; }
    .archive { border:1px dashed var(--line); border-radius:6px; padding:8px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古法蓝晒底片闭环台</h1><div class="meta">涂布 → 晾干 → 曝光 → 冲洗 → 复晒 → 入盒，依次闭环，不可跳步</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增底片</h2><div id="fields"></div><button>保存底片</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>工艺操作</h2><label>选择底片</label><select name="id" id="itemSelect"></select><div id="actionArea"></div><button id="actionBtn" style="margin-top:10px">提交</button></form>
      <p id="msg"></p>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option></select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>底片列表</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const STEPS = ${JSON.stringify(STEPS)};
    const STATUSES = ${JSON.stringify(STATUSES)};
    const fields = [["code","底片编号"],["plateSize","玻璃板尺寸"],["chemicalBatch","药液批次"],["exposure","曝光时间"],["waterSource","冲洗水源"],["box","存放盒位"]];
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const actionBtn = document.querySelector('#actionBtn');
    const actionArea = document.querySelector('#actionArea');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    const statusFilter = document.querySelector('#statusFilter');
    let items = [];
    let stats = {};
    let submitting = false;

    function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    function showMsg(text, isErr) {
      const el = document.querySelector('#msg');
      el.textContent = text || '';
      el.className = isErr ? 'warn' : 'ok';
      if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 6000);
    }
    function currentItem() { return items.find(x => x.id === itemSelect.value); }

    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'" '+(key==='code'?'required':'')+'>').join('');
      statusFilter.innerHTML = '<option value="">全部状态</option>' + STATUSES.map(s => '<option>'+s+'</option>').join('');
    }
    function renderActionArea() {
      const item = currentItem();
      if (!item) { actionArea.innerHTML = '<div class="meta">暂无底片，请先新增</div>'; actionBtn.disabled = true; return; }
      actionBtn.disabled = false;
      if (item.status === '修补中') {
        actionArea.innerHTML = '<p class="warn">复晒发现缺陷：'+esc(item.defect)+'。仅可提交修补确认，确认后才可入盒。</p>'
          + '<label>修补记录（必填）</label><input name="repair" required>';
        actionBtn.textContent = '修补确认';
        return;
      }
      const next = STEPS[item.stepIndex];
      if (!next) { actionArea.innerHTML = '<div class="meta">流程已闭环，底片已交付。</div>'; actionBtn.disabled = true; return; }
      let html = '<p>下一步骤：<b>'+next+'</b>（第 '+(item.stepIndex + 1)+' / '+STEPS.length+' 步）</p>';
      if (next === '冲洗' && !item.waterSource) html += '<label>冲洗水源（必填，未记录水源不得冲洗）</label><input name="waterSource" required>';
      if (next === '复晒') html += '<label>缺陷（留空表示无缺陷；填写则转入修补）</label><input name="defect">';
      if (next === '入盒') html += '<label>存放盒位（必填）</label><input name="box" value="'+esc(item.box || '')+'">';
      html += '<label>备注</label><input name="note">';
      actionArea.innerHTML = html;
      actionBtn.textContent = '提交：' + next;
    }
    function render() {
      statsEl.innerHTML = STATUSES.map(k => '<div class="stat"><span>'+k+'</span><strong>'+(stats[k] || 0)+'</strong></div>').join('');
      const prev = itemSelect.value;
      itemSelect.innerHTML = items.map(item => '<option value="'+esc(item.id)+'">'+esc(item.code)+' · '+item.status+'</option>').join('');
      if (items.some(i => i.id === prev)) itemSelect.value = prev;
      renderActionArea();
      const status = statusFilter.value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.length ? visible.map(cardHtml).join('') : '<div class="meta">没有匹配的底片</div>';
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => {
        const note = prompt('记录备注');
        if (!note) return;
        try { await api('/api/items/'+btn.dataset.note+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); }
        catch (err) { showMsg(err.message, true); }
      });
      document.querySelectorAll('[data-box]').forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.box;
        const box = document.querySelector('[data-box-input="'+id+'"]').value.trim();
        if (!box) return showMsg('盒位不能为空', true);
        if (!confirm('更换盒位将立即使交付失效，底片回到待入盒。确认更换？')) return;
        try { await api('/api/items/'+id, { method:'PATCH', body: JSON.stringify({ box }) }); showMsg('已更换盒位，交付失效，回到待入盒'); await load(); }
        catch (err) { showMsg(err.message, true); }
      });
    }
    function cardHtml(item) {
      const chips = STEPS.map((s, i) => {
        const cls = i < item.stepIndex ? 'done' : (i === item.stepIndex && item.status !== '已交付' ? 'next' : '');
        return '<span class="chip '+cls+'">'+s+'</span>';
      }).join('');
      const meta = [['玻璃板', item.plateSize], ['药液批次', item.chemicalBatch], ['曝光', item.exposure], ['水源', item.waterSource || '未记录'], ['盒位', item.box || '未入盒']]
        .map(([k,v]) => '<div><b>'+k+'</b> '+esc(v ?? '')+'</div>').join('');
      const defect = item.defect ? '<div class="warn">缺陷：'+esc(item.defect)+(item.repair ? '（已修补：'+esc(item.repair)+'）' : '（待修补）')+'</div>' : '';
      const logs = (item.logs || []).slice(-5).map(l => '<div>'+esc((l.at || '').slice(0,10))+' '+esc(l.step)+'：'+esc(l.note)+'</div>').join('');
      const arch = (item.archive || []).map(a => '<div>'+esc((a.at || '').slice(0,10))+' '+esc(a.reason)+'（'+esc(a.from || '—')+' → '+esc(a.to || '—')+'）</div>').join('');
      const boxCtl = item.status === '已交付'
        ? '<label>更换盒位（更换即失效）</label><div class="row"><input data-box-input="'+esc(item.id)+'" value="'+esc(item.box || '')+'"><button class="secondary" data-box="'+esc(item.id)+'">更换</button></div>'
        : '';
      return '<article class="card"><h3>'+esc(item.code)+' <span class="pill '+item.status+'">'+item.status+'</span></h3>'
        + '<div class="chips">'+chips+'</div>'+meta+defect+boxCtl
        + '<button class="secondary" data-note="'+esc(item.id)+'">追加备注</button>'
        + '<div class="logs meta">'+(logs || '暂无记录')+'</div>'
        + (arch ? '<div class="archive meta"><b>旧履历（不计入当前统计）</b>'+arch+'</div>' : '')
        + '</article>';
    }
    async function load() {
      const [list, s] = await Promise.all([api('/api/items'), api('/api/stats')]);
      items = list;
      stats = s;
      render();
    }
    createForm.onsubmit = async event => {
      event.preventDefault();
      if (submitting) return;
      submitting = true;
      try {
        await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) });
        createForm.reset();
        showMsg('底片已建档，从「涂布」开始闭环流程');
        await load();
      } catch (err) { showMsg(err.message, true); }
      finally { submitting = false; }
    };
    actionForm.onsubmit = async event => {
      event.preventDefault();
      if (submitting) return;
      const item = currentItem();
      if (!item) return;
      submitting = true;
      actionBtn.disabled = true;
      try {
        const data = Object.fromEntries(new FormData(actionForm).entries());
        delete data.id;
        if (item.status === '修补中') {
          await api('/api/items/'+item.id+'/repair', { method:'POST', body: JSON.stringify(data) });
          showMsg('修补已确认，底片回到待入盒');
        } else {
          const step = STEPS[item.stepIndex];
          await api('/api/items/'+item.id+'/steps', { method:'POST', body: JSON.stringify({ ...data, step }) });
          showMsg('已记录：' + step);
        }
        actionForm.reset();
        await load();
      } catch (err) { showMsg(err.message, true); }
      finally { submitting = false; actionBtn.disabled = false; renderActionArea(); }
    };
    itemSelect.onchange = renderActionArea;
    statusFilter.onchange = render;
    document.querySelector('#search').oninput = render;
    document.querySelector('#reload').onclick = load;
    renderForms();
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

    // 新增底片：编号唯一
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const result = await withLock(async () => {
        const db = await loadDb();
        const code = (input.code || "").trim();
        if (!code) return { status: 400, data: { error: "底片编号必填" } };
        if (db.items.some(x => x.code === code)) return { status: 409, data: { error: "编号「" + code + "」已存在，每张底片编号唯一" } };
        const item = {
          id: newId(),
          code,
          plateSize: (input.plateSize || "").trim(),
          chemicalBatch: (input.chemicalBatch || "").trim(),
          exposure: (input.exposure || "").trim(),
          waterSource: (input.waterSource || "").trim(),
          box: (input.box || "").trim(),
          status: "工艺中",
          stepIndex: 0,
          defect: null,
          repair: null,
          steps: [],
          archive: [],
          logs: [{ at: now(), step: "建档", note: "创建底片，进入闭环流程" }]
        };
        db.items.unshift(item);
        await saveDb(db);
        return { status: 201, data: summarize(item) };
      });
      return send(res, result.status, result.data);
    }

    // 提交工艺步骤：依次闭环，跳步/重复拒绝，冲洗校验水源，复晒缺陷转修补
    const stepMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/steps$/);
    if (stepMatch && req.method === "POST") {
      const input = await body(req);
      const result = await withLock(async () => {
        const db = await loadDb();
        const item = findItem(db, decodeURIComponent(stepMatch[1]));
        if (!item) return { status: 404, data: { error: "底片不存在" } };
        if (item.status === "修补中") return { status: 409, data: { error: "复晒发现缺陷，仅可提交修补确认" } };
        const expected = STEPS[item.stepIndex];
        if (!expected) return { status: 409, data: { error: "流程已闭环，无待办步骤" } };
        const step = (input.step || "").trim();
        if (step !== expected) {
          if (item.steps.some(s => s.step === step)) {
            return { status: 409, data: { error: "「" + step + "」已成功记录，重复提交仅保留首次记录" } };
          }
          return { status: 409, data: { error: "必须依次完成「" + expected + "」，不可跳步" } };
        }
        const note = (input.note || "").trim();
        if (step === "冲洗") {
          const waterSource = (input.waterSource || "").trim() || item.waterSource;
          if (!waterSource) return { status: 400, data: { error: "冲洗前必须记录水源，未记录水源不得继续" } };
          item.waterSource = waterSource;
        }
        if (step === "复晒") {
          const defect = (input.defect || "").trim();
          if (defect) {
            item.defect = defect;
            item.repair = null;
            item.status = "修补中";
          } else {
            item.defect = null;
            item.status = "待入盒";
          }
        }
        if (step === "入盒") {
          const box = (input.box || "").trim() || item.box;
          if (!box) return { status: 400, data: { error: "入盒前必须记录盒位" } };
          item.box = box;
          item.status = "已交付";
        }
        item.steps.push({ step, at: now(), note });
        item.stepIndex += 1;
        if (step !== "复晒" && step !== "入盒") item.status = "工艺中";
        item.logs.push({ at: now(), step, note: note || "步骤完成" });
        await saveDb(db);
        return { status: 201, data: summarize(item) };
      });
      return send(res, result.status, result.data);
    }

    // 修补确认：仅修补中可提交，确认后回到待入盒
    const repairMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/repair$/);
    if (repairMatch && req.method === "POST") {
      const input = await body(req);
      const result = await withLock(async () => {
        const db = await loadDb();
        const item = findItem(db, decodeURIComponent(repairMatch[1]));
        if (!item) return { status: 404, data: { error: "底片不存在" } };
        if (item.status !== "修补中") return { status: 409, data: { error: "当前底片不在修补状态" } };
        const note = (input.repair || input.note || "").trim();
        if (!note) return { status: 400, data: { error: "请填写修补记录" } };
        item.repair = note;
        item.status = "待入盒";
        item.logs.push({ at: now(), step: "修补", note });
        await saveDb(db);
        return { status: 200, data: summarize(item) };
      });
      return send(res, result.status, result.data);
    }

    // 更新资料：已交付底片更换盒位立即失效，回到待入盒，旧履历归档可查
    const patchMatch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patchMatch && req.method === "PATCH") {
      const input = await body(req);
      const result = await withLock(async () => {
        const db = await loadDb();
        const item = findItem(db, decodeURIComponent(patchMatch[1]));
        if (!item) return { status: 404, data: { error: "底片不存在" } };
        const updates = {};
        for (const key of EDITABLE) {
          if (typeof input[key] === "string") updates[key] = input[key].trim();
        }
        const oldBox = item.box || "";
        const boxChanged = updates.box !== undefined && updates.box !== oldBox;
        Object.assign(item, updates);
        if (boxChanged && item.status === "已交付") {
          item.archive.push({ at: now(), reason: "更换盒位，交付失效", from: oldBox, to: updates.box });
          item.steps = item.steps.filter(s => s.step !== "入盒");
          item.stepIndex = item.steps.length;
          item.status = "待入盒";
          item.logs.push({ at: now(), step: "失效", note: "更换盒位（" + (oldBox || "—") + " → " + updates.box + "），交付失效，回到待入盒" });
        } else if (Object.keys(updates).length) {
          item.logs.push({ at: now(), step: "资料", note: "更新：" + Object.keys(updates).join("、") });
        }
        await saveDb(db);
        return { status: 200, data: summarize(item) };
      });
      return send(res, result.status, result.data);
    }

    // 追加备注
    const logMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (logMatch && req.method === "POST") {
      const input = await body(req);
      const result = await withLock(async () => {
        const db = await loadDb();
        const item = findItem(db, decodeURIComponent(logMatch[1]));
        if (!item) return { status: 404, data: { error: "底片不存在" } };
        item.logs.push({ at: now(), step: (input.step || "备注").trim(), note: (input.note || "").trim() });
        await saveDb(db);
        return { status: 201, data: summarize(item) };
      });
      return send(res, result.status, result.data);
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("古法蓝晒底片闭环台 listening on http://localhost:" + port));
