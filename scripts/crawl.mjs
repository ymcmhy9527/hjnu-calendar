// 抓汉江师范学院公开通知，抽取学生时间点
// 数据源：
//   1. 教务处 jwc.hjnu.edu.cn   —— 四六级 / 选课 / 考试 / 补考
//   2. 数建处 it.hjnu.edu.cn    —— 节假日、寒暑假（教务处那边反而没有）
// 红线：只碰公开页面，不碰 jwsys / ehall 教务系统（需要登录、含个人学籍信息）
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const OUT = path.resolve("data");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

const SOURCES = [
  {
    key: "jwc",
    name: "教务处",
    base: "https://jwc.hjnu.edu.cn/",
    listPages: ["index/tzgg.htm", ...[7, 6, 5, 4, 3, 2, 1].map((n) => `index/tzgg/${n}.htm`)],
    linkPattern: "info\\/1141\\/\\d+\\.htm",
    idPattern: /info\/1141\/(\d+)\.htm/,
  },
  {
    key: "itsc",
    name: "教育数字化建设与管理处",
    base: "https://it.hjnu.edu.cn/",
    listPages: ["tzgg.htm", "tzgg/2.htm", "tzgg/1.htm"],
    linkPattern: "info\\/1062\\/\\d+\\.htm",
    idPattern: /info\/1062\/(\d+)\.htm/,
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" },
        // 没有超时的话，一条卡住的连接能把整批抓取拖死
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new TextDecoder("utf-8").decode(await res.arrayBuffer());
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(400 * (i + 1));
    }
  }
}

// 博达站的正文被 <span>/<font> 切得稀碎，去标签后会留下"202 6 年 7月 15 日"这种
// 空格裂缝。这里把数字/中文之间的裂缝合回去，但保留英文单词之间的空格。
function squash(s) {
  return s
    .replace(/(\d)\s+(?=\d)/g, "$1")
    .replace(/(\d)\s+(?=[年月日号时分元])/g, "$1")
    .replace(/([年月日号])\s+(?=\d)/g, "$1")
    .replace(/(\d)\s+(?=[:：])/g, "$1")
    .replace(/([:：])\s+(?=\d)/g, "$1")
    .replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, "$1")
    .replace(/([\u4e00-\u9fa5])\s+(?=[，。、；：？！）】》」])/g, "$1")
    .replace(/([（【《「])\s+(?=[\u4e00-\u9fa5])/g, "$1")
    .replace(/([A-Z])\s+(?=[A-Z]\b)/g, "$1")
    .replace(/([A-Z])-\s+(?=[A-Z])/g, "$1-");
}

const clean = (s) =>
  squash(
    s
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim()
  );

/* ---------------- 1. 各源列表 → 详情页 URL ---------------- */
const linkMap = new Map(); // url -> { listTitle, source }

