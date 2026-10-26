# 个人工作台

橙色像素风 · 单文件前端 · 数据存本地 · 新闻自动更新

**线上地址：** <https://dusash.github.io/workbench/>  
**博客入口：** 导航栏「工作台」

---

## 六个功能

左侧图标栏切换（手机上在底部）：

|    | 功能         | 干什么                                   |
| -- | ---------- | ------------------------------------- |
| 作战 | **作战台**    | 今日焦点 + 三项指标 + 三条业务线进度 + 最近期限          |
| 项目 | **项目中枢**   | 一项目一档，点卡片能改「下一步」                      |
| 期限 | **DDL 雷达** | 30 天内 / 远期 / 已过站三个分区，勾选即完成            |
| 弹药 | **弹药库**    | 知识卡、GitHub、Skill、素材、杂项，可搜索            |
| 成长 | **成长记录**   | 记进步、看热力格、维护能力地图                       |
| 新闻 | **每日新闻**   | 行情条 + AI 动态 + 科技突破 + 美股行情 + 时政，保留 3 天 |

---

## 数据存在哪

存在浏览器的 `localStorage`，**不上传任何地方**，GitHub 仓库里只有代码和新闻。

双保险：

1. 每次改动写 `localStorage`
2. 同时静默镜像一份到 `IndexedDB`（同一浏览器内）
3. 定期手动「备份」导出 JSON，这是唯一能跨设备的方式

右键侧栏能看到「上次备份」是几天前，**超过 7 天会变红提醒**。

> 注意：工作台和博客同在 `dusash.github.io` 这个域名下，共享浏览器存储。清除站点数据会把两边一起清掉。

---

## 新闻是怎么更新的

每天北京时间 **06:00**，GitHub Actions 自动跑一次：

```
抓取各源 → 去重 → 时效过滤 → AI 筛选+摘要 → 写 data/news.json → 提交
```

- 行情：Yahoo → 腾讯 → Sina 三级降级，取不到就显示「获取失败」，**绝不拿昨天数据充数**
- 新闻：AI 只做筛选和摘要，**不生成内容**（防止编造）
- AI 优先级：GitHub Models → crosery `deepseek-v4.1-flash` → 不调 AI，只给标题链接
- 单源失败不影响其他源，失败原因会列在页面底部

手动触发：仓库 Actions 页面 → Daily News → Run workflow

### 需要的 Secrets（可选）

只用 GitHub Models 的话什么都不用配。想启用 crosery 备用，在  
`Settings → Secrets and variables → Actions` 加：

| 名称              | 值                          |
| --------------- | -------------------------- |
| `CROSERY_KEY`   | 你的 API key                 |
| `CROSERY_URL`   | `https://ai.crosery.cn/v1` |
| `CROSERY_MODEL` | `deepseek-v4.1-flash`      |

---

## 本地开发

```
index.html               ← 成品（字体已内嵌，线上用的就是它）
workbench.html           ← 源码，改这个
_build.py                ← 构建：把 woff2 转 base64 注入
scripts/fetch-news.mjs   ← 抓取脚本
data/news.json           ← 新闻数据（Actions 每天更新）
ark-pixel-12px.woff2     ← 字体源文件
OFL.txt                  ← 字体许可证
```

改完源码跑：

```bash
python _build.py     # 生成 index.html
node scripts/fetch-news.mjs   # 本地抓一次新闻（可选）
```

**为什么字要内嵌**：`file://` 下浏览器会拦外部字体，必须 base64 内联。

---

## 已知限制

1. **本地双击打开时看不了新闻**。`file://` 协议禁止网页读取同目录的数据文件，这是浏览器安全限制。新闻功能必须走线上地址。其余五个功能本地照常可用。
2. **Windows 上像素字体不会呈现"马赛克块"**。系统抗锯齿关不掉，字号放大后边缘被磨圆。这是平台限制，Chromium 内核都一样。像素味靠边框、图标、分段进度条来撑。
3. **手机端不用像素字体**。12px 中文像素字在手机上太小，改用系统字体，布局单列 + 底部标签栏。
4. **行情数字是上一交易日收盘价**。美股周末休市，周六日看到的是周五的数据，日期会标注清楚。

---

## 字体与图标

- 中文像素字体：**Ark Pixel Font**（`TakWolf/ark-pixel-font`，OFL-1.1）
- 像素图标：**pixelarticons**（`halfmage/pixelarticons`，MIT，取了 15 个）

---

## 下一步

- PWA：加 manifest + 图标，可以"安装"成桌面应用
- 项目时间线、文件路径挂载
- 新闻板块可配置（改 `scripts/fetch-news.mjs` 里的 `FEEDS`）
