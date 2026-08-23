/**
 * dsh-bio-genie — 配置读写端点
 * GET /api/dsh-bio-genie/config → 读取当前配置
 * POST /api/dsh-bio-genie/config → 修改 persistentR 配置
 */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

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
    if (typeof val !== 'boolean') {
      return writeJson(res, 400, { ok: false, error: 'value must be boolean' })
    }
    const patchFile = join(process.env.HOME || process.env.USERPROFILE, '.dsh', 'profiles', 'web', 'cordis.patch.yml')
    try {
      let yaml = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
      if (yaml.includes('persistentR:')) {
        yaml = yaml.replace(/persistentR:\s*(true|false)/, 'persistentR: ' + val)
      } else {
        yaml += '\nplugins:\n  dsh-bio-genie:\n    persistentR: ' + val
      }
      writeFileSync(patchFile, yaml, 'utf8')
      writeJson(res, 200, { ok: true, value: { persistentR: val, note: '请重启 dsh 使配置生效' } })
    } catch (err) {
      writeJson(res, 500, { ok: false, error: err.message })
    }
  }
}
