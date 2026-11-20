// 零依赖静态站生成器：data/*.json -> dist/index.html
// 为什么不用 Next：这个站的数据是静态的，不需要 SSR；少一层依赖就少一处崩。
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const events = JSON.parse(
  fs.readFileSync(path.join(ROOT, "data/events.json"), "utf8")
).events;
const noticeBundle = JSON.parse(
  fs.readFileSync(path.join(ROOT, "data/notices.json"), "utf8")
);
const notices = noticeBundle.items;

/* ---------------- 主题 ---------------- */
const TOPICS = [
  { key: "cet", name: "英语四六级", re: /四六级|CET/i, accent: "#1f4e73" },
  { key: "putonghua", name: "普通话测试", re: /普通话/, accent: "#a3782f" },
  { key: "elective", name: "公共选修课", re: /通识|选修课|公选/, accent: "#4a6b4f" },
  { key: "makeup", name: "补考", re: /补考/, accent: "#9c4a3c" },
  { key: "final", name: "期末考试", re: /期末考/, accent: "#6b4a7a" },
  { key: "transfer", name: "转专业", re: /转专业/, accent: "#3c6b7a" },
  // 放最后：先让"开学补考"归到补考，剩下的"开学"才是真的开学
  { key: "holiday", name: "假期与开学", re: /放假|寒假|暑假|节假日|开学|报到|调休/, accent: "#8a6a3f" },
];
const topicByKey = Object.fromEntries(TOPICS.map((t) => [t.key, t]));

// 主题以标题为准（标题是教务处的正式定性），标题里没有再看日期自身上下文
function topicOf(ctx, title) {
  for (const tp of TOPICS) if (tp.re.test(title)) return tp;
  for (const tp of TOPICS) if (tp.re.test(ctx)) return tp;
  return null;
}

const tagged = events
  .filter((e) => e.relevance === "A")
  .map((e) => ({ ...e, topic: topicOf(e.context, e.noticeTitle) }))
  .filter((e) => e.topic);

/* ---------------- 按通知聚合 ---------------- */
const noticeMap = new Map();
for (const e of tagged) {
  if (!noticeMap.has(e.noticeId)) {
    noticeMap.set(e.noticeId, {
      id: e.noticeId,
      title: e.noticeTitle,
      url: e.noticeUrl,
      publishedAt: e.noticePublishedAt,
      points: [],
    });
  }
  noticeMap.get(e.noticeId).points.push(e);
}

// 同一类动作的日期合并成区间：报名 03.16–03.30
// 间隔超过 12 天就断开，避免把"3 月报名"和"6 月考试"糊成一段
const RANK = { 报名: 1, 缴费: 2, 选课: 3, 考试: 4, 开学: 5, 假期: 6, 公示: 7, 其他: 8 };
function clusterDates(dates, gapDays = 12) {
  const groups = [];
  for (const d of [...new Set(dates)].sort()) {
    const last = groups[groups.length - 1];
    if (last && (Date.parse(d) - Date.parse(last[last.length - 1])) / 864e5 <= gapDays) {
      last.push(d);
    } else {
      groups.push([d]);
    }
  }
  return groups;
}

function mergePoints(points) {
  const g = new Map();
  for (const p of points) {
    const k = `${p.topic.key}|${p.category}`;
    if (!g.has(k)) g.set(k, { topic: p.topic, category: p.category, dates: [] });
    g.get(k).dates.push(p.date);
  }
  return [...g.values()]
    .flatMap((v) =>
      clusterDates(v.dates).map((grp) => ({
        ...v,
        from: grp[0],
        to: grp[grp.length - 1],
        n: grp.length,
      }))
    )
    .sort(
      (a, b) =>
        (RANK[a.category] || 9) - (RANK[b.category] || 9) || (a.from < b.from ? -1 : 1)
    );
}

const noticeList = [...noticeMap.values()]
  .map((n) => {
    const pts = mergePoints(n.points);
    const firstDate = n.points.map((p) => p.date).sort()[0];
    const topics = [...new Set(n.points.map((p) => p.topic.key))].map(
      (k) => topicByKey[k]
    );
    return {
      ...n,
      pts,
      firstDate,
      year: Number((n.publishedAt || firstDate).slice(0, 4)),
      topics,
      mainTopic: topics[0],
      cleanTitle: n.title.replace(/^【[^】]*】/, "").trim(),
    };
  })
  // 年表按通知发布先后排（读者关心的是"什么时候发的"),不是在事件何时发生
  .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));

