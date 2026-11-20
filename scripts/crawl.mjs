// 抓汉江师范学院教务处「通知公告」全量，抽取时间点，产出 data/notices.json + data/events.json
// 只碰公开页面，不碰教务系统（jwsys / ehall 需要登录，涉及个人信息）
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const BASE = "https://jwc.hjnu.edu.cn";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";
const OUT = path.resolve("data");

// 第 1 页 + 第 2..8 页（博达站分页倒序编号：第2页 = tzgg/7.htm）
const LIST_PAGES = [
  "index/tzgg.htm",
  ...[7, 6, 5, 4, 3, 2, 1].map((n) => `index/tzgg/${n}.htm`),
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      return new TextDecoder("utf-8").decode(buf);
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(400 * (i + 1));
    }
  }
}

// 博达站的正文被 <span>/<font> 切得稀碎，去掉标签后会留下"202 6 年 7月 15 日"这种
// 空格裂缝。这里把数字/中文之间的裂缝合回去，但保留英文单词之间的空格。
function squash(s) {
  return (
    s
      .replace(/(\d)\s+(?=\d)/g, "$1")
      .replace(/(\d)\s+(?=[年月日号时分元])/g, "$1")
      .replace(/([年月日号])\s+(?=\d)/g, "$1")
      .replace(/(\d)\s+(?=[:：])/g, "$1")
      .replace(/([:：])\s+(?=\d)/g, "$1")
      .replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, "$1")
      .replace(/([\u4e00-\u9fa5])\s+(?=[，。、；：？！）】》」])/g, "$1")
      .replace(/([（【《「])\s+(?=[\u4e00-\u9fa5])/g, "$1")
      // 英文缩写被标签拆开："CE T" -> "CET"，"CET- SET" -> "CET-SET"
      .replace(/([A-Z])\s+(?=[A-Z]\b)/g, "$1")
      .replace(/([A-Z])-\s+(?=[A-Z])/g, "$1-")
  );
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

/* ---------------- 1. 抓列表，收集详情页 URL ---------------- */
const links = new Map(); // url -> 列表顺序

