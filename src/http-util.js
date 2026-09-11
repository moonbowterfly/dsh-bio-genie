/**
 * dsh-bio-genie — HTTP 响应工具（server.js 与 config_handler.js 共用）。
 *
 * 提取原因（2026-09-11 打磨）：`writeJson` 此前在 `src/server.js` 与
 * `src/config_handler.js` 各有一份**逐字节相同**的实现。因为 server.js 已经
 * import 了 config_handler（拿 handleConfig），让后者反向 import server.js 会
 * 形成循环依赖 —— 这正是当初复制一份的由来。
 *
 * 现在抽出本模块，两边都从这里 import：单一事实源，改响应头只需改一处，
 * 且不引入循环依赖。
 *
 * 信封约定：`{ ok: true, value }` 或 `{ ok: false, code, message }`（见 server.js 头注释）。
 *
 * @module dsh-bio-genie/http-util
 */

/**
 * 以 JSON 回复一个请求（统一 content-type 与 referrer-policy）。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status HTTP 状态码
 * @param {unknown} body 将被 JSON.stringify 的响应体
 */
export function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}
