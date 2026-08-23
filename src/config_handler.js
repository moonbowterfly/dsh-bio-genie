/**
 * dsh-bio-genie — 配置读写端点
 * GET /api/dsh-bio-genie/config → 读取当前配置
 * POST /api/dsh-bio-genie/config → 返回修改说明（实际修改需手动编辑）
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

export async function handleConfig(req, res, config) {
  if (req.method === 'GET') {
    writeJson(res, 200, {
      ok: true,
      value: {
        persistentR: config.persistentR !== false,
        warmUpR: config.warmUpR !== false,
      }
    })
  } else if (req.method === 'POST') {
    const val = req.body && req.body.value
    const key = req.body && req.body.key || 'persistentR'
    
    if (typeof val !== 'boolean') {
      return writeJson(res, 400, { ok: false, error: 'value must be boolean' })
    }
    
    // 返回说明信息（实际修改需手动编辑）
    writeJson(res, 200, {
      ok: true,
      value: {
        key: key,
        current: config[key] !== false,
        requested: val,
        note: '请编辑 ~/.dsh/profiles/web/cordis.patch.yml 添加 ' + key + ': ' + val + ' 到 dsh-bio-genie 配置段，然后重启 dsh'
      }
    })
  }
}
