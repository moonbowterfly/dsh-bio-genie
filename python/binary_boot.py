"""外部工具二进制自举（批次 D）。

原则（对齐插件「零手动安装」）：
  - 优先使用系统 PATH 中已有的同名二进制；没有时自动从官方源获取
  - 官方源下载 → sha256 固定校验 → 解压到插件私有目录 → 运行冒烟
  - fail-closed：校验不符 / 无法运行 → 明确报错（绝不静默降级）

私有目录：$DSH_HOME/dsh-bio-genie/bin/<name>-<version>/（DSH_HOME 默认 ~/.dsh）

安全细节：zip 解压使用 filter='data'（防路径穿越）；下载为「直连优先 →
系统/环境代理回退」（不写死任何本机代理地址，保持通用性）。
"""
import hashlib
import os
import shutil
import subprocess
import sys
import zipfile


def _dsh_home():
    return os.environ.get('DSH_HOME') or os.path.join(os.path.expanduser('~'), '.dsh')


def _bin_root():
    return os.path.join(_dsh_home(), 'dsh-bio-genie', 'bin')


# 官方资产 pin 表（URL + sha256 均为实测核验值）
BINARIES = {
    'trimal': {
        'version': '1.5.0',
        'url': 'https://github.com/inab/trimal/releases/download/v1.5.0/trimAl_Windows_x86-64.zip',
        'sha256': 'a844600e369aa587ea3be6e45ecd239e3d8cde97bd96a2738425482be4f79055',
        'exe': 'trimAl_Windows_x86-64/trimal.exe',
        'version_args': ['--version'],
        'note': '固定 v1.5.0：v1.5.1 的官方 Windows 构建在部分环境无法启动（0xC0000139）',
    },
    'iqtree2': {
        'version': '2.4.0',
        'url': 'https://github.com/iqtree/iqtree2/releases/download/v2.4.0/iqtree-2.4.0-Windows.zip',
        'sha256': '93f488a6cfef96ef664b23fefe5be97c2c80ebcae9cd2031c0cac92b467278be',
        'exe': 'iqtree-2.4.0-Windows/bin/iqtree2.exe',
        'version_args': ['--version'],
        'note': '上游 release 无 digest——sha256 为本机实测核验值',
    },
}


def _fetch(url, connect_timeout=15, total_timeout=600):
    """下载：直连（跳过代理）优先 → 默认 opener（环境/系统代理）回退。"""
    import urllib.request

    errors = []
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(url, timeout=connect_timeout) as resp:
            return resp.read()
    except Exception as e:
        errors.append('direct: %s' % str(e)[:120])
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'dsh-bio-genie/'})
        with urllib.request.urlopen(req, timeout=total_timeout) as resp:
            return resp.read()
    except Exception as e:
        errors.append('proxy: %s' % str(e)[:120])
    raise RuntimeError('下载失败（直连与代理均不可用）：%s' % ' | '.join(errors))


def _sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def _smoke(exe, version_args, timeout=30):
    """运行冒烟：返回 (ok, 输出摘要)。"""
    try:
        r = subprocess.run([exe] + list(version_args), capture_output=True, timeout=timeout)
    except Exception as e:
        return False, 'run failed: %s' % str(e)[:150]
    out = ((r.stdout or b'') + (r.stderr or b'')).decode('utf-8', errors='replace')
    return (r.returncode == 0), 'rc=%d %s' % (r.returncode, out.strip()[:200])


def _locate_exe(dest, rel):
    """弹性定位解压出的可执行文件（不同 release 的 zip 内部布局不同）。"""
    direct = os.path.join(dest, rel)
    if os.path.isfile(direct):
        return direct
    base = os.path.basename(rel)
    for root, _dirs, files in os.walk(dest):
        if base in files:
            return os.path.join(root, base)
    return None


def ensure_binary(name, allow_system=True):
    """确保二进制可用。返回 {path, source, version, smoke}。

    source = 'system'（PATH 命中）或 'bootstrapped'（私有自举）。
    """
    spec = BINARIES.get(name)
    if spec is None:
        raise ValueError('未知的二进制 %s（可用：%s）' % (name, ', '.join(BINARIES)))

    # 1) 系统 PATH
    if allow_system:
        sys_exe = shutil.which(name)
        if sys_exe:
            ok, detail = _smoke(sys_exe, spec['version_args'])
            return {'path': sys_exe, 'source': 'system', 'version': 'unknown (system PATH)',
                    'smoke_ok': ok, 'smoke': detail}

    # 2) 私有自举
    if sys.platform != 'win32':
        # 非 Windows：上游资产为 Windows 构建；请使用系统包管理器安装
        raise RuntimeError('本机无 %s 且当前平台非 Windows：请从官方源安装（资产为 Windows 构建）' % name)

    dest = os.path.join(_bin_root(), '%s-%s' % (name, spec['version']))
    exe_path = _locate_exe(dest, spec['exe']) if os.path.isdir(dest) else None
    if exe_path:
        ok, detail = _smoke(exe_path, spec['version_args'])
        if ok:
            return {'path': exe_path, 'source': 'bootstrapped', 'version': spec['version'],
                    'smoke_ok': True, 'smoke': detail}
        # 已装副本坏 → 重装
        shutil.rmtree(dest, ignore_errors=True)

    # 3) 下载 + 校验 + 解压 + 冒烟
    data = _fetch(spec['url'])
    got = _sha256_bytes(data)
    if got != spec['sha256']:
        raise RuntimeError('下载校验失败：%s 期望 sha256=%s，实际=%s（文件已丢弃）'
                           % (name, spec['sha256'][:16] + '…', got[:16] + '…'))
    os.makedirs(dest, exist_ok=True)
    zip_path = os.path.join(dest, '_download.zip')
    try:
        with open(zip_path, 'wb') as fh:
            fh.write(data)
        with zipfile.ZipFile(zip_path) as zf:
            # 手动安全解压（zip-slip 防护；不依赖版本的 filter 参数）
            for info in zf.infolist():
                rel = info.filename.replace('\\', '/')
                parts = [p for p in rel.split('/') if p and p != '.']
                if rel.startswith('/') or '..' in parts:
                    raise RuntimeError('zip 含非法路径条目（疑似路径穿越）：%s' % info.filename)
                zf.extract(info, dest)
    finally:
        try:
            os.remove(zip_path)
        except OSError:
            pass
    exe_path = _locate_exe(dest, spec['exe'])
    if not exe_path:
        raise RuntimeError('解压后未找到预期可执行文件（已搜索 %s）：%s' % (dest, spec['exe']))

    ok, detail = _smoke(exe_path, spec['version_args'])
    if not ok:
        raise RuntimeError('下载与校验通过但无法运行（%s）：%s\n（已保留于 %s，供诊断）'
                           % (name, detail, dest))
    return {'path': exe_path, 'source': 'bootstrapped', 'version': spec['version'],
            'smoke_ok': True, 'smoke': detail}


def binary_status():
    """当前各二进制的状态（只读诊断）。"""
    out = []
    for name, spec in BINARIES.items():
        sys_exe = shutil.which(name)
        dest = os.path.join(_bin_root(), '%s-%s' % (name, spec['version']))
        boot = _locate_exe(dest, spec['exe']) if os.path.isdir(dest) else None
        out.append({
            'name': name,
            'pinned_version': spec['version'],
            'system_path': sys_exe or None,
            'bootstrapped': boot is not None,
            'bootstrapped_path': boot,
        })
    return out