for (const src of SOURCES) {
  for (const page of src.listPages) {
    const url = new URL(page, src.base).href;
    let html;
    try {
      html = await get(url);
    } catch (e) {
      console.warn(`! 列表页失败 ${url}: ${e.message}`);
      continue;
    }
    const re = new RegExp(
      `<a\\b[^>]*href=["']([^"']*${src.linkPattern})["'][^>]*>([\\s\\S]*?)</a>`,
      "gi"
    );
    let m;
    let n = 0;
    while ((m = re.exec(html)) !== null) {
      const abs = new URL(m[1].replace(/^\.\.\//, "/"), src.base).href;
      if (!linkMap.has(abs)) linkMap.set(abs, { listTitle: clean(m[2]), source: src });
      n++;
    }
    console.log(`[${src.key}] ${page} -> ${n} 条 (累计 ${linkMap.size})`);
    await sleep(200);
  }
}

/* ---------------- 2. 详情页 ---------------- */
const entries = [...linkMap.entries()];
console.log(`\n开始抓 ${entries.length} 个详情页...`);

const items = [];
const CONCURRENCY = 4;

async function worker(queue) {
  while (queue.length) {
    const [url, meta] = queue.shift();
    try {
      const html = await get(url);
      const src = meta.source;

      // 标题：教务处用 banwtit，数建处没有这个容器，兜底到 <title> 去掉站点后缀
      let title = clean((html.match(/<div class="banwtit">([\s\S]*?)<\/div>/) || [])[1] || "");
      if (!title) {
        title = clean((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "").replace(
          /[-—]\s*汉江师范学院.*$/,
          ""
        );
      }
      if (!title) title = meta.listTitle;

      // 日期：教务处写"时间："，数建处写"发布日期："
      const publishedAt =
        (html.match(/(?:发布时间|发布日期|时间)\s*[：:]\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || "";

      const bodyRaw =
        (html.match(/<div id="vsb_content"[^>]*>([\s\S]*?)<div id="div_vote_id"/) ||
          html.match(/<div id="vsb_content"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/) ||
          [])[1] || "";

      const idm = url.match(src.idPattern);
      items.push({
        // id 带源前缀，避免两个站的通知编号撞车
        id: idm ? `${src.key}-${idm[1]}` : url,
        source: src.key,
        sourceName: src.name,
        url,
        title,
        publishedAt,
        body: clean(bodyRaw),
      });
    } catch (e) {
      console.warn(`! 详情失败 ${url}: ${e.message}`);
    }
    await sleep(120);
  }
}

const queue = [...entries];
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));
items.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
console.log(`详情页完成：${items.length} 条`);

/* ---------------- 3. 时间点抽取 ---------------- */
const CATEGORY_RULES = [
  { key: "报名", re: /报名|报考|注册/ },
  { key: "选课", re: /选课|退课|补选|改选/ },
  { key: "缴费", re: /缴费|费用|收费/ },
  { key: "考试", re: /考试|笔试|口试|测试|考查|补考/ },
  { key: "开学", re: /开学|返校|正式上课|新生报到/ },
  { key: "假期", re: /放假|假期|寒假|暑假|节假日|调休/ },
  { key: "公示", re: /公示|名单|候选/ },
];

function classify(ctx) {
  for (const r of CATEGORY_RULES) if (r.re.test(ctx)) return r.key;
  return "其他";
}

// 一条日期只有落在"某个动作"旁边才算时间安排；否则多半是落款、法条引用、新闻回顾
const ACTION_RE =
  /报名|报考|考试|笔试|口试|选课|退课|缴费|截止|开始|结束|打印|确认|提交|报到|放假|开学|测试|查询|审核|办理|填写|下载|领取|面试|体检|答辩|返校|停课|调休|轮休/;

// 落款：文末的"教务处 2025年10月9日"
const SIGN_OFF_RE = /(教务处|学校办公室|学院|处|部|办公室)\s*20\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/;

function normTitle(t) {
  return squash(t)
    .replace(/四\s*[、,]\s*六级/g, "四六级")
    .replace(/CET\s*[-—]\s*SET/gi, "CET-SET");
}

function classifyNear(ctx, hitIdx, hitLen) {
  const near = ctx.slice(Math.max(0, hitIdx - 12), Math.min(ctx.length, hitIdx + hitLen + 12));
  const c = classify(near);
  return c !== "其他" ? c : classify(ctx);
}

// 相关性：A = 学生自己的时间节点；B = 升学/学籍；C = 行政事务
function relevanceOf(title, ctx) {
  const nt = normTitle(title);
  const t = `${nt} ${ctx}`;
  // 行政/采购口的事务再像也不算学生时间
  if (
    /教学改革|结题|立项|项目申报|拟推荐|评选|成果奖|教材建设|课程建设|采购|询价|成交|招标|中标/.test(
      nt
    )
  )
    return "C";
  if (/招生章程|招生简章|招生工作|招生计划/.test(nt)) return "B";
  if (
    /四六级|CET|普通话|计算机等级|教师资格|期末考试|补考|重修|选课|校历|放假|节假日|寒假|暑假|报到|开学|学位英语|调课|调休/.test(
      t
    )
  )
    return "A";
  if (/专升本|转专业|学籍|毕业|实习|论文|学位|评教|补修/.test(t)) return "B";
  return "C";
}

function extractEvents(item) {
  const text = item.body;
  if (!text) return [];
  const baseYear = item.publishedAt ? Number(item.publishedAt.slice(0, 4)) : new Date().getFullYear();
  const out = [];

  const re = /(?:(\d{4})\s*年)?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let year = m[1] ? Number(m[1]) : baseYear;
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;

    // 12 月发的通知里写"1月12日放寒假"，说的是明年；跨年要补 +1
    if (!m[1] && item.publishedAt) {
      const pubMonth = Number(item.publishedAt.slice(5, 7));
      if (month - pubMonth < -6) year = baseYear + 1;
    }

    const ctxStart = Math.max(0, m.index - 36);
    const ctxEnd = Math.min(text.length, m.index + m[0].length + 36);
    const ctx = text.slice(ctxStart, ctxEnd).trim();

    if (!ACTION_RE.test(ctx)) continue;
    // 教职工轮休/返校之类，跟学生无关
    if (/教职员工|教职工|专任教师/.test(ctx) && !/学生/.test(ctx)) continue;
    const pos = m.index / Math.max(1, text.length);
    if (pos > 0.85 && SIGN_OFF_RE.test(ctx.slice(-46))) continue;

    const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    out.push({
      date: iso,
      year,
      month,
      day,
      category: classifyNear(ctx, m.index - ctxStart, m[0].length),
      relevance: relevanceOf(item.title, ctx),
      context: ctx,
      noticeId: item.id,
      noticeTitle: normTitle(item.title),
      noticeUrl: item.url,
      noticePublishedAt: item.publishedAt,
      source: item.source,
      sourceName: item.sourceName,
    });
  }

  const seen = new Set();
  return out.filter((e) => {
    const k = `${e.date}@${e.noticeId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const events = items.flatMap(extractEvents);
console.log(`抽取事件：${events.length} 条`);

/* ---------------- 4. 落盘 ---------------- */
await mkdir(OUT, { recursive: true });

await writeFile(
  path.join(OUT, "notices.json"),
  JSON.stringify(
    {
      sources: SOURCES.map((s) => ({
        key: s.key,
        name: s.name,
        index: new URL(s.listPages[0], s.base).href,
      })),
      crawledAt: new Date().toISOString(),
      count: items.length,
      items: items.map((i) => ({ ...i, body: i.body.slice(0, 4000) })),
    },
    null,
    2
  ),
  "utf-8"
);

await writeFile(
  path.join(OUT, "events.json"),
  JSON.stringify({ crawledAt: new Date().toISOString(), count: events.length, events }, null, 2),
  "utf-8"
);

console.log(`\n写出：data/notices.json (${items.length}) / data/events.json (${events.length})`);
