# Generates the PWA icons (dark background + dumbbell). Run once: powershell -File make_icons.ps1
Add-Type -AssemblyName System.Drawing

function New-Icon([int]$size, [string]$path) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.ColorTranslator]::FromHtml('#0D0D0F'))
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#FF7A1A'))
    $s = $size / 512.0
    function Add-Rect($x, $y, $w, $h, $r) {
        $p = New-Object System.Drawing.Drawing2D.GraphicsPath
        $x *= $s; $y *= $s; $w *= $s; $h *= $s; $d = 2 * $r * $s
        $p.AddArc($x, $y, $d, $d, 180, 90); $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
        $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90); $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
        $p.CloseFigure(); $g.FillPath($brush, $p)
    }
    Add-Rect 186 238 140 36 6      # bar
    Add-Rect 120 160 52 192 14     # inner plates
    Add-Rect 340 160 52 192 14
    Add-Rect 66 190 44 132 12      # outer plates
    Add-Rect 402 190 44 132 12
    $g.Dispose(); $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}

$dir = $PSScriptRoot
New-Icon 180 (Join-Path $dir 'apple-touch-icon.png')
New-Icon 192 (Join-Path $dir 'icon-192.png')
New-Icon 512 (Join-Path $dir 'icon-512.png')


