param(
  [string]$ProjectRoot = (Get-Location).Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path $ProjectRoot).Path

Add-Type -AssemblyName System.Drawing

function New-RoundedRectPath {
  param(
    [System.Drawing.RectangleF]$Rect,
    [float]$Radius
  )

  $diameter = $Radius * 2
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc($Rect.X, $Rect.Y, $diameter, $diameter, 180, 90)
  $path.AddArc($Rect.Right - $diameter, $Rect.Y, $diameter, $diameter, 270, 90)
  $path.AddArc($Rect.Right - $diameter, $Rect.Bottom - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($Rect.X, $Rect.Bottom - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function Draw-Icon {
  param(
    [int]$Size,
    [string]$Destination,
    [ValidateSet("png", "ico")]
    [string]$Format
  )

  $bitmap = New-Object System.Drawing.Bitmap $Size, $Size
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)

  try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)

    $scale = $Size / 1024.0

    $outerRect = [System.Drawing.RectangleF]::new(48 * $scale, 48 * $scale, 928 * $scale, 928 * $scale)
    $innerRect = [System.Drawing.RectangleF]::new(104 * $scale, 104 * $scale, 816 * $scale, 816 * $scale)

    $outerPath = New-RoundedRectPath -Rect $outerRect -Radius (220 * $scale)
    $innerPath = New-RoundedRectPath -Rect $innerRect -Radius (176 * $scale)

    $shadowBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 15, 23, 42))
    $innerBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 30, 41, 59))
    $accentBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 251, 146, 60))
    $glowBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 59, 130, 246))
    $dotBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 248, 250, 252))

    try {
      $graphics.FillPath($shadowBrush, $outerPath)
      $graphics.FillPath($innerBrush, $innerPath)

      foreach ($index in 0..2) {
        $barRect = [System.Drawing.RectangleF]::new(
          214 * $scale,
          (244 + ($index * 154)) * $scale,
          282 * $scale,
          76 * $scale
        )
        $barPath = New-RoundedRectPath -Rect $barRect -Radius (34 * $scale)
        try {
          $graphics.FillPath($accentBrush, $barPath)
        } finally {
          $barPath.Dispose()
        }
      }

      $syncPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 34, 211, 238), [float](78 * $scale))
      $syncPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
      $syncPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

      try {
        $graphics.DrawArc($syncPen, 448 * $scale, 188 * $scale, 336 * $scale, 336 * $scale, 205, 210)
        $graphics.DrawArc($syncPen, 404 * $scale, 454 * $scale, 336 * $scale, 336 * $scale, 25, 210)
      } finally {
        $syncPen.Dispose()
      }

      $arrowUpper = [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new(772 * $scale, 196 * $scale),
        [System.Drawing.PointF]::new(820 * $scale, 256 * $scale),
        [System.Drawing.PointF]::new(736 * $scale, 272 * $scale)
      )
      $arrowLower = [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new(384 * $scale, 790 * $scale),
        [System.Drawing.PointF]::new(316 * $scale, 740 * $scale),
        [System.Drawing.PointF]::new(396 * $scale, 710 * $scale)
      )

      $graphics.FillPolygon($glowBrush, $arrowUpper)
      $graphics.FillPolygon($glowBrush, $arrowLower)
      $graphics.FillEllipse($dotBrush, 520 * $scale, 442 * $scale, 104 * $scale, 104 * $scale)
    } finally {
      $shadowBrush.Dispose()
      $innerBrush.Dispose()
      $accentBrush.Dispose()
      $glowBrush.Dispose()
      $dotBrush.Dispose()
      $outerPath.Dispose()
      $innerPath.Dispose()
    }

    if ($Format -eq "ico") {
      $bitmap.Save($Destination, [System.Drawing.Imaging.ImageFormat]::Icon)
    } else {
      $bitmap.Save($Destination, [System.Drawing.Imaging.ImageFormat]::Png)
    }
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

$assetsDir = Join-Path $ProjectRoot "assets"
$iconsetDir = Join-Path $ProjectRoot "icon.iconset"

New-Item -ItemType Directory -Force -Path $assetsDir | Out-Null
New-Item -ItemType Directory -Force -Path $iconsetDir | Out-Null

Draw-Icon -Size 512 -Destination (Join-Path $assetsDir "icon.png") -Format "png"
Draw-Icon -Size 256 -Destination (Join-Path $assetsDir "icon.ico") -Format "ico"

$iconsetSizes = @{
  "icon_16x16.png" = 16
  "icon_16x16@2x.png" = 32
  "icon_32x32.png" = 32
  "icon_32x32@2x.png" = 64
  "icon_128x128.png" = 128
  "icon_128x128@2x.png" = 256
  "icon_256x256.png" = 256
  "icon_256x256@2x.png" = 512
  "icon_512x512.png" = 512
  "icon_512x512@2x.png" = 1024
}

foreach ($entry in $iconsetSizes.GetEnumerator()) {
  Draw-Icon -Size $entry.Value -Destination (Join-Path $iconsetDir $entry.Key) -Format "png"
}

Write-Host "Generated icon assets in assets/ and icon.iconset/"
