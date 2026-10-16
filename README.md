# steam-worker

把 **Steam 游戏库**做成一个 JSON 接口的 Cloudflare Worker：代持 Steam Web API key、加上 CORS、
按不同新鲜度缓存上游结果。给静态站点（比如 Hexo 博客）做「当前在玩 / 最近两周 / 全库时长」的**实时**展示。

线上实例：<https://steam.4123010.xyz> （我的博客 [blog.lvbyte.top/games](https://blog.lvbyte.top/games/) 在用）

```
GET /            → { player, games, totalCount, totalPlaytimeMinutes, recentPlaytimeMinutes, fetchedAt }
GET /?debug=1    → 同上，并带 X-Steam-Cache 响应头（player=hit recent=hit owned=miss）
GET /avatar      → 反代玩家头像（Steam 头像在 avatars.steamstatic.com，国内常连不上；这里由 Worker 取回再吐给页面，缓存 1 小时）
```

```jsonc
{
  "fetchedAt": "2026-10-16T15:39:00.000Z",
  "player": {
    "steamid": "76561199xxxxxxxxx",
    "personaname": "七亿少女的梦",
    "avatar": "https://avatars.akamai.steamstatic.com/....jpg",
    "profileurl": "https://steamcommunity.com/id/lvbyte/",
    "personastate": 1,          // 0 离线 / 1 在线 / 2 忙碌 / 3 离开 ...
    "gameextrainfo": "Counter-Strike 2",   // 正在玩的游戏名（不在游戏里就是空串）
    "gameid": "730"                        // 正在玩的 appid
  },
  "totalCount": 44,
  "totalPlaytimeMinutes": 86160,
  "recentPlaytimeMinutes": 1932,
  "games": [
    { "appid": 730, "name": "Counter-Strike 2", "playtime_forever": 67212, "playtime_2weeks": 1195, "rtime_last_played": 0 }
  ]
}
```

## 为什么需要它

1. **CORS**：`api.steampowered.com` 不返回 `Access-Control-Allow-Origin`，
   浏览器直接 `fetch` 会被拦，静态站点拿不到实时数据。
2. **密钥**：Steam Web API key 是账号凭证，绝不能出现在前端。
3. **缓存**：让静态页面在「打开时就刷新」的同时，不把 Steam 打爆。

## 部署

```bash
npx wrangler deploy
npx wrangler secret put STEAM_API_KEY     # https://steamcommunity.com/dev/apikey
npx wrangler secret put STEAM_ID          # steamID64（17 位）；也可以用 wrangler.toml 的 [vars]
```

绑定自己的域名（**别用 `*.workers.dev`，原因见下面第 1 条**）：
Dashboard → Workers & Pages → `steam-api` → Settings → Domains & Routes → Add → Custom Domain。

验证：

```bash
curl https://steam.你的域名/            # 应返回上面那份 JSON
curl -i "https://steam.你的域名/?debug=1" | grep -i x-steam-cache
```

`ALLOW_ORIGIN` 默认 `*`，上线建议收紧成自己的站点，例如：

```toml
[vars]
ALLOW_ORIGIN = "https://blog.example.com"
```

## 缓存策略

| 上游 | TTL | 原因 |
|---|---|---|
| `GetPlayerSummaries` | 60 秒 | 「正在玩 XXX」要新鲜 |
| `GetRecentlyPlayedGames` | 60 秒 | 同上 |
| `GetOwnedGames` | 6 小时 | 库和总时长变化很慢，且响应最大 |

三级请求合并成一个响应，所以消费端只需要发一次请求。想立刻看到变化就等 TTL 过期，
或在 Dashboard 里清该 Worker 的缓存。

## 踩过的坑（都是实测）

1. **`*.workers.dev` 在国内被 DNS 污染**：解析到 `face:b00c:…` 这类假地址，curl 直接 000。
   所以务必绑自定义域/路由，否则你的国内访客永远拉不到实时数据。
2. **上传脚本时 multipart 的代码段必须带 `filename`**（用 API 部署时会遇到）：
   ```
   Content-Disposition: form-data; name="worker.js"; filename="worker.js"
   ```
   只写 `name="worker.js"` → `10021 Uncaught Error: No such module: worker.js`。
   用 `wrangler deploy` 不会有这个问题。
3. **Cloudflare OAuth 授权（而非 API Token）建不了自定义域**：
   `POST /accounts/{id}/workers/domains` → `10405 Method not allowed for this authentication scheme`。
   替代路线（实测可行）：zone 级 `POST /zones/{zone}/dns_records` 建一条**橙云占位 A 记录**
   （`192.0.2.1`）+ `POST /zones/{zone}/workers/routes` 建路由 `你的域名/*` → 本 Worker，
   泛域名证书会自动套上，效果等价。
4. **本文件全程不含反引号与 `${}`**：有些部署通道（例如把源码内联进某个沙箱执行）无法处理模板字符串，
   用字符串拼接就能让整份源码零转义搬运。改动时请保持这个约定。
5. **Steam 侧**：key 失效/无权限 → 上游 4xx；隐私设置里「游戏详情」不是公开 → `games` 是空数组
   （接口本身仍然 200，别误判成 Worker 坏了）。

## 消费端怎么用

静态站点通常这么组合（以 Hexo 博客为例）：

- **构建时**：用同一个 Steam key 跑一次抓取，把 JSON 快照写进站点数据 → 页面静态渲染（无 JS 也能看、SEO 友好）；
- **打开时**：前端从本 Worker 拉一次实时数据，只更新「正在玩」、时长、最近两周，
  失败就静默保持快照（本 Worker 挂了不影响页面可用性）。

注意两边要过滤同一份「排除清单」（比如 Steamworks、Wallpaper Engine 这类不想展示的 appid）：
Worker 不知道消费端的配置，会把它们一起返回，前端过滤后记得**重算统计数字**，否则实时刷新后
总数/总时长会和静态快照对不上。

## 许可

MIT
