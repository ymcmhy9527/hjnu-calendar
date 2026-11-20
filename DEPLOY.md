# 部署

这个站是纯静态的：`dist/` 里四个文件（`index.html` / `favicon.svg` / `404.html` / `robots.txt`），
没有构建步骤、没有服务端、没有环境变量。**把 `dist` 文件夹丢给任何静态托管就能跑。**

## 路线一：拖拽上传（最快，5 分钟）

1. 打开 https://app.netlify.com/drop
2. 把 `dist` 文件夹整个拖进去
3. 得到一个 `xxx.netlify.app` 的地址，当场能用

不登录也能拿到地址，但**不登录的站点会被删**。要长期留，注册个账号（邮箱即可），
然后把这个站点 claim 到自己名下。

Cloudflare 也有同类功能：Workers & Pages → Create → Pages → Upload assets，拖 `dist` 进去。

## 路线二：GitHub + Cloudflare Pages（推荐，能自动更新）

适合以后还要改数据的情况——git push 一次，站自动重建。

1. GitHub 上新建仓库（Public 或 Private 都行），名字建议 `hjnu-calendar`
2. 本地推上去：
   ```bash
   git remote add origin https://github.com/<你的用户名>/hjnu-calendar.git
   git push -u origin main
   ```
3. Cloudflare Dashboard → Workers & Pages → Create → Pages → **Connect to Git**
4. 选这个仓库，构建配置填：
   - Framework preset: `None`
   - Build command: **留空**
   - Build output directory: `dist`
5. Deploy

以后改了数据，只要 `node scripts/crawl.mjs && node scripts/render.mjs` 再 push，站自己更新。

## 路线三：国内访问

说实话：`*.pages.dev` 和 `*.netlify.app` 在国内**部分网络会打不开或很慢**。
如果面试官在国内，给了链接他点开是空白，比没链接还糟。

三个实际的选择：

1. **买域名绑上去**（最稳）。Namecheap/阿里云一个 `.top`/`.xyz` 首年二三十块，
   Cloudflare Pages 支持自定义域名，绑完用 `www.你的域名` 访问，国内走 DNS 解析通常没问题。
2. **同时放一份到 Gitee**（需要实名认证，国内访问快）
3. **简历里两个都给**：GitHub 仓库地址（看代码）+ 线上地址（看效果）。
   就算线上打不开，仓库能打开，面试官也能看懂你做了什么。

## 部署完记得回头改三处

1. `README.md` 里的「线上地址」占位
2. `scripts/render.mjs` 的 `<meta property="og:image">`（想要微信分享有图的话）
3. git 提交身份：
   ```bash
   git config user.name "你的名字"
   git config user.email "你的 GitHub 邮箱"
   ```
   现在仓库里配的是占位邮箱 `liaodongsheng@users.noreply.github.com`，
   推上去之后提交记录不会关联到你的 GitHub 账号。

## 数据更新节奏

教务处通知栏不是每天都有更新（今年 9–11 月整个空窗）。建议：

- **每学期开学后两周**跑一次 `node scripts/crawl.mjs && node scripts/render.mjs`
- 四六级报名季（3 月 / 9 月）、普通话测试季（10 月）前后各跑一次

想让它自动跑，可以在 GitHub 仓库加一个 Actions 定时任务，但那就得把 `node` 环境塞进 CI
——现在这个零依赖的设计在 CI 里反而简单，一个 `actions/setup-node` + 两行命令就够。
