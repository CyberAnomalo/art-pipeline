# 把七个 diorama 的抓图拼成一张总览表，同时逐个做调色板断言。
# 断言：图内（除背景清屏色外）没有任何颜色落在调色板之外。

Add-Type -AssemblyName System.Drawing

$proj = "D:/GithubSoftware/GameDev/ink2godot"
$ids = @("watcher", "burn", "idol", "bench", "stuff", "cabinet", "rehearsal")
$cols = 4
$cellW = 640
$cellH = 360
$labelH = 22
$rows = [math]::Ceiling($ids.Count / $cols)

$sheetW = $cols * $cellW
$sheetH = $rows * ($cellH + $labelH)
$sheet = New-Object System.Drawing.Bitmap($sheetW, $sheetH)
$canvas = [System.Drawing.Graphics]::FromImage($sheet)
$canvas.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$canvas.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
$canvas.Clear([System.Drawing.Color]::FromArgb(18, 20, 26))
$font = New-Object System.Drawing.Font("Consolas", 12)
$brush = [System.Drawing.Brushes]::Gainsboro

$i = 0
$report = @()
foreach ($id in $ids) {
  $png = "$proj/overview_$id.png"
  $json = "$proj/assets/dioramas/$id.ply.json"
  if (-not (Test-Path $png)) { Write-Warning "缺图: $png"; continue }

  $m = Get-Content $json -Raw | ConvertFrom-Json
  $pal = @{}
  foreach ($v in $m.ink.palette) {
    $k = [int]$v
    $pal["$(($k -shr 16) -band 255),$(($k -shr 8) -band 255),$($k -band 255)"] = $true
  }

  $bmp = [System.Drawing.Bitmap]::FromFile($png)
  $hist = @{}
  for ($y = 0; $y -lt $bmp.Height; $y++) {
    for ($x = 0; $x -lt $bmp.Width; $x++) {
      $p = $bmp.GetPixel($x, $y)
      $key = "$($p.R),$($p.G),$($p.B)"
      if ($hist.ContainsKey($key)) { $hist[$key]++ } else { $hist[$key] = 1 }
    }
  }

  # 出现最多的颜色 = 背景清屏色，从断言里排除
  $bg = $null; $max = -1
  foreach ($e in $hist.GetEnumerator()) { if ($e.Value -gt $max) { $max = $e.Value; $bg = $e.Key } }

  $offKinds = 0; $offPixels = 0; $examples = @()
  foreach ($e in $hist.GetEnumerator()) {
    if ($e.Key -eq $bg) { continue }
    if (-not $pal.ContainsKey($e.Key)) {
      $offKinds++; $offPixels += $e.Value
      if ($examples.Count -lt 3) { $examples += "$($e.Key)x$($e.Value)" }
    }
  }

  $col = $i % $cols
  $row = [math]::Floor($i / $cols)
  $dx = $col * $cellW
  $dy = $row * ($cellH + $labelH)
  $canvas.DrawImage($bmp, $dx, $dy + $labelH, $cellW, $cellH)
  $canvas.DrawString("$id  ($($m.count) splats, $($m.ink.palette.Length) 色)", $font, $brush, $dx + 6, $dy + 3)
  $bmp.Dispose()

  $report += [pscustomobject]@{
    scene = $id
    splats = $m.count
    palette = $m.ink.palette.Length
    colors = $hist.Count
    offPalette = $offKinds
    offPixels = $offPixels
    note = if ($offKinds -gt 0) { $examples -join ' ' } else { '' }
  }
  $i++
}

$canvas.Dispose()
$out = "$proj/overview_sheet.png"
$sheet.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$sheet.Dispose()

$report | Format-Table -AutoSize
Write-Host "总览表: $out  ($([math]::Round((Get-Item $out).Length/1KB)) KB)"