/* ---------------- 年度节律矩阵（按事件月份） ---------------- */
const matrix = new Map();
const monthYears = new Map();
for (const tp of TOPICS) {
  matrix.set(tp.key, Array.from({ length: 12 }, () => new Set()));
  monthYears.set(tp.key, Array.from({ length: 12 }, () => new Set()));
}
for (const e of tagged) {
  matrix.get(e.topic.key)[e.month - 1].add(e.date);
  monthYears.get(e.topic.key)[e.month - 1].add(e.year);
}

/* ---------------- 接下来：按"通知发布月"推 ---------------- */
// 语义是"这个月该去教务处看有没有通知了"，比预测具体日期靠谱
const TODAY = new Date("2026-11-19T00:00:00+08:00");
const pubMonths = new Map();
for (const tp of TOPICS) pubMonths.set(tp.key, Array.from({ length: 12 }, () => new Set()));
for (const n of noticeList) {
  const m = Number((n.publishedAt || "2026-01-01").slice(5, 7));
  const y = Number((n.publishedAt || "2026-01-01").slice(0, 4));
  for (const tp of n.topics) pubMonths.get(tp.key)[m - 1].add(y);
}

const upcoming = [];
for (const tp of TOPICS) {
  for (let m = 1; m <= 12; m++) {
    const ys = pubMonths.get(tp.key)[m - 1];
    if (ys.size < 2) continue; // 至少两年都在这个月发过，才算稳定节律
    const cand = new Date(TODAY.getFullYear(), m - 1, 15);
    const year = cand < TODAY ? TODAY.getFullYear() + 1 : TODAY.getFullYear();
    const last = noticeList
      .filter((n) => n.publishedAt.slice(0, 7) === `2026-${String(m).padStart(2, "0")}` && n.topics.some((t) => t.key === tp.key))
      .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))[0];
    upcoming.push({ topic: tp, year, month: m, yearsCount: ys.size, years: [...ys].sort(), last });
  }
}
upcoming.sort((a, b) => a.year - b.year || a.month - b.month);
const nextUp = upcoming.slice(0, 3);

/* ---------------- 工具 ---------------- */
const esc = (s = "") =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const yearSpan = [...new Set(notices.map((n) => n.publishedAt.slice(0, 4)))].filter(Boolean).sort();
const crawledAt = new Date(noticeBundle.crawledAt);
const crawledLabel = `${crawledAt.getFullYear()}-${String(crawledAt.getMonth() + 1).padStart(2, "0")}-${String(crawledAt.getDate()).padStart(2, "0")}`;
const fmtMd = (iso) => iso.slice(5).replace("-", ".");

/* ---------------- 片段 ---------------- */
const monthHead = Array.from({ length: 12 }, (_, i) => `<div class="mx-h">${i + 1}</div>`).join("");

const matrixRows = TOPICS.map((tp) => {
  const cells = Array.from({ length: 12 }, (_, i) => {
    const n = matrix.get(tp.key)[i].size;
    const ys = monthYears.get(tp.key)[i];
    const level = n === 0 ? 0 : ys.size >= 2 ? (n >= 3 ? 3 : 2) : 1;
    const tip = n === 0 ? "" : `${tp.name} · ${i + 1}月：${[...ys].sort().join("、")} 年出现过（${n} 次）`;
    return `<div class="mx-cell lv${level}" style="--accent:${tp.accent}" title="${esc(tip)}">${n > 0 ? n : ""}</div>`;
  }).join("");
  return `<div class="mx-row"><div class="mx-name"><i style="background:${tp.accent}"></i>${tp.name}</div>${cells}</div>`;
}).join("");

const upcomingHtml = nextUp
  .map((u) => {
    const mon = `${u.year} 年 ${u.month} 月`;
    const why = u.last
      ? `去年 ${fmtMd(u.last.publishedAt)} 发过《${esc(u.last.cleanTitle.slice(0, 18))}…》`
      : `${u.yearsCount} 年里 ${u.month} 月都发过相关通知`;
    return `<div class="next-card" style="--accent:${u.topic.accent}">
      <div class="next-when">${mon}</div>
      <div class="next-what">留意 ${esc(u.topic.name)} 通知</div>
      <div class="next-why">${why}</div>
    </div>`;
  })
  .join("");

const ptHtml = (p) =>
  `<span class="pt"><em>${esc(p.category)}</em>${fmtMd(p.from)}${p.to !== p.from ? `–${fmtMd(p.to)}` : ""}</span>`;

const yearsDesc = [...new Set(noticeList.map((n) => n.year))].sort((a, b) => b - a);

