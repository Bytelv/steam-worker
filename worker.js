/**
 * Steam 游戏库实时代理（Cloudflare Worker）
 * ---------------------------------------------------------------------------
 * 为什么需要它：Steam Web API 不带 CORS 头，浏览器直接 fetch 会被拦；
 * 而且 API key 绝不能出现在前端。所以用这个 Worker 代持 key 并加 CORS。
 *
 * 路由：
 *   GET /            返回 { player, games, totalCount, totalPlaytimeMinutes, recentPlaytimeMinutes, fetchedAt }
 *   GET /?debug=1    额外返回上游状态与缓存命中情况（不带 key）
 *
 * 缓存（Cache API，按 URL 缓存上游 JSON）：
 *   player + recent  60 秒   —— 「正在玩」这类状态要新鲜
 *   owned games      6 小时  —— 游戏库和总时长变化很慢，别把 Steam 打爆
 * 两级缓存合并成一个响应，所以客户端只需要一次请求。
 *
 * 环境变量（Worker 设置里配，不要写进仓库）：
 *   STEAM_API_KEY    必填，https://steamcommunity.com/dev/apikey
 *   STEAM_ID         必填，steamID64（17 位）
 *   ALLOW_ORIGIN     选填，允许的来源，默认 '*'；建议改成 https://blog.lvbyte.top
 */

const API = 'https://api.steampowered.com';
const TTL_RECENT = 60;
const TTL_LIBRARY = 6 * 3600;

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400'
  };
}

function json(body, status, env, extra) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60'
    }, cors(env), extra || {})
  });
}

async function steam(pathname, params) {
  const url = new URL(API + pathname);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { cf: { cacheTtl: 0 } });
  const text = await res.text();
  if (!res.ok) throw new Error(pathname + ' HTTP ' + res.status + ': ' + text.slice(0, 160));
  return JSON.parse(text);
}

/** 带 Cache API 的上游请求：命中就直接返回，未命中写入缓存 */
async function cached(pathname, params, ttl, cacheKey) {
  const cache = caches.default;
  const key = new Request('https://steam-cache.internal/' + cacheKey);
  const hit = await cache.match(key);
  if (hit) return { data: await hit.json(), cached: true };
  const data = await steam(pathname, params);
  const res = new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + ttl }
  });
  await cache.put(key, res);
  return { data, cached: false };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405, env);

    const key = env.STEAM_API_KEY;
    const steamid = env.STEAM_ID;
    if (!key || !steamid) {
      return json({
        error: 'worker 未配置 STEAM_API_KEY / STEAM_ID',
        hint: 'wrangler secret put STEAM_API_KEY；STEAM_ID 可放 vars 或 secret'
      }, 500, env);
    }

    try {
      const [player, recent, owned] = await Promise.all([
        cached('/ISteamUser/GetPlayerSummaries/v2/', { key, steamids: steamid }, TTL_RECENT, 'player'),
        cached('/IPlayerService/GetRecentlyPlayedGames/v1/', { key, steamid, count: 0 }, TTL_RECENT, 'recent'),
        cached('/IPlayerService/GetOwnedGames/v1/', {
          key, steamid, include_appinfo: 1, include_played_free_games: 1, format: 'json'
        }, TTL_LIBRARY, 'owned')
      ]);

      const p = ((player.data.response && player.data.response.players) || [])[0] || {};
      const games = (((owned.data.response && owned.data.response.games) || [])).slice();
      const recentMap = new Map(
        (((recent.data.response && recent.data.response.games) || [])).map(g => [g.appid, g.playtime_2weeks || 0])
      );
      games.forEach(g => {
        if (!g.playtime_2weeks && recentMap.has(g.appid)) g.playtime_2weeks = recentMap.get(g.appid);
      });
      games.sort((a, b) => (b.playtime_forever || 0) - (a.playtime_forever || 0));

      const body = {
        fetchedAt: new Date().toISOString(),
        player: {
          steamid: p.steamid || steamid,
          personaname: p.personaname || '',
          avatar: p.avatarfull || p.avatarmedium || '',
          profileurl: p.profileurl || '',
          personastate: typeof p.personastate === 'number' ? p.personastate : 0,
          gameextrainfo: p.gameextrainfo || '',
          gameid: p.gameid || ''
        },
        totalCount: games.length,
        totalPlaytimeMinutes: games.reduce((s, g) => s + (g.playtime_forever || 0), 0),
        recentPlaytimeMinutes: games.reduce((s, g) => s + (g.playtime_2weeks || 0), 0),
        games: games.map(g => ({
          appid: g.appid,
          name: g.name || ('App ' + g.appid),
          playtime_forever: g.playtime_forever || 0,
          playtime_2weeks: g.playtime_2weeks || 0,
          rtime_last_played: g.rtime_last_played || 0
        }))
      };

      const extra = {};
      if (new URL(request.url).searchParams.get('debug') === '1') {
        const hit = c => (c ? 'hit' : 'miss');
        extra['X-Steam-Cache'] = 'player=' + hit(player.cached) + ' recent=' + hit(recent.cached) + ' owned=' + hit(owned.cached);
      }
      return json(body, 200, env, extra);
    } catch (error) {
      return json({ error: String(error.message || error) }, 502, env);
    }
  }
};
