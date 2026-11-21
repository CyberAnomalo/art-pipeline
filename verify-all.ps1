# 一次性跑完全部 VFX 场景的等价性验证（约 46 万 splat）。
# 每个场景单独起一个 node 进程，因为 test-vfx-math.js 一次只吃一个场景。
#
#   ./verify-all.ps1              # 全部六个
#   ./verify-all.ps1 motion-cadence.js
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$scenes = if ($args.Count) { $args } else {
  @('lantern-squall.js', 'motion-cadence.js', 'windbreak.js',
    'art-effects.js', 'sheltered-arch.js', 'weather-courtyard.js')
}

$failed = @()
$total = 0
foreach ($s in $scenes) {
  $out = (node test-vfx-math.js $s 2>&1 | Out-String)
  $code = $LASTEXITCODE
  $splats = if ($out -match '(\d+) splat') { [int]$Matches[1] } else { 0 }
  $total += $splats
  if ($code -ne 0) { $failed += $s }
  $mark = if ($code -eq 0) { 'OK  ' } else { 'FAIL' }
  $worst = if ($out -match '协方差最大相对误差: (\S+)') { $Matches[1] } else { '?' }
  '  [{0}] {1,-26} {2,7} splat   协方差误差 {3}' -f $mark, $s, $splats, $worst
}

''
'合计 {0} splat / {1} 个场景' -f $total, $scenes.Count
if ($failed.Count) {
  '失败: ' + ($failed -join ', ')
  exit 1
}
'全部一致（误差必须为 0.000e+0）'
