# 把当前工作树打包上传到服务器并热更新（不需要 GitHub 凭据）。
# 用法：pwsh -File tools\deploy.ps1
#       pwsh -File tools\deploy.ps1 -Server 1.2.3.4 -User admin
param(
    [string]$Server = '47.79.243.184',
    [string]$User = 'admin',
    [string]$PublicUrl = 'http://47.79.243.184'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tar = Join-Path $env:TEMP 'tongpin-deploy.tar.gz'
if (Test-Path $tar) { Remove-Item $tar }

function Find-Tool([string]$name) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $fallback = "C:\Program Files\Git\usr\bin\$name.exe"
    if (Test-Path $fallback) { return $fallback }
    throw "找不到 $name，请先安装 Git for Windows 并把它加入 PATH"
}

$ssh = Find-Tool 'ssh'
$scp = Find-Tool 'scp'
$target = "$User@$Server"

Push-Location $root
try {
    & tar.exe --exclude=.git --exclude=web/chart-src/node_modules --exclude=data --exclude=__pycache__ -czf $tar .
} finally {
    Pop-Location
}
Write-Host ("打包完成：{0:N2} MB" -f ((Get-Item $tar).Length / 1MB))

& $scp -o BatchMode=yes -o StrictHostKeyChecking=accept-new $tar "${target}:/tmp/tongpin-deploy.tar.gz"
if ($LASTEXITCODE -ne 0) { throw "上传失败" }

& $ssh -o BatchMode=yes $target 'sudo /usr/local/bin/tongpin-deploy /tmp/tongpin-deploy.tar.gz && rm -f /tmp/tongpin-deploy.tar.gz'
if ($LASTEXITCODE -ne 0) { throw "远端更新失败" }

$health = & curl.exe -s -m 10 "$PublicUrl/api/health"
if ([string]::IsNullOrWhiteSpace($health)) {
    $health = & curl.exe --noproxy '*' -s -m 10 "$PublicUrl/api/health"
}
if ([string]::IsNullOrWhiteSpace($health)) {
    Write-Host "本机 HTTP 检查没返回内容（可能被本地代理拦截），请用浏览器打开 $PublicUrl 确认"
} else {
    Write-Host "健康检查：$health"
}
Write-Host "完成：$PublicUrl"
