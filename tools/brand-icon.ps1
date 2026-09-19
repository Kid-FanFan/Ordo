# Brand icon resize + rounded-corner mask: param(src, out, size, radiusRatio)
# High-quality bicubic downscale to size x size, then fill a rounded-rect path
# (TextureBrush) so the outside becomes transparent with anti-aliased edges.
# ASCII-only on purpose: Windows PowerShell reads BOM-less files as ANSI.
param(
  [Parameter(Mandatory = $true)][string]$src,
  [Parameter(Mandatory = $true)][string]$out,
  [Parameter(Mandatory = $true)][int]$size,
  [double]$radiusRatio = 0.2
)
Add-Type -AssemblyName System.Drawing
$srcBmp = New-Object System.Drawing.Bitmap($src)
$r = [int]([Math]::Round($size * $radiusRatio))
$d = $size - 1

# 1) bicubic resize into a temp bitmap
$tmp = [System.Drawing.Bitmap]::new($size, $size)
$g = [System.Drawing.Graphics]::FromImage($tmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawImage($srcBmp, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)))
$g.Dispose()
$srcBmp.Dispose()

# 2) rounded-corner mask fill (TextureBrush keeps pixel alignment)
$outBmp = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($outBmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90)
$path.AddArc($d - 2 * $r, 0, 2 * $r, 2 * $r, 270, 90)
$path.AddArc($d - 2 * $r, $d - 2 * $r, 2 * $r, 2 * $r, 0, 90)
$path.AddArc(0, $d - 2 * $r, 2 * $r, 2 * $r, 90, 90)
$path.CloseFigure()
$brush = New-Object System.Drawing.TextureBrush($tmp)
$brush.WrapMode = [System.Drawing.Drawing2D.WrapMode]::Clamp
$g.Clear([System.Drawing.Color]::Transparent)
$g.FillPath($brush, $path)
$g.Dispose()

$outBmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$outBmp.Dispose(); $tmp.Dispose(); $brush.Dispose(); $path.Dispose()
Write-Host "icon-src: $out ($size x $size r=$r)"