const timelineHtml = yearsDesc
  .map((y) => {
    const rows = noticeList
      .filter((n) => n.year === y)
      .map(
        (n) => `<article class="ev" style="--accent:${n.mainTopic.accent}">
          <div class="ev-date">${fmtMd(n.publishedAt || n.firstDate)}</div>
          <div class="ev-body">
            <p class="ev-title"><span class="tag" style="background:${n.mainTopic.accent}1a;color:${n.mainTopic.accent}">${esc(n.mainTopic.name)}</span><a href="${esc(n.url)}" target="_blank" rel="noreferrer">${esc(n.cleanTitle)}</a></p>
            <div class="points">${n.pts.map(ptHtml).join("")}</div>
          </div>
        </article>`
      )
      .join("");
    return `<section class="year-block"><h3 class="year-label">${y}</h3><div class="tl">${rows}</div></section>`;
  })
  .join("");

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>汉师时间尺 · 把教务处通知摊成一张年表</title>
<meta name="description" content="汉江师范学院教务处 ${notices.length} 条公开通知里的时间节点，自动抽取成年度节律与年表。">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta name="theme-color" content="#f7f5f1">
<meta property="og:type" content="website">
<meta property="og:title" content="汉师时间尺 · 把教务处通知摊成一张年表">
<meta property="og:description" content="教务处 ${notices.length} 条通知里，只有 ${noticeList.length} 条真跟学生的时间安排有关。这里把它们捞出来摊平。">
<meta property="og:site_name" content="汉师时间尺">
<style>
${fs.readFileSync(path.join(ROOT, "styles/site.css"), "utf8")}
/* ---- 矩阵 ---- */
.mx { overflow-x: auto; padding-bottom: 6px; max-width: 100%; -webkit-overflow-scrolling: touch; }
.mx-grid { width: 700px; }
.mx-head, .mx-row { display: grid; grid-template-columns: 112px repeat(12, 1fr); gap: 4px; }
.mx-head { margin-bottom: 6px; }
.mx-h { font-size: 11px; color: var(--ink-3); text-align: center; }
.mx-row { margin-bottom: 4px; align-items: center; }
.mx-name { font-size: 13px; color: var(--ink-2); display: flex; align-items: center; gap: 8px; white-space: nowrap; }
.mx-name i { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.mx-cell { height: 30px; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 11px; font-family: var(--serif); font-weight: 700; background: #efeae0; color: transparent; }
.mx-cell.lv1 { background: color-mix(in srgb, var(--accent) 20%, #efeae0); color: var(--ink-2); }
.mx-cell.lv2 { background: color-mix(in srgb, var(--accent) 45%, #efeae0); color: #fff; }
.mx-cell.lv3 { background: var(--accent); color: #fff; }
/* ---- next ---- */
.next { display: grid; grid-template-columns: repeat(auto-fill, minmax(228px, 1fr)); gap: 12px; }
.next-card { background: var(--card); border: 1px solid var(--line); border-left: 3px solid var(--accent); border-radius: 12px; padding: 16px; }
.next-when { font-family: var(--serif); font-size: 21px; font-weight: 700; color: var(--accent); line-height: 1.1; }
.next-what { font-size: 14px; font-weight: 600; margin: 6px 0 6px; }
.next-why { font-size: 12px; color: var(--ink-3); line-height: 1.65; }
/* ---- points ---- */
.points { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.pt { font-size: 12px; color: var(--ink-2); background: #f1ede4; border-radius: 7px; padding: 4px 9px 4px 7px; white-space: nowrap; }
.pt em { font-style: normal; font-size: 11px; color: #fff; background: var(--accent); border-radius: 4px; padding: 1px 5px; margin-right: 6px; }
.ev-title a { border-bottom: 1px dotted transparent; }
.ev-title a:hover { border-color: var(--ink-3); }
</style>
</head>
<body>
<div class="wrap">

  <header class="hero">
    <p class="kicker">汉江师范学院 · 教务处 × 教育数字化建设与管理处</p>
    <h1>汉师<em>时间尺</em></h1>
    <p class="lede">两个部门 ${notices.length} 条通知里，真正跟"我什么时候要做什么"有关的只有 ${noticeList.length} 条。这个站把它们从公文里捞出来，按时间摊平——你能看见四六级、普通话、选课、补考、寒暑假每一年是怎么循环的。</p>
    <div class="stats">
      <div class="stat"><b>${notices.length}</b><span>条公开通知</span></div>
      <div class="stat"><b>${noticeList.length}</b><span>条含时间安排</span></div>
      <div class="stat"><b>${tagged.length}</b><span>个时间点</span></div>
      <div class="stat"><b>${yearSpan[0]}–${yearSpan[yearSpan.length - 1]}</b><span>覆盖年度</span></div>
    </div>
  </header>

  <section class="sec">
    <div class="sec-head"><h2>接下来该盯哪个月</h2><p>按历史发布节奏推的，不是官方预告</p></div>
    <p class="sub">学校发通知的月份比考试日期还稳。下面这些月份，过去两年以上都在发同一类通知——到了就去看一眼。</p>
    <div class="next">${upcomingHtml || '<p class="sub">历史数据还不足以推出规律。</p>'}</div>
  </section>

  <section class="sec">
    <div class="sec-head"><h2>一年里，事都挤在什么时候</h2><p>颜色越深＝这些年里反复出现</p></div>
    <p class="sub">横着看一行，就是一个主题一整年的节奏。格子里的数字是这些年该月出现过几次。</p>
    <div class="mx">
      <div class="mx-grid">
        <div class="mx-head"><div></div>${monthHead}</div>
        ${matrixRows}
      </div>
    </div>
  </section>

  <section class="sec">
    <div class="sec-head"><h2>年表</h2><p>每条都能点回原文</p></div>
    <p class="sub">一篇通知里往往埋着好几个时间点，这里按动作归成小块。抽错的、漏的，记在项目 README 里。</p>
    ${timelineHtml}
  </section>

  <footer class="foot">
    <p>数据来自 <a href="https://jwc.hjnu.edu.cn/index/tzgg.htm" target="_blank" rel="noreferrer">教务处 · 通知公告</a> 与 <a href="https://it.hjnu.edu.cn/tzgg.htm" target="_blank" rel="noreferrer">教育数字化建设与管理处 · 通知公告</a>，${crawledLabel} 抓取，共 ${notices.length} 条。只读公开页面，不涉及登录态或个人信息。</p>
    <p>时间点由脚本从通知正文自动抽取，可能有误，以学校原文为准。生成于 ${esc(noticeBundle.crawledAt)}</p>
  </footer>

</div>
</body>
</html>`;

fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "dist/index.html"), html, "utf8");

/* ---------------- 部署门面 ---------------- */
// 图标：一条时间轴 + 三个节点，跟页面里那张矩阵同一个隐喻
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#1f4e73"/>
  <path d="M9 8.5v15" stroke="#fff" stroke-opacity=".4" stroke-width="1.4"/>
  <circle cx="9" cy="9" r="2.6" fill="#fff"/>
  <circle cx="9" cy="16" r="3" fill="#c9a35e"/>
  <circle cx="9" cy="23" r="2.6" fill="#fff" fill-opacity=".72"/>
  <rect x="14" y="7.6" width="11" height="2.8" rx="1.4" fill="#fff" fill-opacity=".92"/>
  <rect x="14" y="14.6" width="8" height="2.8" rx="1.4" fill="#fff" fill-opacity=".68"/>
  <rect x="14" y="21.6" width="10" height="2.8" rx="1.4" fill="#fff" fill-opacity=".46"/>
</svg>
`;
fs.writeFileSync(path.join(ROOT, "dist/favicon.svg"), favicon, "utf8");

const notFound = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>没有这一页 · 汉师时间尺</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  html,body{margin:0;height:100%;background:#f7f5f1;color:#1b2b3a;
    font-family:"Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
    display:flex;align-items:center;justify-content:center;text-align:center}
  .box{padding:40px 24px}
  h1{font-family:"Noto Serif SC","Songti SC",serif;font-size:56px;margin:0 0 8px;color:#1f4e73}
  p{color:#55647a;margin:0 0 22px;font-size:15px}
  a{color:#1f4e73;border-bottom:1px solid #e3ded4;text-decoration:none;font-size:14px}
</style></head>
<body><div class="box">
  <h1>404</h1>
  <p>这条时间线上没有这一页。</p>
  <a href="/">回年表首页 →</a>
</div></body></html>
`;
fs.writeFileSync(path.join(ROOT, "dist/404.html"), notFound, "utf8");

fs.writeFileSync(
  path.join(ROOT, "dist/robots.txt"),
  `User-agent: *\nAllow: /\n`,
  "utf8"
);

console.log(
  `dist/index.html · 通知 ${notices.length} · 含时间安排 ${noticeList.length} · 时间点 ${tagged.length} · 规律 ${upcoming.length} · ${(html.length / 1024).toFixed(1)} KB`
);