for (const p of LIST_PAGES) {
  const url = new URL(p, BASE + "/").href;
  let html;
  try {
    html = await get(url);
  } catch (e) {
    console.warn(`! 列表页失败 ${url}: ${e.message}`);
    continue;
  }
  const re = /<a\b[^>]*href=["']([^"']*info\/1141\/\d+\.htm)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  let n = 0;
  while ((m = re.exec(html)) !== null) {
    const abs = new URL(m[1].replace(/^\.\.\//, "/"), BASE + "/").href;
    if (!links.has(abs)) links.set(abs, clean(m[2]));
    n++;
  }
  console.log(`列表 ${p} -> ${n} 条 (累计 ${links.size})`);
  await sleep(200);
}

/* ---------------- 2. 抓详情页 ---------------- */
const urls = [...links.keys()];
console.log(`\n开始抓 ${urls.length} 个详情页...`);

const items = [];
const CONCURRENCY = 4;

async function worker(queue, workerId) {
  while (queue.length) {
    const url = queue.shift();
    if (!url) break;
    try {
      const html = await get(url);
      const title =
        clean((html.match(/<div class="banwtit">([\s\S]*?)<\/div>/) || [])[1] || "") ||
        links.get(url) ||
        "";
      const publishedAt =
        (html.match(/时间：\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || "";
      const bodyRaw =
        (html.match(/<div id="vsb_content"[^>]*>([\s\S]*?)<div id="div_vote_id"/) ||
          html.match(/<div id="vsb_content"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/) ||
          [])[1] || "";
      const body = clean(bodyRaw);

      const m = url.match(/info\/1141\/(\d+)\.htm/);
      items.push({
        id: m ? Number(m[1]) : 0,
        url,
        title,
        publishedAt,
        body,
      });
    } catch (e) {
      console.warn(`! 详情页失败 ${url}: ${e.message}`);
    }
    await sleep(120);
  }
}

const queue = [...urls];
await Promise.all(
  Array.from({ length: CONCURRENCY }, (_, i) => worker(queue, i))
);
items.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
console.log(`详情页完成：${items.length} 条`);

/* ---------------- 3. 时间点抽取 ---------------- */
const CATEGORY_RULES = [
  { key: "报名", re: /报名|报考|注册/ },
  { key: "选课", re: /选课|退课|补选|改选/ },
  { key: "缴费", re: /缴费|费用|收费/ },
  { key: "考试", re: /考试|笔试|口试|测试|考查|补考/ },
  { key: "开学", re: /开学|返校|正式上课|新生报到/ },
  { key: "假期", re: /放假|假期|寒假|暑假/ },
  { key: "公示", re: /公示|名单|候选/ },
];

function classify(ctx) {
  for (const r of CATEGORY_RULES) if (r.re.test(ctx)) return r.key;
  return "其他";
}

// 一条日期只有落在"某个动作"旁边才算时间安排；否则多半是落款、法条引用、新闻回顾
const ACTION_RE =
  /报名|报考|考试|笔试|口试|选课|退课|缴费|截止|开始|结束|打印|确认|提交|报到|放假|开学|测试|查询|审核|办理|填写|下载|领取|面试|体检|答辩|返校|停课/;

// 落款：文末的"教务处 2025年10月9日"
const SIGN_OFF_RE = /(教务处|学校办公室|学院|处|部|办公室)\s*20\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/;

function normTitle(t) {
  return squash(t)
    .replace(/四\s*[、,]\s*六级/g, "四六级")
    .replace(/四六级/g, "四六级")
    .replace(/CET\s*[-—]\s*SET/gi, "CET-SET");
}

// 分类看"最近的动词"：先看日期前后 12 字，没有再扩大到整段上下文
function classifyNear(ctx, hitIdx, hitLen) {
  const near = ctx.slice(
    Math.max(0, hitIdx - 12),
    Math.min(ctx.length, hitIdx + hitLen + 12)
  );
  const c = classify(near);
  return c !== "其他" ? c : classify(ctx);
}

// 相关性：A = 学生自己的时间节点；B = 升学/学籍相关；C = 行政事务
function relevanceOf(title, ctx) {
  const t = `${normTitle(title)} ${ctx}`;
  const nt = normTitle(title);
  // 教师/行政口的事务（教研项目申报、结题、教材立项）再像也不算学生时间
  if (/教学改革|结题|立项|项目申报|拟推荐|评选|成果奖|教材建设|课程建设/.test(nt))
    return "C";
  // 招生章程/招生简章是给考生看的，里面的"7月31日前取得毕业证"跟在校生无关
  if (/招生章程|招生简章|招生工作|招生计划/.test(nt)) return "B";
  if (
    /四六级|CET|普通话|计算机等级|教师资格|期末考试|补考|重修|选课|校历|放假|报到|开学|学位英语|调课/.test(
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
  const baseYear = item.publishedAt
    ? Number(item.publishedAt.slice(0, 4))
    : new Date().getFullYear();
  const out = [];

  // 匹配 "2026年3月16日" / "3月16日" / "3月16日至3月30日"
  const re = /(?:(\d{4})\s*年)?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const year = m[1] ? Number(m[1]) : baseYear;
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;

    const ctxStart = Math.max(0, m.index - 36);
    const ctxEnd = Math.min(text.length, m.index + m[0].length + 36);
    const ctx = text.slice(ctxStart, ctxEnd).trim();

    if (!ACTION_RE.test(ctx)) continue; // 没有动作语义 —— 落款 / 引用 / 新闻

    // 文末的落款机构日期
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
    });
  }

  // 同一通知里同一天只留第一条（避免"考试"和"报名"把同一句抽两遍）
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
      source: "https://jwc.hjnu.edu.cn/index/tzgg.htm",
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
  JSON.stringify(
    {
      crawledAt: new Date().toISOString(),
      count: events.length,
      events,
    },
    null,
    2
  ),
  "utf-8"
);

console.log(`\n写出：data/notices.json (${items.length}) / data/events.json (${events.length})`);
