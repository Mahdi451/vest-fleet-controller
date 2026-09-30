# Only the trusted SystemRoot WindowsPowerShell v1.0 powershell.exe should execute this helper.
# The caller provides one JSON request on stdin. Never emit exception details or host paths.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'
try {
    $PSModuleAutoLoadingPreference = 'None'
    $null = Microsoft.PowerShell.Core\Import-Module -Name ($PSHOME + '\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -Force -ErrorAction Stop
    $null = Microsoft.PowerShell.Utility\Add-Type -Path ($PSScriptRoot + '\windows-native.cs') -ErrorAction Stop
    $request = [Console]::In.ReadToEnd() | Microsoft.PowerShell.Utility\ConvertFrom-Json -ErrorAction Stop
    if ($null -eq $request -or $request.operation -isnot [string]) { throw 'rejected' }
    if ($request.operation -ne 'machine' -and $request.path -isnot [string]) { throw 'rejected' }
    if (@('publish', 'writeExclusive', 'removeOwned') -contains $request.operation) {
        if ($request.data -isnot [string]) { throw 'rejected' }
    }
    switch -CaseSensitive ($request.operation) {
        'machine' { $value = [VestWindowsStorage]::Machine() }
        'ensureDirectory' { $value = [VestWindowsStorage]::EnsureDirectory($request.path) }
        'validateDirectory' { $value = [VestWindowsStorage]::ValidateDirectory($request.path) }
        'protectDirectory' { $value = [VestWindowsStorage]::ProtectDirectory($request.path) }
        'readPrivate' { $value = [VestWindowsStorage]::ReadPrivate($request.path) }
        'validateFile' { $value = [VestWindowsStorage]::ValidateFile($request.path) }
        'protectFile' { $value = [VestWindowsStorage]::ProtectFile($request.path) }
        'publish' {
            if ($request.replace -isnot [bool]) { throw 'rejected' }
            $value = [VestWindowsStorage]::Publish($request.path, $request.data, $request.replace)
        }
        'writeExclusive' { $value = [VestWindowsStorage]::WriteExclusive($request.path, $request.data) }
        'removeOwned' { $value = [VestWindowsStorage]::RemoveOwned($request.path, $request.data) }
        default { throw 'rejected' }
    }
    [Console]::Out.WriteLine((@{ ok = $true; value = $value } | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 8 -Compress))
} catch {
    [Console]::Out.WriteLine('{"ok":false,"error":"HOST_STORAGE_REJECTED"}')
    exit 1
}
